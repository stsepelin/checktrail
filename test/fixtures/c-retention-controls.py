# Generated filesystem controls. Mutants delete only the exact named regression guards.
from pathlib import Path
import collections,contextlib,errno,hashlib,io,json,os,shutil,socket,stat,tempfile,time,types
ROOT=Path(__import__('sys').argv[1]).resolve(strict=True)
START=time.monotonic();ROWS=[]
def need(v,m):
 if not v:raise ValueError(m)
def clock():need(time.monotonic()-START<40,'Finite generated observer-control deadline')
def module(raw,name):
 m=types.ModuleType(name);m.__file__=name;exec(compile(raw,name,'exec'),m.__dict__);return m
def remove_once(raw,guard):
 need(raw.count(guard)==1,'Exact unique regression guard');return raw.replace(guard,'')
raw=(ROOT/'scripts/producer-qualification/binutils-retention-observer.py').read_text()
need(len(raw.encode())<=16384,'Bounded observer source')
new=module(raw,'current_c_observer')
traversal='                        if work_root and entry.name == "native-build" and identity(actual) != opened[3][2]:\n                            raise ValueError("C producer build traversal differs from the held build root")\n'
cleanup='                if cleanup_failures:\n                    raise\n'
old=module(remove_once(remove_once(raw,traversal),cleanup),'two_guard_removed_mutant')
node_raw=(ROOT/'scripts/producer-qualification/node-original-retention-observer.py').read_text()
need(len(node_raw.encode())<=16384,'Bounded Node observer source')
node_current=module(node_raw,'current_node_observer')
node_mutant=module(remove_once(node_raw,cleanup),'node_cleanup_guard_removed_mutant')
class Fixture:
 def __enter__(self):
  self.root=Path(tempfile.mkdtemp(prefix='ct-cobs-')).resolve(strict=True);self.roots=tuple(str(self.root/n)for n in ['bundle','controls','work']);self.sockets=[]
  for p in self.roots:Path(p).mkdir(mode=0o700)
  self.work=Path(self.roots[2]);self.native=self.work/'native-build';self.native.mkdir(mode=0o700);self.churn=self.native/'z-churn';self.churn.mkdir(mode=0o700)
  for p,b in [(Path(self.roots[0])/'archive',b'B'),(Path(self.roots[1])/'script',b'C'),(self.work/'outside',b'O'),(self.native/'a-data',b'abc')]:p.write_bytes(b)
  self.base_bytes=6;return self
 def objects(self):
  target=self.root/'outside-secret';target.write_bytes(b'authored outside data never read')
  self.literal=str(target);os.symlink(self.literal,self.native/'alias');os.mkfifo(self.native/'pipe',0o600)
  s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.bind(str(self.native/'sock'));self.sockets.append(s)
 def __exit__(self,*args):
  for s in self.sockets:s.close()
  shutil.rmtree(self.root)
class FakeEntry:
 def __init__(self,name,info):self.name=name;self.info=info
 def stat(self,follow_symlinks=True):
  need(follow_symlinks is False,'Authored metadata entry cannot follow targets');return self.info
class Scan:
 def __init__(self,v,fd):self.v=v;self.fd=fd;self.ctx=None;self.swapped=False
 def __enter__(self):
  v=self.v;p=v.paths[self.fd]
  if p==v.f.churn:
   v.churn_calls+=1
   if v.mode in ['enoent-once','enoent-close']and v.churn_calls==1 or v.mode=='enoent-always':
    raise FileNotFoundError(errno.ENOENT,'authored mutable entry disappeared')
  if p==v.f.work:
   v.work_scans+=1
   if v.mode=='swap':
    os.rename(v.f.native,v.f.root/'held-original');os.rename(v.f.root/'replacement',v.f.native);self.swapped=True
  self.ctx=os.scandir(self.fd);entries=list(self.ctx.__enter__());entries.sort(key=lambda e:e.name)
  for parent,name,info in v.extra:
   if p==parent:entries.append(FakeEntry(name,info))
  return iter(entries)
 def __exit__(self,*args):
  try:
   if self.ctx is not None:self.ctx.__exit__(*args)
  finally:
   if self.swapped:
    os.rename(self.v.f.native,self.v.f.root/'replacement');os.rename(self.v.f.root/'held-original',self.v.f.native)
