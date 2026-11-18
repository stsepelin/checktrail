"""Future startup-only frozen cohort gate, before importing any controller module.
The manifest hash must come from a separately reviewed workflow startup. This
helper cannot infer operator authorization or turn a model argument into trust.
"""
from pathlib import Path
import argparse,hashlib,json,os,re,runpy,stat,sys

def need(value,message):
 if not value:raise ValueError(message)

def verify(root,manifest,expected):
 need(root==root.resolve(strict=True) and root.stat().st_uid==0 and stat.S_IMODE(root.stat().st_mode)==0o555,'Physical protected root-owned controller directory');need(manifest==manifest.resolve(strict=True) and manifest.parent==root,'Physical in-controller manifest');s=manifest.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o444 and s.st_size<=1024**2,'Root immutable bounded cohort manifest');body=manifest.read_bytes();need(hashlib.sha256(body).hexdigest()==expected,'Reviewed frozen cohort manifest hash');records=json.loads(body);need(isinstance(records,list) and records,'Nonempty frozen cohort');seen=set()
 for row in records:
  name=row['file'];need(re.fullmatch(r'[a-zA-Z0-9_./-]+',name) and not name.startswith('/') and all(part not in ('','.','..') for part in name.split('/')) and name not in seen,'Canonical unique frozen controller path');seen.add(name);file=root/name;need(file==file.resolve(strict=True),'Frozen controller symlink refused');s=file.lstat();need(stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o444 and s.st_size==row['bytes'],'Frozen controller mode/owner/size');need(hashlib.sha256(file.read_bytes()).hexdigest()==row['sha256'],'Frozen controller body changed')
  for parent in file.parents:
   if parent==root.parent:break
   need(parent.stat().st_uid==0 and stat.S_IMODE(parent.stat().st_mode)==0o555,'Frozen controller parent protection')
 actual={p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() or p.is_symlink()};need(actual==seen|{manifest.name},'Frozen controller unexpected/missing files');return records

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--manifest',required=True);parser.add_argument('--manifest-sha256',required=True);parser.add_argument('producer_arguments',nargs=argparse.REMAINDER);args=parser.parse_args();need(os.getuid()==0,'Root reviewed startup only');root=Path(__file__).resolve().parent;verify(root,Path(args.manifest),args.manifest_sha256);need(args.producer_arguments and args.producer_arguments[0]=='observe','Explicit observer invocation only');sys.path.insert(0,str(root));sys.argv=[str(root/'producer.py'),*args.producer_arguments];runpy.run_path(str(root/'producer.py'),run_name='__main__')
if __name__=='__main__':main()
