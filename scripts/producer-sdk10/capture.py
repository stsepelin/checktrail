"""Stopped persistent-byte capture and independent no-extraction roundtrip."""
import argparse,gzip,hashlib,io,json,os,pathlib,stat,sys,tarfile,time
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from common import Refusal,need,encoded,freeze,hash_file,safe_relative,syncdir
MEMBER_MAP='_checktrail/CAPTURE-MEMBERS.jsonl'
class Sink:
 def __init__(self,file,maximum):self.file=file;self.maximum=maximum;self.bytes=0;self.hash=hashlib.sha256()
 def write(self,body):
  need(self.bytes+len(body)<=self.maximum,'compressed persistent-byte capture limit');n=self.file.write(body);need(n==len(body),'capture short write');self.bytes+=n;self.hash.update(body);return n
 def flush(self):self.file.flush()
def scan(root,prefix,deadline,maximum_members=2000000):
 rows=[];stack=[pathlib.Path(root)]
 while stack:
  parent=stack.pop();need(time.monotonic()<deadline,'capture enumeration deadline')
  for entry in sorted(os.scandir(parent),key=lambda x:x.name):
   p=pathlib.Path(entry.path);relative=p.relative_to(root).as_posix();name=safe_relative(prefix+'/'+relative);s=entry.stat(follow_symlinks=False);need(len(rows)<maximum_members,'capture member limit');kind='regular' if stat.S_ISREG(s.st_mode) else 'directory' if stat.S_ISDIR(s.st_mode) else 'symlink' if stat.S_ISLNK(s.st_mode) else 'socket' if stat.S_ISSOCK(s.st_mode) else 'fifo' if stat.S_ISFIFO(s.st_mode) else 'unsupported';need(kind!='unsupported','unknown stopped filesystem node type')
   row={'path':name,'physical':str(p),'kind':kind,'mode':stat.S_IMODE(s.st_mode),'bytes':s.st_size,'uid':s.st_uid,'gid':s.st_gid,'nlink':s.st_nlink,'dev':s.st_dev,'inode':s.st_ino,'mtimeNS':s.st_mtime_ns,'ctimeNS':s.st_ctime_ns}
   if kind=='directory':stack.append(p)
   if kind=='symlink':row['target']=os.readlink(p)
   if kind in ['socket','fifo']:row['byteBodyDisposition']='IPC metadata only after all owned source processes stopped; no persistent regular byte body';row['archiveMemberEmitted']=False
   rows.append(row)
 return rows
