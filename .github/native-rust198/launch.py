"""Future startup-only frozen cohort gate, before importing any controller module.
The manifest hash must come from a separately reviewed workflow startup. This
helper cannot infer operator authorization or turn a model argument into trust.
"""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,re,stat,sys,types

def need(value,message):
 if not value:raise ValueError(message)

def held(file,refusal,maximum):
 """Bytes and status of one root-owned immutable single-link file, read through one
 descriptor; the controller later runs these bytes and never reopens the path."""
 try:fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except OSError as error:raise ValueError(refusal) from error
 try:
  s=os.fstat(fd);need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o444 and s.st_size<=maximum,refusal);body=bytearray()
  while len(body)<=maximum:
   piece=os.read(fd,min(65536,maximum+1-len(body)))
   if not piece:break
   body.extend(piece)
  after=os.fstat(fd);need(len(body)==s.st_size and (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns),refusal)
 finally:os.close(fd)
 return bytes(body),s

def verify(root,manifest,expected,bodies=None):
 need(root==root.resolve(strict=True) and root.stat().st_uid==0 and stat.S_IMODE(root.stat().st_mode)==0o555,'Physical protected root-owned controller directory');need(manifest==manifest.resolve(strict=True) and manifest.parent==root,'Physical in-controller manifest');body,_=held(manifest,'Root immutable bounded cohort manifest',1024**2);need(hashlib.sha256(body).hexdigest()==expected,'Reviewed frozen cohort manifest hash');records=json.loads(body);need(isinstance(records,list) and records,'Nonempty frozen cohort');seen=set()
 for row in records:
  name=row['file'];need(re.fullmatch(r'[a-zA-Z0-9_./-]+',name) and not name.startswith('/') and all(part not in ('','.','..') for part in name.split('/')) and name not in seen,'Canonical unique frozen controller path');seen.add(name);file=root/name;need(file==file.resolve(strict=True),'Frozen controller symlink refused');content,s=held(file,'Frozen controller mode/owner/size',row['bytes']);need(s.st_size==row['bytes'],'Frozen controller mode/owner/size');need(hashlib.sha256(content).hexdigest()==row['sha256'],'Frozen controller body changed')
  if bodies is not None:bodies[name]=content
  for parent in file.parents:
   if parent==root.parent:break
   need(parent.stat().st_uid==0 and stat.S_IMODE(parent.stat().st_mode)==0o555,'Frozen controller parent protection')
 actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()};need(actual==seen|{manifest.name},'Frozen controller unexpected/missing files');return records

class VerifiedModules:
 """Import finder and loader for top-level controller modules, serving verified bytes."""
 def __init__(self,root,bodies):self.root=root;self.bodies=bodies
 def find_spec(self,name,path=None,target=None):
  if path is not None or name+'.py' not in self.bodies:return None
  return importlib.util.spec_from_file_location(name,str(self.root/(name+'.py')),loader=self)
 def create_module(self,spec):return None
 def exec_module(self,module):exec(compile(self.get_data(module.__file__),module.__file__,'exec'),module.__dict__)
 def get_data(self,path):
  name=Path(path).relative_to(self.root).as_posix();need(name in self.bodies,'Verified controller body');return self.bodies[name]

def run_verified(root,bodies,arguments):
 # A module imported before verification would be reused instead of the verified bytes.
 need(not [name for name in bodies if name.endswith('.py') and '/' not in name and name!='producer.py' and name[:-3] in sys.modules],'Controller module imported before cohort verification')
 modules=VerifiedModules(root,bodies);main=types.ModuleType('__main__');main.__file__=str(root/'producer.py');main.__loader__=modules
 sys.meta_path.insert(0,modules);sys.path.insert(0,str(root));sys.argv=[main.__file__,*arguments];sys.modules['__main__']=main
 exec(compile(bodies['producer.py'],main.__file__,'exec'),main.__dict__)

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--manifest',required=True);parser.add_argument('--manifest-sha256',required=True);parser.add_argument('producer_arguments',nargs=argparse.REMAINDER);args=parser.parse_args();need(os.getuid()==0,'Root reviewed startup only');root=Path(__file__).resolve().parent;bodies={};verify(root,Path(args.manifest),args.manifest_sha256,bodies);need(args.producer_arguments and args.producer_arguments[0]=='observe','Explicit observer invocation only');run_verified(root,bodies,args.producer_arguments)
if __name__=='__main__':main()
