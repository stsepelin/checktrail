"""Bounded transactional original-source workspace and unchanged bootstrap-cache preparation.
Imports and plan validation execute no archive, SDK or upstream source code.
"""
from pathlib import Path
import hashlib,io,json,os,posixpath,shutil,stat,sys,time,types
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE))
from admission import read_once
REUSE={'inventory.py':'509f0ef56d388777b8ded23d5285064e12c0780cd2eb02a0015616dd93629727','common.py':'c7d863cf1502600b11754d9d5aed90511481a6959f2a4d3b4a68ad3616eee72f','POLICY.json':'b9d8b09325cf578f618adeb896eff7f66c7f1dd15fb24b789a9a8144f9880fe5'}
def need(v,m):
 if not v:raise ValueError(m)
def digest(file):
 h=hashlib.sha256();n=0
 with file.open('rb') as f:
  for b in iter(lambda:f.read(65536),b''):n+=len(b);h.update(b)
 return n,h.hexdigest()
REUSE_BYTES=1024**2
def verified_module(name,file,body):
 module=types.ModuleType(name);module.__file__=str(file);module.__verifiedSHA256__=hashlib.sha256(body).hexdigest();exec(compile(body,str(file),'exec'),module.__dict__);return module
def primitives():
 # The reviewed modules run from the bytes that matched their pins, never from a reopened path.
 root=HERE/'reused-inventory';bodies={}
 for name,sha in REUSE.items():bodies[name]=read_once(root/name,REUSE_BYTES,'Reviewed bounded primitive file')[0];need(hashlib.sha256(bodies[name]).hexdigest()==sha,'Reviewed bounded primitive bytes changed')
 if 'common' in sys.modules:need(getattr(sys.modules['common'],'__verifiedSHA256__',None)==REUSE['common.py'] and Path(sys.modules['common'].__file__)==root/'common.py','Wrong cached common module')
 else:sys.modules['common']=verified_module('common',root/'common.py',bodies['common.py'])
 module=verified_module('rust_producer_bounded_tar',root/'inventory.py',bodies['inventory.py'])
 # inventory.py reads POLICY.json itself at import; that read must give the pinned policy.
 need(module.METADATA==set(json.loads(bodies['POLICY.json'])['sourceMetadataPaths']),'Reviewed bounded primitive bytes changed');return module

def safe(path):
 need(isinstance(path,str) and path and len(path.encode())<=2048 and all(ord(c)>=32 and ord(c)!=127 for c in path) and not path.startswith('/') and '\\' not in path and all(x not in ('','.','..') for x in path.split('/')),'Canonical source relative path');return path

class HeldArchive:
 """An archive read once and matched to its pin; every pass reads these same bytes."""
 def __init__(self,body):self.body=body
 def open(self,mode='rb'):need(mode=='rb','Read-only held archive');return io.BytesIO(self.body)
def held_archive(path,pin,refusal):
 body=read_once(Path(path),pin['bytes'],refusal)[0];need((len(body),hashlib.sha256(body).hexdigest())==(pin['bytes'],pin['sha256']),refusal);return body

def target(path,link):
 need(isinstance(link,str) and link and len(link.encode())<=2048 and all(ord(c)>=32 and ord(c)!=127 for c in link) and not link.startswith('/') and '\\' not in link,'Relative original link required');value=posixpath.normpath(posixpath.join(posixpath.dirname(path),link));need(value!='..' and not value.startswith('../') and value!='.','Original link leaves source root');return safe(value)

def validate_layout(records):
 need(records,'Nonempty original material map');by={r['path']:r for r in records};need(len(by)==len(records),'Duplicate original material path')
 for path,row in by.items():
  safe(path);need(row['type'] in ['regular','directory','symlink'],'Original source supported regular/directory/symlink only');need(type(row['mode']) is int and row['mode']&~0o777==0,'Privileged original mode refused');parts=path.split('/')
  for i in range(1,len(parts)):
   parent='/'.join(parts[:i]);need(parent in by and by[parent]['type']=='directory','Original material parent is not a directory')
  if row['type']=='symlink':
   current=path;seen=set()
   while by[current]['type']=='symlink':
    need(current not in seen,'Original symlink cycle');seen.add(current);current=target(current,by[current]['link']);need(current in by,'Original symlink target absent')
 return by

