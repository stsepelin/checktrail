"""Single encrypted private Tree capture; no signing, ACK, feed or plaintext upload."""
import argparse,gzip,hashlib,importlib.util,io,json,os,pwd,re,shutil,stat,sys,tarfile,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('tree_encrypted_controller',HERE/'native-controller.py');C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
sys.path.insert(0,str(HERE/'reused-sdk-crypto'))
from crypto_bridge import operation
from common import encoded,digest,hash_file,deadline_receipt,replace_json
MAX_PACK=516*1024**2

def need(v,m):
 if not v:raise ValueError(m)

class Sink:
 def __init__(self,stream,maximum):self.stream=stream;self.maximum=maximum;self.count=0
 def write(self,body):
  need(self.count+len(body)<=self.maximum,'Private archive byte ceiling');n=self.stream.write(body);need(n==len(body),'Full private archive write');self.count+=n;return n
 def flush(self):self.stream.flush()

def scan(root,deadline):
 rows=[];total=0
 for folder,dirs,files in os.walk(root,followlinks=False):
  for name in dirs+files:
   p=Path(folder)/name;s=p.lstat();need(not p.is_symlink() and (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode) and s.st_nlink==1),'Physical nonlinked private capture required')
   if p.is_dir():continue
   n,h=hash_file(p,deadline=deadline);total+=n;need(total<=C.CAPTURE_BYTES and len(rows)<512,'Private capture byte/member ceiling');rows.append({'path':p.relative_to(root).as_posix(),'bytes':n,'sha256':h,'device':s.st_dev,'inode':s.st_ino,'mtimeNs':s.st_mtime_ns,'ctimeNs':s.st_ctime_ns})
 return sorted(rows,key=lambda r:r['path'])

