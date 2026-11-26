"""First-pass metadata/notice index of four retained Rust archives; never extracts code or links."""
import argparse,hashlib,json,lzma,os,posixpath,re,stat,sys,tarfile,time
from pathlib import Path
HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
from common import deadline_receipt,encoded,freeze,need,syncdir
DECODED=8*1024**3;INDEX=256*1024**2;META=128*1024**2;NOTICES=256*1024**2;PHYSICAL=768*1024**2;MEMBERS=500000;SECONDS=1800;CHUNK=65536
# A caller that already holds the pinned policy bytes sets POLICY_BYTES in this
# module's namespace before running it, so POLICY.json is not read a second time.
METADATA=set(json.loads(POLICY_BYTES if 'POLICY_BYTES' in globals() else (HERE/'POLICY.json').read_bytes())['sourceMetadataPaths'])
BASES=['license','licenses','copying','copyright','notice','notices','authors','unlicense','third_party_notices','third-party-notices','thirdpartynotices']
CODE_SUFFIXES={'.rs','.py','.c','.h','.cc','.cpp','.js','.mjs','.ts','.go','.sh','.rb','.java','.swift','.cs'}

def private_sink(path):
 # Owner-only from the creating syscall; these files are made read-only, never narrowed from readable.
 return os.fdopen(os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600),'wb')

def hash_file(path):
 h=hashlib.sha256();n=0
 with path.open('rb') as f:
  for body in iter(lambda:f.read(CHUNK),b''):n+=len(body);h.update(body)
 return n,h.hexdigest()
class Budget:
 def __init__(self,deadline):self.deadline=deadline;self.decoded=0;self.metadata=0;self.notices=0;self.declarations=0;self.members=0
 def check(self):need(time.monotonic()<self.deadline,'Whole inventory deadline')
 def take(self,field,n,maximum):self.check();value=getattr(self,field)+n;need(value<=maximum,'Inventory '+field+' byte/member ceiling');setattr(self,field,value)
class Physical:
 def __init__(self):self.reserved=65536
 def reserve(self,n):need(n>=0 and self.reserved+n<=PHYSICAL,'Whole private file-byte reservation ceiling');self.reserved+=n
 def release(self,n):need(0<=n<=self.reserved-65536,'Valid duplicate temporary reservation release');self.reserved-=n
class XZ:
 def __init__(self,path,budget):self.file=path.open('rb');self.budget=budget;self.decoder=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=256*1024**2);self.pending=b'';self.streams=1;self.padding=0;self.done=False
 def close(self):self.file.close()
 def read(self,n):
  need(0<=n<=CHUNK,'Bounded decoded read required');out=bytearray()
  while len(out)<n and not self.done:
   self.budget.check()
   if self.decoder.eof:
    data=self.decoder.unused_data or self.pending or self.file.read(CHUNK);self.pending=b'';self.decoder=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=256*1024**2)
    while data and data[0]==0:
     count=len(data)-len(data.lstrip(b'\0'));self.padding+=count;need(self.padding<=65536,'XZ padding ceiling');data=data[count:]
     if not data:data=self.file.read(CHUNK)
    need(self.padding%4==0,'XZ stream padding alignment')
    if not data:self.done=True;break
    self.streams+=1;need(self.streams<=16,'XZ stream count ceiling');self.pending=data
   data=self.pending if self.pending else self.file.read(CHUNK) if self.decoder.needs_input else b'';self.pending=b''
   need(data or not self.decoder.needs_input,'Truncated XZ stream');body=self.decoder.decompress(data,max_length=n-len(out));self.budget.take('decoded',len(body),DECODED);out.extend(body)
  return bytes(out)

def exact(source,n):
 need(0<=n<=CHUNK,'Bounded exact read');body=bytearray()
 while len(body)<n:
  part=source.read(n-len(body));need(part,'Truncated TAR payload/header');body.extend(part)
 return bytes(body)
def extent(source,n):
 while n:
  body=exact(source,min(CHUNK,n));yield body;n-=len(body)
def skip_pad(source,n):
 if n%512:need(not any(exact(source,512-n%512)),'TAR payload padding must be zero')