class View:
 def __init__(self,f,mode=None,extra=()):
  self.f=f;self.mode=mode;self.extra=extra;self.paths={};self.opened=0;self.closed=0;self.churn_calls=0;self.work_scans=0;self.close_fault=False;self.directory_only=True;self.link_reads=[]
 def __getattr__(self,n):return getattr(os,n)
 def open(self,p,flags,mode=0o777,dir_fd=None):
  need(flags&os.O_DIRECTORY and flags&os.O_NOFOLLOW,'No regular/link/special content opened by observer')
  fd=os.open(p,flags,mode,dir_fd=dir_fd);self.paths[fd]=Path(p)if dir_fd is None else self.paths[dir_fd]/p;self.opened+=1;return fd
 def close(self,fd):
  p=self.paths[fd];os.close(fd);del self.paths[fd];self.closed+=1
  if self.mode=='enoent-close'and p==self.f.churn and not self.close_fault:
   self.close_fault=True;raise OSError(errno.EIO,'authored child close failure after real close')
 def scandir(self,fd):return Scan(self,fd)
 def stat(self,p,dir_fd=None,follow_symlinks=True):
  for parent,name,info in self.extra:
   if dir_fd is not None and self.paths[dir_fd]==parent and p==name:
    need(follow_symlinks is False,'Special entry stat must not follow');return info
  return os.stat(p,dir_fd=dir_fd,follow_symlinks=follow_symlinks)
 def readlink(self,p,dir_fd=None):
  target=os.readlink(p,dir_fd=dir_fd);self.link_reads.append((str(self.paths[dir_fd]/p),target));return target
def call(module,f,mode=None,extra=(),strict=False,node_policy=False):
 view=View(f,mode,extra);original=module.os;module.os=view;stderr=io.StringIO();result=error=None
 try:
  with contextlib.redirect_stderr(stderr):
   try:result=module.count_roots(f.roots,7)if node_policy else module.count_roots(f.roots)if strict else module.count_c_build_roots(f.roots,7)
   except BaseException as e:error=e
 finally:module.os=original
 unclosed=list(view.paths)
 try:need(not unclosed and view.opened==view.closed,'Every observer opened real directory FD closed')
 finally:
  for fd in unclosed:
   try:os.close(fd)
   finally:view.paths.pop(fd,None)
 return result,error,view,stderr.getvalue()
def exact(error,kind,message=None,code=None):
 need(type(error)is kind,'Exact intended observer exception class')
 if message is not None:need(str(error)==message,'Exact intended observer exception message')
 if code is not None:need(error.errno==code,'Exact intended observer errno')
def case(name,body):
 clock();body();ROWS.append({'case':name,'outcome':'PASS'});clock()
def ordinary():
 with Fixture()as f:
  result,error,v,stderr=call(new,f);need(error is None and result=={'bytes':6,'files':4,'directories':5,'links':0,'linkTargetBytes':0,'sockets':0,'fifos':0,'devices':0}and stderr=='','Exact ordinary owned four-root sample')
case('ordinary four-root valid sample has exact counters',ordinary)
def native_objects():
 with Fixture()as f:
  f.objects();r,e,v,_=call(new,f);need(e is None and r['bytes']==6+len(os.fsencode(f.literal))and r['files']==7 and r['links']==r['sockets']==r['fifos']==1 and r['devices']==0,'Exact no-follow native link socket FIFO metadata counters');need(v.link_reads==[(str(f.native/'alias'),f.literal)],'Only exact native link literal read')
case('exact native subtree counts real link FIFO socket metadata without contents',native_objects)
def strict(where,kind):
 with Fixture()as f:
  parent=Path(f.roots[0 if where=='bundle'else 1])if where in ['bundle','controls']else f.work/'sibling'
  if where=='nested-near':parent=f.work/'wrapper'/'native-build';parent.mkdir(parents=True)
  elif where=='sibling':parent.mkdir()
  p=parent/'not-ordinary'
  if kind=='link':os.symlink('/authored-target-never-followed',p)
  else:os.mkfifo(p,0o600)
  _,e,v,_=call(new,f);exact(e,ValueError,'linked immutable input or nonregular retained work refused');need(not v.link_reads,'Strict path never reads a link target')
case('bundle link remains strict',lambda:strict('bundle','link'))
case('controls FIFO remains strict',lambda:strict('controls','fifo'))
case('work sibling link remains strict',lambda:strict('sibling','link'))
case('nested native-build name is not the exact relaxed root',lambda:strict('nested-near','link'))
def missing_root():
 with Fixture()as f:
  shutil.rmtree(f.native);_,e,v,stderr=call(new,f);exact(e,FileNotFoundError,code=errno.ENOENT);need(v.work_scans==0 and stderr=='','Missing fixed raw root never becomes mutable ENOENT retry')
case('missing fourth native root refuses before work scans',missing_root)
def raw_root_link():
 with Fixture()as f:
  os.rename(f.native,f.root/'original');os.symlink(f.root/'original',f.native)
  _,e,v,stderr=call(new,f);need(type(e)is NotADirectoryError or type(e)is OSError,'Exact directory no-follow open refusal');need(e.errno in [errno.ENOTDIR,errno.ELOOP]and e.filename==str(f.native)and v.work_scans==0 and stderr=='','Native-root symlink refused by fixed no-follow directory open')
