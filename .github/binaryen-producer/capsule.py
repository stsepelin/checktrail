"""Finite Binaryen132 input capsule. No upstream imports or execution."""
import configparser,gzip,hashlib,json,os,re,stat,tarfile,unicodedata,zlib
from pathlib import Path

SELECTION='binaryen132-original-arm64-hosted-v1'
ROOTS=[
 ('binaryen132-main','.','WebAssembly/binaryen','79dfe6b412a3c22bfdb190ed6a4d79adf734db5d'),
 ('direct-gitlink-1','test/spec/testsuite','WebAssembly/testsuite','4b24564c844e3d34bf46dfcb3c774ee5163e31cc'),
 ('direct-gitlink-2','third_party/fuzztest','google/fuzztest','5bbbddfc241c8c87902d4a80cda5697dd8c20199'),
 ('direct-gitlink-3','third_party/googletest','google/googletest','e2239ee6043f73722e7aa812a459f54a28552929'),
 ('direct-gitlink-4','third_party/mimalloc','microsoft/mimalloc','fbd8b99c2b828428947d70fdc046bb55609be93e'),
 ('direct-gitlink-5','third_party/picosha2','okdshin/PicoSHA2','161cb3fc4170fa7a3eca9e582cebd27cc4d1fe29'),
 ('direct-gitlink-6','third_party/simde','simd-everywhere/simde','f3e8262173b7089db9a9d57a9ecef8dd07ad9c97'),
 ('simde-munit','third_party/simde/test/munit','nemequ/munit','da8f73412998e4f1adf1100dc187533a51af77fd'),
]
MAX_BODY=32*1024**2
MAX_TOTAL=512*1024**2
MAX_FILES=20000
HASH=re.compile('[a-f0-9]{64}\\Z')

def need(value,message):
 if not value:raise ValueError(message)

def sha(body):return hashlib.sha256(body).hexdigest()
def git_hash(kind,body):return hashlib.sha1(kind.encode()+b' '+str(len(body)).encode()+b'\0'+body).hexdigest()

def unique(pairs):
 result={}
 for key,value in pairs:
  need(key not in result,'Duplicate JSON key');result[key]=value
 return result

def json_data(body):return json.loads(body.decode('utf-8'),object_pairs_hook=unique)

def path_key(name):
 need(isinstance(name,str) and name and '\\' not in name and '\0' not in name and len(name.encode())<=4096,'Unsafe source path')
 parts=name.split('/')
 need(len(parts)<=64 and all(p and p not in ('.','..') and p.casefold()!='.git' for p in parts),'Unsafe source path component')
 return unicodedata.normalize('NFC',name).casefold()

def read_physical(path,maximum=MAX_BODY):
 path=Path(path);need(path.is_absolute() and path==path.resolve(),'Physical absolute file required')
 before=path.lstat();need(stat.S_ISREG(before.st_mode) and before.st_nlink==1 and before.st_size<=maximum,'Invalid bounded file')
 descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(descriptor,'rb') as stream:
  opened=os.fstat(stream.fileno());need((opened.st_dev,opened.st_ino,opened.st_size)==(before.st_dev,before.st_ino,before.st_size),'Input changed before open')
  body=stream.read(before.st_size+1)
 after=path.lstat()
 need(len(body)==before.st_size and (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),'Input changed while reading')
 return body

def pinned(path,pin):
 need(set(pin)=={'sha256','bytes'} and HASH.fullmatch(pin['sha256']) and type(pin['bytes']) is int and 0<=pin['bytes']<=MAX_BODY,'Invalid body pin')
 body=read_physical(path);need(len(body)==pin['bytes'] and sha(body)==pin['sha256'],'Body pin differs');return body

