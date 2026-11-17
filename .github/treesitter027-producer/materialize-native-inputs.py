"""Data-only fixed-profile materialization for original native0.27.0 inputs."""
import hashlib,json,os,posixpath,re,shutil,stat,tarfile,tempfile
from pathlib import Path,PurePosixPath

MAX_MEMBERS=500000
MAX_EXPANDED=8*1024**3

def need(value,message):
 if not value:raise ValueError(message)

def digest(path):
 h=hashlib.sha256()
 with Path(path).open('rb') as stream:
  while True:
   body=stream.read(65536)
   if not body:break
   h.update(body)
 return h.hexdigest()

def safe(name):
 need(isinstance(name,str) and name and len(name.encode())<=4096 and not name.startswith('/') and '\\' not in name and not any(ord(c)<32 or ord(c)==127 for c in name),'Unsafe original member path')
 parts=name.rstrip('/').split('/');need(all(p not in ('','.','..') for p in parts),'Unsafe original path component');return '/'.join(parts)

def screen(archive,row):
 need(archive.is_file() and not archive.is_symlink() and archive.stat().st_size==row['bytes'] and digest(archive)==row['sha256'],'Original input archive identity differs')
 records={};total=0
 with tarfile.open(archive,'r:*') as opened:
  for member in opened:
   name=safe(member.name);need(name==row['archivePrefix'] or name.startswith(row['archivePrefix']+'/'),'Original archive prefix differs')
   need(name not in records and len(records)<MAX_MEMBERS and not member.issparse() and not member.mode&0o7000,'Duplicate/sparse/privileged original input or member cap')
   kind='directory' if member.isdir() else 'file' if member.isfile() else 'symlink' if member.issym() else 'other';need(kind!='other','Original input special/hardlink file requires an explicit reviewed mapping')
   need(0<=member.size<=512*1024**2,'Original member byte bound');total+=member.size;need(total<=MAX_EXPANDED,'Original expanded byte bound')
   record={'name':name,'kind':kind,'bytes':member.size,'mode':member.mode&0o777,'link':member.linkname if kind=='symlink' else None}
   if kind=='symlink':
    link=member.linkname;need(link and not link.startswith('/') and '\\' not in link and not any(ord(c)<32 or ord(c)==127 for c in link),'Unsafe original link')
    target=posixpath.normpath(posixpath.join(posixpath.dirname(name),link));need(target==row['archivePrefix'] or target.startswith(row['archivePrefix']+'/'),'Original link escapes archive root');record['target']=target
   records[name]=record
 for record in records.values():
  for parent in PurePosixPath(record['name']).parents:
   if str(parent)=='.':continue
   need(parent.as_posix() not in records or records[parent.as_posix()]['kind']=='directory','Original traversal parent is a file or link')
  if record['kind']=='symlink':
   seen=set();target=record['target']
   while True:
    need(target in records and target not in seen and len(seen)<32,'Missing/cyclic original link target');seen.add(target);physical=records[target]
    if physical['kind'] in ('file','directory'):break
    target=physical['target']
   record['physical']=target
 return records,total

def map_target(name,row):
 role=row['materialization'];parts=name.split('/')
 if role.get('component') is not None:
  if len(parts)<2 or parts[1]!=role['component'] or len(parts)>2 and parts[2]=='manifest.in':return None
 relative=parts[role['strip']:]
 if not relative:return None
 return role['destination']+'/'+safe('/'.join(relative))

def plan(archives,rows):
 selected={};screens={};expanded=0;members=0
 for row in rows:
  if row['materialization'].get('originalInstallerOnly'):continue
  archive=archives[row['id']];records,count=screen(archive,row);screens[row['id']]=records;expanded+=count;members+=len(records);need(expanded<=MAX_EXPANDED and members<=MAX_MEMBERS,'Whole input materialization bound')
  for name,record in records.items():
   if 'cargoPackageChecksum' in row:need(record['kind'] in ('directory','file'),'Original Cargo registry archive may not contain links')
   target=map_target(name,row)
   if target is None:continue
   if target in selected:
    need(record['kind']==selected[target]['kind']=='directory','Overlapping original component destinations');continue
   mapped={**record,'destination':target,'input':row['id'],'source':name}
   if record['kind']=='symlink':
    physical=map_target(record['physical'],row);need(physical is not None,'Selected link target was not selected');mapped['physicalDestination']=physical
    literal=posixpath.normpath(posixpath.join(posixpath.dirname(target),record['link']));need(literal==physical or map_target(record['target'],row)==literal,'Original symlink mapping changes target')
   selected[target]=mapped
 for name,record in selected.items():
  for parent in PurePosixPath(name).parents:
   if str(parent)=='.':continue
   need(str(parent) not in selected or selected[str(parent)]['kind']=='directory','Mapped traversal parent is not a directory')
  if record['kind']=='symlink':need(record['physicalDestination'] in selected and selected[record['physicalDestination']]['kind'] in ('file','directory'),'Mapped physical target is absent')
 return selected,{'inputMembers':members,'expandedTarMemberBytes':expanded}