class PassBudget:
 def __init__(self,shared,deadline,limits):self.shared=shared;self.deadline=deadline;self.limits=limits;self.members=0
 def check(self):
  need(time.monotonic()<self.deadline,'Materialization whole deadline')
  need(all(shutil.disk_usage(p).free>=self.limits.get('minimumFreeBytes',0) for p in self.limits.get('materializationCapacityRoots',[])),'Materialization actual backing/volume free-space reserve')
 def take(self,field,n,_maximum):
  self.check()
  if field=='decoded':self.shared['decoded']+=n;need(self.shared['decoded']<=self.limits['materializationDecodedBytes'],'Aggregate two-pass decoded ceiling')
  elif field=='members':self.members+=n;need(self.members<=self.limits['materializationMembersPerPass'],'Original members-per-pass ceiling')
  else:raise ValueError('Unexpected materializer reader budget')

def source_pass(archive,prefix,I,budget,consume):
 reader=I.XZ(archive,budget);root_mode=None
 try:
  for item,original,link,size in I.entries(reader,budget):
   _raw,full,relative=I.path_record(original,prefix,item.isdir())
   if not relative:need(item.isdir() and root_mode is None and item.mode&~0o777==0,'One unprivileged original archive root directory');root_mode=item.mode;continue
   need(item.isreg() or item.isdir() or item.issym(),'Source hardlink/unsupported entry not selected');row={'path':safe(relative),'type':'regular' if item.isreg() else 'directory' if item.isdir() else 'symlink','mode':item.mode,'bytes':size,'link':link,'sha256':None};consume(row,I.extent(reader,size) if item.isreg() else ())
 finally:reader.close()
 need(root_mode is not None,'Original archive root directory absent');return root_mode