def tree_objects(root):
 """Encode every original tree from typed files and Gitlinks; refuse omitted data."""
 rows={};children={'':[]}
 for item in root['files']:
  name=item['path'];path_key(name);need(name not in rows,'Duplicate file');rows[name]=(item['mode'],item['gitBlob'])
 for item in root['gitlinks']:
  name=item['path'];path_key(name);need(name not in rows,'Duplicate Gitlink');rows[name]=('160000',item['commit'])
 for name in list(rows):
  parent=name.rpartition('/')[0]
  while parent:
   need(parent not in rows or rows[parent][0]=='040000','Non-directory source ancestor')
   rows.setdefault(parent,('040000',None));parent=parent.rpartition('/')[0]
 for name,(mode,identity) in rows.items():
  parent,_,leaf=name.rpartition('/');children.setdefault(parent,[]).append((leaf,name,mode,identity))
  if mode=='040000':children.setdefault(name,[])
 result={};by_path={}
 for folder in sorted(children,key=lambda x:(-x.count('/'),-len(x))):
  body=bytearray()
  for leaf,name,mode,identity in sorted(children[folder],key=lambda x:x[0].encode()+(b'/' if x[2]=='040000' else b'')):
   identity=by_path[name] if mode=='040000' else identity
   need(isinstance(identity,str) and re.fullmatch('[a-f0-9]{40}',identity),'Invalid Git object identity')
   body.extend(mode.lstrip('0').encode()+b' '+leaf.encode()+b'\0'+bytes.fromhex(identity))
  body=bytes(body);identity=git_hash('tree',body);result[identity]=body;by_path[folder]=identity
 need(by_path['']==root['tree'],'Canonical source tree differs')
 return result

def validate_manifest(manifest,objects,expected_roots=ROOTS):
 need(set(manifest)=={'schemaVersion','selection','roots','evidence'},'Unexpected manifest fields')
 need(manifest['schemaVersion']==1 and manifest['selection']==SELECTION,'Wrong selected producer')
 roots=manifest['roots'];need(len(roots)==len(expected_roots),'Missing selected source root')
 need([(x['id'],x['mountPath'],x['repository'],x['commit']) for x in roots]==expected_roots,'Selected roots differ')
 used=set();global_names={};trees={};files=0
 for root in roots:
  need(set(root)=={'id','mountPath','repository','commit','tree','rawCommit','files','gitlinks','notices'},'Unexpected source fields')
  commit=pinned_object(objects,root['rawCommit']);used.add(root['rawCommit']['sha256'])
  need(git_hash('commit',commit)==root['commit'] and commit.split(b'\n',1)[0]==b'tree '+root['tree'].encode(),'Raw commit identity/tree differs')
  names=set();folded=set();entries={}
  for entry in root['files']:
   need(set(entry)=={'path','mode','gitBlob','body'},'Unexpected file fields')
   key=path_key(entry['path']);need(key not in folded and entry['path'] not in names,'Case/normalization collision');folded.add(key);names.add(entry['path'])
   need(entry['mode'] in ('100644','100755','120000'),'Unsupported source mode')
   body=pinned_object(objects,entry['body']);used.add(entry['body']['sha256']);files+=1
   need(git_hash('blob',body)==entry['gitBlob'],'Canonical source blob differs')
   if entry['mode']=='120000':need(len(body)<=4096 and b'\0' not in body,'Invalid logical symlink')
   global_name=entry['path'] if root['mountPath']=='.' else root['mountPath']+'/'+entry['path']
   key=path_key(global_name);need(key not in global_names,'Cross-root source collision');global_names[key]=global_name
   entries[entry['path']]=entry
  for notice in root['notices']:
   need(set(notice)=={'path','body'} and notice['path'] in entries and notice['body']==entries[notice['path']]['body'],'Original notice binding differs')
  need(root['notices'],'Original notice inventory missing')
  trees[root['id']]=tree_objects(root)
 # Each Gitlink must resolve exactly once to the corresponding selected nested root.
 actual={}
 for root in roots:
  for link in root['gitlinks']:
   need(set(link)=={'path','commit'},'Unexpected Gitlink fields');path_key(link['path'])
   mount=link['path'] if root['mountPath']=='.' else root['mountPath']+'/'+link['path']
   need(mount not in actual,'Duplicate Gitlink mount');actual[mount]=link['commit']
 need(actual=={r['mountPath']:r['commit'] for r in roots[1:]},'Unresolved or foreign recursive Gitlink')
 need(files<=10000,'Source-file count ceiling')
 for pin in manifest['evidence']:
  pinned_object(objects,pin);used.add(pin['sha256'])
 need(used<=set(objects),'Required capsule body missing')
 configs={root['id']:submodule_config(root,objects,roots) for root in roots}
 return {'roots':len(roots),'files':files,'gitTrees':trees,'gitConfigs':configs,'usedObjects':used}