def pax(body):
 rows={};i=0
 while i<len(body):
  space=body.find(b' ',i);need(i<space<i+12 and body[i:space].isdigit(),'PAX length framing');n=int(body[i:space]);need(n>space-i+3 and i+n<=len(body) and body[i+n-1:i+n]==b'\n','Bounded complete PAX record');pair=body[space+1:i+n-1].split(b'=',1);need(len(pair)==2 and 0<len(pair[0])<=256 and len(pair[1])<=2048,'PAX key/value bounds');key=pair[0].decode('utf8');value=pair[1].decode('utf8');need(key not in rows and not key.startswith('GNU.sparse') and key not in ['SCHILY.realsize','GNU.dumpdir'],'PAX duplicate/sparse layout refused');rows[key]=value;i+=n
 return rows

def entries(source,budget):
 global_pax={};local={};long_name=None;long_link=None;extensions=0
 while True:
  header=exact(source,512)
  if not any(header):
   need(not any(exact(source,512)),'Complete two-block TAR terminator');padding=1024
   while True:
    body=source.read(CHUNK)
    if not body:break
    padding+=len(body);need(padding<=65536 and not any(body),'Bounded zero-only TAR trailer')
   need(not local and long_name is None and long_link is None,'Dangling TAR extension');return
  item=tarfile.TarInfo.frombuf(header,'utf8','strict');size=item.size;need(0<=size<=4*1024**3,'Original member size ceiling')
  if item.type in [tarfile.XHDTYPE,tarfile.XGLTYPE,tarfile.GNUTYPE_LONGNAME,tarfile.GNUTYPE_LONGLINK]:
   extensions+=1;need(extensions<=MEMBERS and size<=65536,'Bounded TAR extension before allocation');body=b''.join(extent(source,size));skip_pad(source,size)
   if item.type==tarfile.XHDTYPE:local.update(pax(body));need(sum(len(k)+len(v) for k,v in local.items())<=65536,'Local PAX metadata ceiling')
   elif item.type==tarfile.XGLTYPE:global_pax.update(pax(body));need(sum(len(k)+len(v) for k,v in global_pax.items())<=65536,'Global PAX metadata ceiling')
   else:
    need(body.endswith(b'\0') and len(body.rstrip(b'\0'))<=2048,'Bounded GNU name/link payload');value=body.rstrip(b'\0').decode('utf8')
    if item.type==tarfile.GNUTYPE_LONGNAME:need(long_name is None,'Duplicate pending GNU name');long_name=value
    else:need(long_link is None,'Duplicate pending GNU link');long_link=value
   continue
  attrs={**global_pax,**local};name=attrs.get('path',long_name if long_name is not None else item.name);link=attrs.get('linkpath',long_link if long_link is not None else item.linkname)
  if 'size' in attrs:need(re.fullmatch('[0-9]{1,20}',attrs['size']),'PAX decimal size');size=int(attrs['size']);need(size<=4*1024**3,'PAX member size ceiling')
  need(len(name.encode())<=2048 and len(link.encode())<=2048,'Member name/link ceiling');need(item.type in [tarfile.REGTYPE,tarfile.AREGTYPE,tarfile.DIRTYPE,tarfile.SYMTYPE,tarfile.LNKTYPE],'Only inert regular/directory/link metadata');need(item.isreg() or size==0,'Nonregular member payload refused');budget.take('members',1,MEMBERS);local={};long_name=None;long_link=None
  yield item,name,link,size
  skip_pad(source,size)

def path_record(name,prefix,is_directory):
 raw=name
 if name.startswith('./'):name=name[2:]
 if is_directory:name=name.rstrip('/')
 need(name and not name.startswith('/') and '\\' not in name and all(x not in ('','.','..') for x in name.split('/')),'Canonical inert member path');need(name==prefix or name.startswith(prefix+'/'),'Exact original archive prefix');return raw,name,name[len(prefix):].lstrip('/')
def roles(relative):
 name=relative.rsplit('/',1)[-1];lower=name.lower();metadata=name in ['version','git-commit-hash','git-commit-info','builder-config','components','manifest.in','Cargo.toml','Cargo.toml.orig','Cargo.lock','.cargo-checksum.json'] or relative in METADATA
 notice=(any(lower==base or any(lower.startswith(base+delimiter) and len(lower)>len(base)+1 for delimiter in ['.','-','_']) for base in BASES) or 'LICENSES' in relative.split('/')[:-1]) and Path(name).suffix.lower() not in CODE_SUFFIXES
 if name=='license-metadata.json':notice=False
 return metadata,notice