def prepare(archives,rows,destination):
 need(not os.path.lexists(destination),'Fresh materialization destination required');selected,bounds=plan(archives,rows)
 destination.parent.mkdir(parents=True,exist_ok=True);need(destination.parent.resolve(strict=True)==destination.parent,'Physical owned destination parent required');stage=Path(tempfile.mkdtemp(prefix='tree027-input-stage-',dir=destination.parent));ledger=[]
 try:
  directories=set()
  for name,record in selected.items():
   directories.update(str(p) for p in PurePosixPath(name).parents if str(p)!='.')
   if record['kind']=='directory':directories.add(name)
  for name in sorted(directories,key=lambda x:(x.count('/'),x)):(stage/name).mkdir(mode=0o755,exist_ok=True)
  for row in rows:
   if row['materialization'].get('originalInstallerOnly'):continue
   with tarfile.open(archives[row['id']],'r:*') as opened:
    for member in opened:
     target=map_target(safe(member.name),row)
     if target not in selected or selected[target]['kind']!='file':continue
     record=selected[target];path=stage/target;need(path.parent.resolve(strict=True)==path.parent,'Materialized parent became a link');h=hashlib.sha256();remaining=member.size;fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
     with os.fdopen(fd,'wb') as sink,opened.extractfile(member) as source:
      while remaining:
       body=source.read(min(65536,remaining));need(body,'Short original member');sink.write(body);h.update(body);remaining-=len(body)
     path.chmod(0o555 if member.mode&0o111 else 0o444);ledger.append({'path':target,'input':row['id'],'source':member.name,'bytes':member.size,'sha256':h.hexdigest(),'readOnlyCopyMode':oct(stat.S_IMODE(path.stat().st_mode))})
  for name,record in selected.items():
   if record['kind']=='symlink':(stage/name).symlink_to(record['link'])
  for name,record in selected.items():
   if record['kind']=='symlink':need((stage/name).resolve(strict=True)==stage/record['physicalDestination'],'Physical copied symlink differs');ledger.append({'path':name,'type':'symlink','target':record['link'],'physicalTarget':record['physicalDestination']})
  for row in rows:
   if 'cargoPackageChecksum' not in row:continue
   prefix=row['materialization']['destination'];need(re.fullmatch(r'[a-f0-9]{64}',row['cargoPackageChecksum']),'Original Cargo package checksum required')
   files={record['path'][len(prefix)+1:]:record['sha256'] for record in ledger if record.get('input')==row['id'] and record['path'].startswith(prefix+'/')}
   need(files and '.cargo-checksum.json' not in files,'Original Cargo payload/checksum collision');body=(json.dumps({'files':files,'package':row['cargoPackageChecksum']},sort_keys=True,separators=(',',':'))+'\n').encode();file=stage/prefix/'.cargo-checksum.json'
   with file.open('xb') as sink:sink.write(body)
   file.chmod(0o444);ledger.append({'path':prefix+'/.cargo-checksum.json','type':'first-party-original-Cargo-checksum','sha256':hashlib.sha256(body).hexdigest()})
  for name in sorted(directories,key=lambda x:-x.count('/')):(stage/name).chmod(0o555)
  for row in rows:
   if not row['materialization'].get('originalInstallerOnly'):need(digest(archives[row['id']])==row['sha256'],'Original archive changed during materialization')
  stage.chmod(0o555);os.rename(stage,destination);return {'materialized':True,'ownerUID':os.getuid(),'allSourceAndSDKCodeUnexecuted':True,'nativeExecutionGranted':False,'bounds':bounds,'files':ledger}
 except BaseException:
  if stage.exists():
   for path in stage.rglob('*'):
    if path.is_dir() and not path.is_symlink():path.chmod(0o700)
   shutil.rmtree(stage)
  raise