def pinned_object(objects,pin):
 need(isinstance(pin,dict) and set(pin)=={'bytes','sha256'} and HASH.fullmatch(pin.get('sha256','')) and type(pin['bytes']) is int and 0<=pin['bytes']<=MAX_BODY,'Invalid object pin')
 body=objects.get(pin['sha256']);need(isinstance(body,bytes) and len(body)==pin['bytes'] and sha(body)==pin['sha256'],'Missing or changed capsule object')
 return body

class Limited:
 def __init__(self,source):self.source=source;self.total=0
 def read(self,size=-1):
  need(0<=size<=MAX_BODY,'Unbounded capsule read');body=self.source.read(size);self.total+=len(body);need(self.total<=MAX_TOTAL,'Decoded capsule ceiling');return body

def load_capsule(path,identity,size,expected_roots=ROOTS):
 need(HASH.fullmatch(identity) and type(size) is int and 0<size<=64*1024**2,'Invalid capsule pin')
 raw=read_physical(path,64*1024**2);need(len(raw)==size and sha(raw)==identity,'Capsule wire identity differs')
 import io
 objects={};manifest=None;seen=set();count=0
 with gzip.GzipFile(fileobj=io.BytesIO(raw),mode='rb') as decoded:
  bounded=Limited(decoded)
  with tarfile.open(fileobj=bounded,mode='r|') as archive:
   for member in archive:
    count+=1;need(count<=MAX_FILES,'Capsule member ceiling')
    need(member.name not in seen and member.isfile() and not member.pax_headers and not member.issparse() and member.size<=MAX_BODY,'Unsafe capsule member')
    seen.add(member.name)
    need(member.name=='manifest.json' or re.fullmatch('objects/[a-f0-9]{64}',member.name),'Unexpected capsule path')
    stream=archive.extractfile(member);body=stream.read(member.size+1);need(len(body)==member.size,'Truncated capsule body')
    if member.name=='manifest.json':manifest=json_data(body)
    else:
     identity=member.name.split('/')[1];need(sha(body)==identity,'CAS member identity differs');objects[identity]=body
  # Force gzip trailer/trailing-data validation within the aggregate decoded bound.
  while bounded.read(65536):pass
 need(manifest is not None,'Capsule manifest missing')
 facts=validate_manifest(manifest,objects,expected_roots)
 return manifest,objects,facts

def write_git_object(directory,kind,body):
 identity=git_hash(kind,body);path=directory/'objects'/identity[:2]/identity[2:]
 path.parent.mkdir(parents=True,exist_ok=True)
 encoded=zlib.compress(kind.encode()+b' '+str(len(body)).encode()+b'\0'+body)
 if path.exists():need(path.read_bytes()==encoded,'Conflicting Git object')
 else:path.write_bytes(encoded);path.chmod(0o444)
 return identity

def submodule_config(root,objects,roots):
 if not root['gitlinks']:return ''
 row=next((x for x in root['files'] if x['path']=='.gitmodules'),None);need(row is not None,'Selected Gitlinks lack original .gitmodules')
 parser=configparser.ConfigParser(interpolation=None,strict=True);parser.read_string(pinned_object(objects,row['body']).decode())
 expected={x['path']:x['commit'] for x in root['gitlinks']};observed={};result=''
 for section in parser.sections():
  match=re.fullmatch('submodule "([A-Za-z0-9_./-]+)"',section);need(match is not None,'Unsupported original submodule name')
  path=parser[section].get('path');url=parser[section].get('url');need(path in expected and path not in observed,'Original submodule path differs')
  mount=path if root['mountPath']=='.' else root['mountPath']+'/'+path
  child=next(x for x in roots if x['mountPath']==mount)
  allowed='https://github.com/'+child['repository'];need(url in (allowed,allowed+'.git'),'Original submodule URL differs from selection')
  observed[path]=expected[path]
  result+='[submodule "'+match[1]+'"]\n url = '+url+'\n active = true\n'
 need(observed==expected,'Original .gitmodules inventory differs')
 return result