case('fourth root symlink is not followed or rescanned',raw_root_link)
def swapped(module,expect_refusal):
 with Fixture()as f:
  replacement=f.root/'replacement';replacement.mkdir();(replacement/'other').write_bytes(b'abcdefghijk')
  r,e,v,_=call(module,f,'swap')
  need(f.native.is_dir()and(f.native/'a-data').read_bytes()==b'abc','Transient swap always restored by authored IO context')
  if expect_refusal:exact(e,ValueError,'C producer build traversal differs from the held build root')
  else:need(e is None and r['bytes']==14 and r['bytes']!=f.base_bytes,'Guard-removed mutant accepted replacement bytes after restored root boundaries')
case('transient replaced restored native root is refused at actual traversal FD',lambda:swapped(new,True))
case('guard-removed mutant accepts wrong replacement counters despite restored root',lambda:swapped(old,False))
def once():
 with Fixture()as f:
  r,e,v,stderr=call(new,f,'enoent-once');rows=[json.loads(s)for s in stderr.splitlines()];need(e is None and r['bytes']==6 and r['files']==4 and r['directories']==5 and v.churn_calls==2,'Discard all partial mutable counters then complete one sample');need(len(rows)==1 and rows[0]['discardedAttempt']==1 and rows[0]['sequence']==7,'Exact one bounded ENOENT retry diagnostic')
case('one mutable ENOENT discards partial counters rather than double-counting',once)
def exhaust():
 with Fixture()as f:
  _,e,v,stderr=call(new,f,'enoent-always');exact(e,FileNotFoundError,code=errno.ENOENT);rows=[json.loads(s)for s in stderr.splitlines()];need(v.churn_calls==3 and [r['discardedAttempt']for r in rows]==[1,2],'Exactly three attempts and two discarded ENOENT diagnostics')
case('three ENOENT generations exhaust exact bound',exhaust)
def close_error(module,refuse,node_policy=False):
 with Fixture()as f:
  r,e,v,stderr=call(module,f,'enoent-close',node_policy=node_policy);need(v.close_fault,'Actual nested close error seam was armed')
  if refuse:
   exact(e,FileNotFoundError,code=errno.ENOENT);need(len(e.cleanupFailures)==1 and e.cleanupFailures[0]['type']=='OSError'and 'authored child close failure'in e.cleanupFailures[0]['message']and v.churn_calls==1 and stderr=='','Retain primary ENOENT and close secondary without successful retry')
  else:need(e is None and r['bytes']==6 and v.churn_calls==2 and len(stderr.splitlines())==1,'Guard-removed mutant RED lost the close secondary after successful retry')
case('ENOENT plus nested close failure poisons retry and preserves both facts',lambda:close_error(new,True))
case('guard-removed mutant suppresses nested close failure after retry',lambda:close_error(old,False))
def devices(parent_kind,strict_policy=False):
 with Fixture()as f:
  parent=f.native if parent_kind=='native'else f.work/'sibling'
  if parent_kind!='native':parent.mkdir()
  entries=[]
  for i,mode in enumerate([stat.S_IFCHR,stat.S_IFBLK]):
   info=types.SimpleNamespace(st_dev=987,st_ino=200+i,st_mode=mode|0o600,st_uid=os.geteuid(),st_gid=os.getegid(),st_size=0,st_mtime_ns=1,st_ctime_ns=1,st_nlink=1)
   entries.append((parent,'authored-device-'+str(i),info))
  r,e,v,_=call(new,f,extra=entries)
  if strict_policy:exact(e,ValueError,'linked immutable input or nonregular retained work refused')
  else:need(e is None and r['devices']==2 and r['bytes']==6 and r['files']==6,'Authored valid Linux character/block metadata only; no privileged device creation claimed')
case('native Linux character block stat classes counted as metadata only',lambda:devices('native'))
case('character block metadata in a sibling stays strict',lambda:devices('sibling',True))
def default():
 with Fixture()as f:
  os.symlink('a-data',f.native/'alias');_,e,_,_=call(new,f,strict=True);exact(e,ValueError,'linked or nonregular retained work refused')
case('default strict counter still refuses native link near miss',default)
case('Node ENOENT plus nested close failure preserves primary and secondary',lambda:close_error(node_current,True,True))
case('Node guard-removed mutant demonstrates erased nested close failure',lambda:close_error(node_mutant,False,True))
need(len(ROWS)==19,'Nineteen exact generated observer cases')
print(json.dumps({'cases':ROWS,'count':19,'allTrackedRealFDsClosed':True,'mutationsDeleteOnlyNamedGuards':True,'syntheticFixturesOnly':True,'deviceCasesAreStatDoubles':True}))