def materialize(source_pin,cache_pins,archives,destination,limits,I=None):
 """Future operator-only call; tests pass only synthetic generated archive bodies."""
 started=time.monotonic();limits={**limits,'materializationCapacityRoots':[destination.parent,destination.parent.parent]};deadline=started+limits['materializationSeconds'];I=I or primitives();need(not os.path.lexists(destination),'Fresh source destination');need(destination.parent==destination.parent.resolve(strict=True),'Physical owned materialization parents');shared={'decoded':0};source=HeldArchive(held_archive(archives[source_pin['id']],source_pin,'Original source archive pin'));records=[]
 def screen(row,chunks):
  h=hashlib.sha256()
  for b in chunks:h.update(b)
  if row['type']=='regular':row['sha256']=h.hexdigest()
  records.append(row)
 root_mode=source_pass(source,source_pin['prefix'],I,PassBudget(shared,deadline,limits),screen);by=validate_layout(records);index=(json.dumps(records,sort_keys=True,separators=(',',':'))+'\n').encode();need(len(index)<=limits['materializationIndexBytes'],'Original member-map byte ceiling');payload=sum(r['bytes'] for r in records if r['type']=='regular');cache_total=sum(p['bytes'] for p in cache_pins);reserved=payload+cache_total+len(index)+65536;need(reserved<=limits['materializationFileAndIndexBytes'],'All source/cache/map logical file bytes reserved before writes');need(not any(p=='build' or p.startswith('build/') for p in by),'Original archive overlaps bootstrap build/cache namespace')
 caches={pin['id']:held_archive(archives[pin['id']],pin,'Original bootstrap cache pin') for pin in cache_pins}
 temp=destination.with_name(destination.name+'.unaccepted');need(not os.path.lexists(temp),'Preserve previous materialization failure');temp.mkdir(mode=0o700);tree=temp/'source';tree.mkdir(mode=0o700);meta=temp/'control';meta.mkdir(mode=0o700);seen=set()
 try:
  for row in sorted(records,key=lambda r:(r['path'].count('/'),r['path'])):
   if row['type']=='directory':(tree/row['path']).mkdir(mode=0o700)
  def write(row,chunks):
   need(row['path'] not in seen and row['path'] in by,'Exact second-pass unique original member');seen.add(row['path']);expected=by[row['path']];need(all(row[k]==expected[k] for k in ['path','type','mode','bytes','link']),'Original source headers changed between passes')
   if row['type']=='regular':
    file=tree/row['path'];fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600);h=hashlib.sha256()
    with os.fdopen(fd,'wb') as f:
     for b in chunks:need(f.write(b)==len(b),'Complete reserved source write');h.update(b)
    need(h.hexdigest()==expected['sha256'],'Original source body changed between passes');file.chmod(row['mode'])
  second_root_mode=source_pass(source,source_pin['prefix'],I,PassBudget(shared,deadline,limits),write);need(second_root_mode==root_mode,'Original root directory mode changed');need(seen==set(by),'All original source members materialized')
  for row in records:
   if row['type']=='symlink':os.symlink(row['link'],tree/row['path'])
  for row in sorted(records,key=lambda r:r['path'].count('/'),reverse=True):
   if row['type']=='directory':(tree/row['path']).chmod(row['mode'])
  tree.chmod(root_mode);cache=tree/'build/cache/2026-07-16';cache.mkdir(parents=True,mode=0o700)
  for pin in cache_pins:
   filename=pin['originalURL'].rsplit('/',1)[-1];safe(filename);out=cache/filename
   with out.open('xb') as sink:need(sink.write(caches[pin['id']])==pin['bytes'],'Complete reserved bootstrap cache write')
   need(digest(out)==(pin['bytes'],pin['sha256']),'Unchanged original bootstrap working-cache copy');out.chmod(0o444)
  need(time.monotonic()<deadline,'Late materialization refused');mapfile=meta/'original-source-members.json';need(not mapfile.exists(),'Fresh protected original member map');mapfile.write_bytes(index);mapfile.chmod(0o444);os.rename(temp,destination)
 except BaseException:
  # Root-owned private unaccepted tree is retained as failure evidence; never activated as final workspace.
  raise
 return {'completeSourceMaterialization':True,'source':str(destination/'source'),'memberMap':str(destination/'control/original-source-members.json'),'memberMapSHA256':hashlib.sha256(index).hexdigest(),'originalWorkspaceMembersExcludingArchiveRoot':len(records),'originalMaterialMembersIncludingArchiveRoot':len(records)+1,'originalRegularBytes':payload,'workingBootstrapCacheBytes':cache_total,'reservedFileAndIndexBytes':reserved,'filesystemDirectoryMetadataBytesNotIncludedInLogicalReservation':True,'actualBackingAndVolumeFreeSpaceCheckedThroughoutPasses':True,'twoPassDecodedBytes':shared['decoded'],'elapsedSeconds':time.monotonic()-started,'sourceOrSDKCodeExecuted':False,'nativeBuildPassCredit':False}

def original_frame_matches(source,records):
 need(source==source.resolve(strict=True) and source.is_dir(),'Physical source workspace root')
 ordered=sorted(records,key=lambda r:(r['type']!='directory',r['path'].count('/')))
 for row in ordered:
  p=source/row['path'];s=p.lstat()
  if row['type']=='regular':need(stat.S_ISREG(s.st_mode) and stat.S_IMODE(s.st_mode)==row['mode'] and digest(p)==(row['bytes'],row['sha256']),'Original working source file changed')
  elif row['type']=='directory':need(stat.S_ISDIR(s.st_mode) and stat.S_IMODE(s.st_mode)==row['mode'],'Original working source directory changed')
  else:need(stat.S_ISLNK(s.st_mode) and os.readlink(p)==row['link'],'Original working source link changed')
 return True