def materialize(manifest,objects,facts,destination,git,runner,control,expected_roots=ROOTS):
 """All metadata and targets validate before any source file is written."""
 destination=Path(destination);need(destination.parent==destination.parent.resolve() and not destination.exists(),'Fresh physical source destination required')
 stage=destination.with_name('.'+destination.name+'.next');need(not stage.exists(),'Source stage collision')
 facts=validate_manifest(manifest,objects,expected_roots)
 stage.mkdir(mode=0o755);stage.chmod(0o755)
 roots=manifest['roots'];all_files=[]
 for root in roots:
  mount=stage if root['mountPath']=='.' else stage/root['mountPath'];mount.mkdir(parents=True,exist_ok=True)
  for entry in root['files']:
   target=mount/entry['path'];target.parent.mkdir(parents=True,exist_ok=True)
   all_files.append((target,entry))
 # Symlinks are created after every ordinary file and directory; never traversed.
 for target,entry in all_files:
  if entry['mode']=='120000':continue
  target.write_bytes(pinned_object(objects,entry['body']));target.chmod(0o755 if entry['mode']=='100755' else 0o644)
 for target,entry in all_files:
  if entry['mode']=='120000':os.symlink(pinned_object(objects,entry['body']).decode('utf-8'),target)
 main_git=stage/'.git';main_git.mkdir()
 env={'PATH':'/usr/bin:/bin','GIT_CONFIG_NOSYSTEM':'1','GIT_CONFIG_GLOBAL':'/dev/null','GIT_TERMINAL_PROMPT':'0'}
 for root in roots:
  mount=stage if root['mountPath']=='.' else stage/root['mountPath']
  repo=main_git if root['mountPath']=='.' else main_git/'modules'/root['mountPath']
  repo.mkdir(parents=True,exist_ok=True)
  (repo/'refs'/'tags').mkdir(parents=True)
  (repo/'HEAD').write_text(root['commit']+'\n');(repo/'shallow').write_text(root['commit']+'\n')
  worktree=os.path.relpath(mount,repo)
  config='[core]\n repositoryformatversion = 0\n bare = false\n worktree = '+worktree+'\n hooksPath = '+str(control/'empty-hooks')+'\n fsmonitor = false\n precomposeunicode = true\n[protocol]\n allow = never\n[remote "origin"]\n url = https://github.com/'+root['repository']+'\n'
  (repo/'config').write_text(config+facts['gitConfigs'][root['id']])
  write_git_object(repo,'commit',pinned_object(objects,root['rawCommit']))
  for body in facts['gitTrees'][root['id']].values():write_git_object(repo,'tree',body)
  for entry in root['files']:write_git_object(repo,'blob',pinned_object(objects,entry['body']))
  if root['mountPath']=='.':(repo/'refs'/'tags'/'version_132').write_text(root['commit']+'\n')
  else:
   (mount/'.git').write_text('gitdir: '+os.path.relpath(repo,mount)+'\n');(mount/'.git').chmod(0o444)
  runner([str(git),'-C',str(mount),'read-tree','--reset','HEAD'],env=env,timeout=30)
 # mkdir/open modes are masked by umask; set the owned checkout's intended
 # readable/non-writable-to-build-UID modes explicitly after all Git writes.
 for folder,dirs,files in os.walk(stage,followlinks=False):
  Path(folder).chmod(0o755)
  for name in files:
   p=Path(folder)/name
   if not p.is_symlink() and (main_git in p.parents or p.name=='.git'):p.chmod(0o444)
 os.rename(stage,destination)
 return {'source':str(destination),'roots':len(roots),'gitMetadata':'exact original raw commits and trees; shallow selected revisions; root lightweight tag','publisherSignatureVerified':False}