def inventory(manifest,expected,out):
 info=manifest.lstat();need(manifest==manifest.resolve(strict=True) and stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_size<=65536,'Frozen bounded physical inventory input manifest');descriptor=os.open(manifest,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(descriptor,'rb') as f:
  observed=os.fstat(f.fileno());need((observed.st_dev,observed.st_ino,observed.st_size)==(info.st_dev,info.st_ino,info.st_size),'Manifest endpoint changed');raw=f.read(65537)
 need(len(raw)==info.st_size and hashlib.sha256(raw).hexdigest()==expected,'Frozen manifest bytes/SHA256');pins=json.loads(raw);need(len(pins)==4 and {p['id'] for p in pins}=={'rustc-source198','stage0-rustc1971','stage0-cargo1971','stage0-std1971'},'Exact four-input index');need(not os.path.lexists(out) and out.parent==out.parent.resolve(strict=True) and out.parent.stat().st_uid==os.getuid() and not out.parent.stat().st_mode&0o077,'Fresh private owned inventory output');out.mkdir(mode=0o700);cas=out/'cas';cas.mkdir(mode=0o700);started=time.monotonic();deadline=started+SECONDS;budget=Budget(deadline);physical=Physical();member_path=out/'MEMBERS.jsonl';retained_path=out/'RETAINED.jsonl';member_sink=private_sink(member_path);retained_sink=private_sink(retained_path);index_bytes=0;cas_bytes=0;retained_count=0;seen=set();source_metadata_seen=set();rows=[];counts={'regular':0,'directory':0,'symlink':0,'hardlink':0};error=None;complete=False
 def append(sink,row):
  nonlocal index_bytes
  body=(json.dumps(row,sort_keys=True,separators=(',',':'))+'\n').encode();need(index_bytes+len(body)<=INDEX,'Combined member/retained index ceiling');physical.reserve(len(body));need(sink.write(body)==len(body),'Complete bounded index write');index_bytes+=len(body)
 try:
  for pin in pins:
   file=Path(pin['file']);metadata=file.lstat();need(file==file.resolve(strict=True) and stat.S_ISREG(metadata.st_mode) and metadata.st_nlink==1 and metadata.st_uid==os.getuid() and stat.S_IMODE(metadata.st_mode)==0o400,'Physical private0400 opaque input');need(hash_file(file)==(pin['bytes'],pin['sha256']),'Original opaque input SHA256/size');endpoint=(metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns);source=XZ(file,budget);begin=budget.decoded;before_members=budget.members;before_regular=counts['regular']
   try:
    for item,original,link,size in entries(source,budget):
     raw_name,name,relative=path_record(original,pin['prefix'],item.isdir());key=(pin['id'],name);need(key not in seen,'Duplicate original member path');seen.add(key);kind='regular' if item.isreg() else 'directory' if item.isdir() else 'symlink' if item.issym() else 'hardlink';counts[kind]+=1;meta,notice=roles(relative) if item.isreg() else (False,False);need(not(meta and size>(32*1024**2 if relative=='license-metadata.json' else 2*1024**2)) and not(notice and size>16*1024**2),'Selected metadata/notice member ceiling')
     if meta:budget.take('metadata',size,META)
     if pin['id']=='rustc-source198' and meta and relative in METADATA:source_metadata_seen.add(relative)
     if meta and relative in METADATA and relative not in ['license-metadata.json','REUSE.toml']:budget.take('declarations',size,16*1024**2)
     if notice:budget.take('notices',size,NOTICES)
     h=hashlib.sha256();git=hashlib.sha1(b'blob '+str(size).encode()+b'\0');temporary=out/('body-'+str(budget.members)+'.part')
     if meta or notice:physical.reserve(size)
     sink=private_sink(temporary) if meta or notice else None
     try:
      if item.isreg():
       for body in extent(source,size):
        h.update(body);git.update(body)
        if sink:need(sink.write(body)==len(body),'Complete reserved CAS temporary write')
     finally:
      if sink:sink.flush();os.fsync(sink.fileno());sink.close()
     digest=h.hexdigest() if item.isreg() else None;git_digest=git.hexdigest() if item.isreg() else None;target=None
     if meta or notice:
      target=cas/digest
      if target.exists():need(hash_file(target)==(size,digest),'Existing retained CAS collision');temporary.unlink();physical.release(size)
      else:temporary.rename(target);target.chmod(0o400);cas_bytes+=size
      retained_count+=1;append(retained_sink,{'archive':pin['id'],'path':name,'bytes':size,'sha256':digest,'metadata':meta,'noticeCandidate':notice,'file':str(target)})
     append(member_sink,{'archive':pin['id'],'path':name,'originalHeaderPath':raw_name,'type':kind,'mode':item.mode,'bytes':size,'sha256':digest,'gitBlobSHA1':git_digest,'link':link,'metadata':meta,'noticeCandidate':notice,'retainedCAS':str(target) if target else None});need(cas_bytes+index_bytes<=PHYSICAL,'Private retained/index physical ceiling')
    need(budget.members>before_members and counts['regular']>before_regular,'Nonempty regular-file inventory for each selected archive');metadata=file.lstat();need(endpoint==(metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns) and hash_file(file)==(pin['bytes'],pin['sha256']),'Opaque input changed during inventory');rows.append({'id':pin['id'],'bytes':pin['bytes'],'sha256':pin['sha256'],'decodedTarBytes':budget.decoded-begin,'members':budget.members-before_members,'regularMembers':counts['regular']-before_regular,'completeBoundedInertPass':True})
   finally:source.close()
  need(sum(counts.values())==budget.members==len(seen),'Every member category reconciles');budget.check();syncdir(cas);complete=True
 except Exception as e:error={'type':type(e).__name__,'reason':str(e)[:1024]}
 finally:
  for sink in [member_sink,retained_sink]:sink.flush();os.fsync(sink.fileno());sink.close()
  member_path.chmod(0o400);retained_path.chmod(0o400);members_hash=hash_file(member_path);retained_hash=hash_file(retained_path);need(members_hash[0]+retained_hash[0]==index_bytes<=INDEX,'Final combined index byte reconciliation');result={'manifestSHA256':expected,'selectedSourceMetadataCandidatesSeen':sorted(source_metadata_seen),'selectedSourceMetadataCandidatesUnobserved':sorted(METADATA-source_metadata_seen),'completeInertInventory':complete,'failure':error,'inputs':rows,'counts':counts,'members':budget.members,'decodedTarBytes':budget.decoded,'metadataAssociationBytes':budget.metadata,'finiteBuildDeclarationBytes':budget.declarations,'noticeCandidateAssociationBytes':budget.notices,'retainedAssociations':retained_count,'retainedCASPhysicalBytes':cas_bytes,'physicalFileByteBudget':PHYSICAL,'preWriteReservedBytesIncluding65536SidecarReserve':physical.reserved,'sidecarReserveBytes':65536,'memberIndex':{'file':str(member_path),'bytes':members_hash[0],'sha256':members_hash[1]},'retainedIndex':{'file':str(retained_path),'bytes':retained_hash[0],'sha256':retained_hash[1]},'archiveSourceTreesExtractedOrLinksActivated':False,'compilerSDKBootstrapPackageOrModelExecuted':False,'completeSourceVendorNoticesBuildOrGateAClosureClaimed':False,'firstPassOnlyDeclaredLicensePointerReconciliationPending':True};need(len(encoded({**result,'completionCreditFinalized':True,'completionBudgetExhausted':True,'elapsedSeconds':1800.0}))<=16384,'Final sidecar fits pre-reserved ceiling');result=deadline_receipt(out/'RESULT.json',result,deadline,{'completeInertInventory':False,'completionBudgetExhausted':True},started)
 return result
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest',type=Path);p.add_argument('out',type=Path);p.add_argument('--sha256',required=True);a=p.parse_args();r=inventory(a.manifest,a.sha256,a.out);print(json.dumps({'completeInertInventory':r['completeInertInventory'],'members':r['members'],'failure':r['failure']}));raise SystemExit(0 if r['completeInertInventory'] else 1)