def stable(row):
 p=pathlib.Path(row['physical']);s=p.lstat();need((s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==tuple(row[k] for k in ['dev','inode','bytes','mtimeNS','ctimeNS']),'stopped evidence changed after enumeration');return p,s
PADDING=1024**2
class Tail:
 """The decompressed tar stream, keeping its last bytes and their offset.

 tarfile stops at an invalid or empty header without saying so, and has
 already consumed that block, so the end marker is checked from these bytes.
 """
 def __init__(self,stream,keep):self.stream=stream;self.keep=keep;self.window=bytearray();self.start=0
 def read(self,n=-1):
  block=self.stream.read(n);self.window+=block
  if len(self.window)>self.keep:drop=len(self.window)-self.keep;del self.window[:drop];self.start+=drop
  return block
def roundtrip(path,deadline,maximum_bytes,maximum_members=2000000):
 observed={};archive_names=set();manifest=None;manifest_hash=None;total=0;stream=gzip.open(path,'rb');tail=Tail(stream,2*PADDING)
 try:
  with tarfile.open(fileobj=tail,mode='r|') as t:
   for item in t:
    need(time.monotonic()<deadline,'capture independent roundtrip deadline');name=safe_relative(item.name);need(name not in archive_names and len(archive_names)<maximum_members+1,'unique bounded archive member set');archive_names.add(name);need(manifest is None,'internal member map must be unique final archive member')
    if name==MEMBER_MAP:
     need(item.isfile() and item.size<=1024**3,'bounded internal file inventory');f=t.extractfile(item);rows=[];read=0
     mh=hashlib.sha256()
     for line in f:
      read+=len(line);need(read<=item.size and len(line)<=65536,'bounded inventory record');row=json.loads(line);need(type(row) is dict,'capture inventory row');rows.append(row)
      mh.update(line)
     need(read==item.size,'full inventory stream');manifest=rows;manifest_hash=mh.hexdigest();continue
    row={'mode':item.mode,'uid':item.uid,'gid':item.gid,'kind':'directory' if item.isdir() else 'symlink' if item.issym() else 'hardlink' if item.islnk() else 'regular' if item.isfile() else 'unsupported'};need(row['kind']!='unsupported','opaque archive node type')
    if row['kind']=='symlink':row['target']=item.linkname
    if row['kind']=='hardlink':
     target=safe_relative(item.linkname);need(target in observed and observed[target]['kind'] in ['regular','hardlink'],'prior exact content-dedup target');row.update(bytes=observed[target]['bytes'],sha256=observed[target]['sha256'],archiveLink=target)
    if row['kind']=='regular':
     h=hashlib.sha256();n=0;f=t.extractfile(item)
     for block in iter(lambda:f.read(1048576),b''):need(time.monotonic()<deadline,'capture decoded-byte roundtrip deadline');n+=len(block);total+=len(block);need(n<=item.size and total<=maximum_bytes,'capture decoded-byte accounting');h.update(block)
     need(n==item.size,'complete archived regular body');row.update(bytes=n,sha256=h.hexdigest())
    observed[name]=row
   # From the aligned end of the last member to the gzip footer (which checks
   # the CRC): the two zero end blocks, then at most PADDING zero bytes.
   end=t.offset
   while True:
    need(time.monotonic()<deadline,'capture gzip footer deadline');block=t.fileobj.read(65536)
    need(tail.start+len(tail.window)-end<=1024+PADDING,'zero tar end marker and bounded zero padding')
    if not block:break
   need(end>=tail.start and tail.start+len(tail.window)-end>=1024 and not any(tail.window[end-tail.start:]),'zero tar end marker and bounded zero padding')
  need(stream.read(1)==b'','complete gzip stream consumed')
 finally:stream.close()
 need(manifest is not None,'internal complete member inventory present');seen=set();regular_paths=0
 for row in manifest:
  name=safe_relative(row['path']);need(name not in seen,'unique inventory path');seen.add(name)
  if row['kind'] in ['socket','fifo']:need(row.get('archiveMemberEmitted') is False and name not in observed,'IPC metadata-only disposition exact');continue
  need(name in observed,'every persistent path included in archive');got=observed[name];need(all(got[k]==row[k] for k in ['mode','uid','gid']),'every original mode/owner retained');need(got.get('archiveLink')==row.get('archiveLink'),'exact declared content reference retained')
  if row['kind']=='regular':need(got['kind'] in ['regular','hardlink'] and got['bytes']==row['bytes'] and got['sha256']==row['sha256'],'every persistent byte body or exact proven duplicate verified');regular_paths+=1
  elif row['kind']=='symlink':need(got['kind']=='symlink' and got['target']==row['target'],'symlink text retained without following')
  else:need(got['kind']=='directory','directory identity retained')
 need(set(observed)=={x['path'] for x in manifest if x['kind'] not in ['socket','fifo']},'exact archive/inventory path accounting');return {'archiveRoundtripVerified':True,'persistentRegularPaths':regular_paths,'inventoryRows':len(manifest),'uniqueDecodedBodyBytes':total,'internalMemberMapSHA256':manifest_hash,'IPCMetadataOnlyPaths':sum(x['kind'] in ['socket','fifo'] for x in manifest),'sourceOrLogBodiesEmitted':False}
def capture(roots,target,deadline,maximum_compressed,maximum_logical=32*1024**3):
 rows=[]
 for prefix,root in roots.items():rows.extend(scan(root,prefix,deadline))
 need(len(rows)<=2000000 and len({x['path'] for x in rows})==len(rows),'complete disjoint stopped roots');logical=sum(x['bytes'] for x in rows if x['kind']=='regular');need(logical<=maximum_logical,'stopped persistent logical byte bound');by_content={};dedup=0
 with pathlib.Path(target).open('xb') as file:
  sink=Sink(file,maximum_compressed)
  with gzip.GzipFile(filename='',mode='wb',fileobj=sink,compresslevel=1,mtime=0) as gz,tarfile.open(fileobj=gz,mode='w|',format=tarfile.PAX_FORMAT) as t:
   for row in rows:
    need(time.monotonic()<deadline,'stopped capture streaming deadline');p,s=stable(row)
    if row['kind'] in ['socket','fifo']:continue
    item=tarfile.TarInfo(row['path']);item.mode=row['mode'];item.mtime=s.st_mtime;item.uid=row['uid'];item.gid=row['gid']
    if row['kind']=='directory':item.type=tarfile.DIRTYPE;t.addfile(item)
    elif row['kind']=='symlink':item.type=tarfile.SYMTYPE;item.linkname=row['target'];t.addfile(item)
    else:
     fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
     with os.fdopen(fd,'rb') as f:
      st=os.fstat(f.fileno());need((st.st_dev,st.st_ino,st.st_size)==(row['dev'],row['inode'],row['bytes']),'opened original stopped file identity');h=hashlib.sha256()
      for b in iter(lambda:f.read(1048576),b''):need(time.monotonic()<deadline,'original body hashing deadline');h.update(b)
      row['sha256']=h.hexdigest();key=(row['bytes'],row['sha256']);other=by_content.get(key)
      if other is not None:item.type=tarfile.LNKTYPE;item.linkname=other;row['archiveLink']=other;t.addfile(item);dedup+=row['bytes']
      else:
       f.seek(0);item.size=row['bytes'];t.addfile(item,f);by_content[key]=row['path']
      after=os.fstat(f.fileno());need((after.st_size,after.st_mtime_ns,after.st_ctime_ns)==(row['bytes'],row['mtimeNS'],row['ctimeNS']),'original body unchanged through capture')
   # All paths/modes, physical hardlink identities and proven content aliases are
   # retained, even when byte-identical bodies are stored only once.
   metadata=b''.join((json.dumps({k:v for k,v in row.items() if k!='physical'},sort_keys=True)+'\n').encode() for row in rows);item=tarfile.TarInfo(MEMBER_MAP);item.mode=0o400;item.size=len(metadata);t.addfile(item,io.BytesIO(metadata))
  file.flush();os.fsync(file.fileno());summary={'bytes':sink.bytes,'sha256':sink.hash.hexdigest(),'logicalPersistentBytes':logical,'provenDuplicateBodyBytesStoredByReference':dedup,'internalMemberMapSHA256':hashlib.sha256(metadata).hexdigest()}
 pathlib.Path(target).chmod(0o400);summary.update(roundtrip(target,deadline,maximum_logical));return summary
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--work',required=True);p.add_argument('--evidence',required=True);p.add_argument('--inputs',required=True);p.add_argument('--out',required=True);p.add_argument('--deadline',type=float,required=True);p.add_argument('--uid',type=int,required=True);p.add_argument('--gid',type=int,required=True);a=p.parse_args();out=pathlib.Path(a.out);result=None
 os.chown(out,0,0)
 try:result={'state':'COMPLETE stopped persistent-byte capture',**capture({'work':a.work,'host-evidence':a.evidence,'host-inputs':a.inputs},out/'STOPPED-EVIDENCE.tar.gz',a.deadline,12*1024**3-65536,32*1024**3)}
 except BaseException as e:result={'state':'INCOMPLETE stopped persistent-byte capture','errorType':type(e).__name__,'reason':str(e)[:300],'soleOriginalVolumeMayNotBeDeleted':True}
 finally:
  freeze(out/'CAPTURE-RESULT.json',encoded(result))
  for f in out.iterdir():
   if f.is_file() and not f.is_symlink():os.chown(f,a.uid,a.gid)
  os.chown(out,a.uid,a.gid)
  syncdir(out);print(json.dumps(result))
 if result['state'].startswith('INCOMPLETE'):raise SystemExit(1)