def pack(root,out,deadline):
 need(root==root.resolve(strict=True) and not os.path.lexists(out),'Fresh physical private pack required');rows=scan(root,deadline);member_map=[{k:r[k] for k in ('path','bytes','sha256')} for r in rows];raw=encoded(member_map)
 with out.open('xb') as stream:
  sink=Sink(stream,MAX_PACK)
  with gzip.GzipFile(filename='',fileobj=sink,mode='wb',mtime=0,compresslevel=6) as gz:
   with tarfile.open(fileobj=gz,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
    for row in rows:
     need(time.monotonic()<deadline,'Private pack deadline');p=root/row['path'];now=p.lstat();need((now.st_dev,now.st_ino,now.st_size,now.st_mtime_ns,now.st_ctime_ns)==(row['device'],row['inode'],row['bytes'],row['mtimeNs'],row['ctimeNs']),'Private capture endpoint changed');info=tarfile.TarInfo(row['path']);info.size=row['bytes'];info.mode=0o444
     with p.open('rb') as source:archive.addfile(info,source)
    info=tarfile.TarInfo('INTERNAL-MEMBER-MAP.json');info.size=len(raw);info.mode=0o444;archive.addfile(info,io.BytesIO(raw))
  stream.flush();os.fsync(stream.fileno())
 need(scan(root,deadline)==rows,'Private capture changed during pack');out.chmod(0o444);n,h=hash_file(out,deadline=deadline);need(n<=MAX_PACK and time.monotonic()<deadline,'Private pack final deadline/size');return {'bytes':n,'sha256':h,'internalMemberMapSHA256':digest(raw)}

def unpack_authenticated(archive,out,plain,authentication,deadline):
 need(authentication.get('authenticated') is True and authentication.get('bytes')==plain['bytes'] and authentication.get('sha256')==plain['sha256'],'Authenticated decrypt receipt required before parsing')
 n,h=hash_file(archive,deadline=deadline);need(n==plain['bytes'] and h==plain['sha256'],'Authenticated plaintext archive differs');need(not os.path.lexists(out),'Fresh recovered capture required');rows=[];total=0
 with tarfile.open(archive,'r:gz') as opened:
  for info in opened:
   name=info.name;need(name and not name.startswith('/') and all(p not in ('','.','..') for p in name.split('/')) and '\\' not in name and info.isfile() and not info.issparse(),'Recovered private member refused');need(name not in {r['path'] for r in rows} and len(rows)<513,'Private archive duplicate/member ceiling');total+=info.size;need(total<=C.CAPTURE_BYTES+1024**2 and info.size<=C.CAPTURE_BYTES,'Recovered private member byte ceiling');rows.append({'path':name,'bytes':info.size})
  member=opened.getmember('INTERNAL-MEMBER-MAP.json');need(member.size<=1024**2,'Private member map ceiling');raw=opened.extractfile(member).read();need(digest(raw)==plain['internalMemberMapSHA256'],'Authenticated internal member map differs');mapping=json.loads(raw);need({r['path']:r['bytes'] for r in mapping}=={r['path']:r['bytes'] for r in rows if r['path']!='INTERNAL-MEMBER-MAP.json'} and len(mapping)==len(rows)-1,'Complete private member map differs')
  names={r['path'] for r in rows}
  for name in names:need(not any(str(parent) in names for parent in Path(name).parents if str(parent)!='.'),'Recovered file/directory prefix collision')
  out.mkdir(mode=0o700)
  for row in mapping:
   need(time.monotonic()<deadline,'Authenticated extraction deadline');p=out/row['path'];p.parent.mkdir(mode=0o700,parents=True,exist_ok=True);source=opened.extractfile(row['path']);h=hashlib.sha256();remaining=row['bytes']
   with p.open('xb') as sink:
    while remaining:
     body=source.read(min(65536,remaining));need(body,'Short private recovered member');sink.write(body);h.update(body);remaining-=len(body)
   need(h.hexdigest()==row['sha256'],'Recovered original private member hash differs');p.chmod(0o400)
 return {'complete':True,'members':len(mapping),'bytes':total,'plaintextParsedOnlyAfterGCMAuthentication':True}

def finalize_upload(upload,context,n,h,deadline,started):
 ready=deadline_receipt(upload/'READY.json',{'encryptedCaptureReady':True,'context':context,'bytes':n,'sha256':h,'plaintextUploaded':False},deadline,{'encryptedCaptureReady':False},started)
 for file in upload.iterdir():file.chmod(0o444)
 if time.monotonic()>=deadline and ready['encryptedCaptureReady']:
  ready.update(encryptedCaptureReady=False,completionBudgetExhausted=True);replace_json(upload/'READY.json',ready);(upload/'READY.json').chmod(0o444)
 return ready

def inner(request):
 request=Path(request);need(request==request.resolve(strict=True) and request.stat().st_uid==0 and request.stat().st_size<=131072,'Root-bound crypto request required');value=json.loads(request.read_bytes());need(set(value)=={'folder','request'},'Exact crypto request fields');need(os.getuid()!=0,'Crypto utility executes under distinct nonroot UID');return operation(Path(value['folder']),'encrypt',value['request'],time.monotonic()+300)

def capture(work,env,nonce):
 started=time.monotonic();deadline=started+420;C.owned_marker(work,env);need(env['GITHUB_RUN_ATTEMPT']=='1' and re.fullmatch('[a-z0-9-]{8,40}',nonce),'Exact first-attempt encryption nonce');C.stage_capture(work,env)
 private=work/'encrypted-private';private.mkdir(mode=0o755);private.chmod(0o755);payload=private/'capture.tar.gz';plain=pack(work/'capture',payload,deadline);account=pwd.getpwnam('nobody');node=shutil.which('node',path='/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');need(node is not None,'Stock host Node crypto utility unavailable; plaintext is never uploaded');node_meta=C.N.physical_file(node);python=C.N.physical_file('/usr/bin/python3');utility=private/'utility';utility.mkdir();C.N.owned_directory(utility/'capture');host={'buildUid':account.pw_uid,'buildUser':'nobody'};native=C.N.Native(utility,host)
 writable=private/'operation';writable.mkdir();os.chown(writable,account.pw_uid,account.pw_gid);writable.chmod(0o700)
 identity={'uid':account.pw_uid,'gid':account.pw_gid,'groups':sorted(set(C.A.group_id(x) for x in C.N.quick(['/usr/bin/id','-G','nobody']).split()))};request=work/'control/crypto-permission.json';request.write_bytes(b'{}');request.chmod(0o444);bounds=C.A.Bounds(seconds=120,read_bytes=4*1024**3);frame=C.A.snapshot([Path(node_meta['path']),Path(python['path']),HERE,payload],bounds);value={'frame':frame,'controller':{'file':str(work/'control/admit.py'),'sha256':C.M.digest(work/'control/admit.py'),'uid':int(env['CHECKTRAIL_CONTROLLER_UID'])},'identity':identity};request.write_bytes(C.A.encoded(value));clean={'PATH':str(Path(node_meta['path']).parent)+':/usr/bin:/bin','HOME':str(writable),'TMPDIR':str(writable)}
 proof=native.run('crypto-physical-permissions',[python['path'],'-I','-S','-B',str(work/'control/admit.py'),'--inner',str(request)],clean,private,120);checked=json.loads(Path(proof['log']['path']).read_bytes());need(checked['allSelectedEntriesReadableExecutableAndProtected'] is True and checked['metadataEndpointSha256']==C.A.digest(C.A.encoded(C.A.current_endpoint(frame))),'Stock crypto utility/first-party/pack permissions refused')
 context={'run':int(env['GITHUB_RUN_ID']),'head':env['GITHUB_SHA'],'attempt':1,'nonce':nonce};recipient=json.loads((HERE/'recipient-public.json').read_bytes());target=writable/'capture.ctenc';op_request={'source':str(payload),'out':str(target),'seconds':min(300,deadline-time.monotonic()),'plaintext':plain,'context':context,'publicJWK':recipient};file=work/'control/crypto-operation.json';C.atomic(file,{'folder':str(writable/'evidence'),'request':op_request});record=native.run('private-capture-envelope',[python['path'],'-I','-S','-B',str(HERE/'encrypted-capture.py'),'--inner',str(file)],clean,private,300);body=Path(record['log']['path']).read_bytes();need(len(body)<=131072,'Bounded encrypted capture metadata');envelope=json.loads(body);n,h=hash_file(target,deadline=deadline);need(envelope['bytes']==n<=MAX_PACK+65536 and envelope['sha256']==h and envelope['context']==context and envelope['plaintext']==plain and envelope['publicRecipientJWK']==recipient and time.monotonic()<deadline,'Bound encrypted capture identity/deadline differs');need(not target.is_symlink() and target.stat().st_uid==account.pw_uid and target.stat().st_nlink==1,'Owned cipher result required');C.owned_marker(work,env)
 upload=work/'encrypted-upload';upload.mkdir();shutil.copyfile(target,upload/'capture.ctenc');(upload/'capture.ctenc').chmod(0o444);C.atomic(upload/'ENVELOPE.json',envelope);C.atomic(upload/'PUBLIC-HASHES.json',{'run':context['run'],'head':context['head'],'attempt':1,'nonce':nonce,'ciphertextBytes':n,'ciphertextSHA256':h,'plaintextArchiveSHA256':plain['sha256'],'internalMemberMapSHA256':plain['internalMemberMapSHA256'],'stockNodeUtilitySHA256':node_meta['sha256'],'publicRecipientSHA256':digest(encoded(recipient)),'privateOriginalOutputOrLogBodiesEmitted':False,'sourceBuildSDKLegalOrGateAClosureClaimed':False});upload.chmod(0o755);need(sum(p.stat().st_size for p in upload.iterdir())<=MAX_PACK+1024**2,'Encrypted upload total bound');return finalize_upload(upload,context,n,h,deadline,started)
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--inner');p.add_argument('--work');p.add_argument('--nonce');a=p.parse_args()
 if a.inner:need(not a.work and not a.nonce,'Inner crypto arguments');print(json.dumps(inner(a.inner)))
 else:need(a.work and a.nonce,'Reviewed private capture arguments required');print(json.dumps(capture(Path(a.work),dict(os.environ),a.nonce)))
