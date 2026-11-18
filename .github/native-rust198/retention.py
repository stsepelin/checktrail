"""Private-host-only retention. No keys, upload, release or export capabilities."""
from pathlib import Path
import hashlib,os,re,stat,tarfile,time
from admission import need

def identity(s):
 return (s.st_dev,s.st_ino,s.st_mode,s.st_uid,s.st_gid,s.st_nlink,s.st_size,s.st_mtime_ns,s.st_ctime_ns)

def catalog(roots,limits,clock=time.monotonic,deadline=None):
 rows=[];seen=set();total=0
 for label,root in roots.items():
  need(re.fullmatch('[a-z][a-z0-9-]{0,63}',label),'Fixed safe private-output label')
  need(root==root.resolve(strict=True) and root.is_dir(),'Physical private output root')
  for folder,dirs,files in os.walk(root,followlinks=False):
   for name in dirs:need(not (Path(folder)/name).is_symlink(),'Output directory symlink refused')
   for name in files:
    need(deadline is None or clock()<deadline,'Private output catalog deadline')
    p=Path(folder)/name;s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1,'Physical single-link output regular file');relative=label+'/'+p.relative_to(root).as_posix();need(relative not in seen and not any(ord(c)<32 or ord(c)==127 for c in relative),'Unique canonical retained member');seen.add(relative);total+=s.st_size;need(total<=limits['captureBytes'] and len(rows)<limits['captureFiles'],'Private retention byte/file bound');h=hashlib.sha256()
    with p.open('rb') as f:
     need(identity(os.fstat(f.fileno()))==identity(s),'Output opened endpoint changed')
     for b in iter(lambda:f.read(65536),b''):
      need(deadline is None or clock()<deadline,'Private output hash deadline');h.update(b)
     need(identity(os.fstat(f.fileno()))==identity(s),'Output changed while cataloging')
    need(identity(p.lstat())==identity(s),'Output endpoint changed while cataloging')
    rows.append({'member':relative,'file':str(p),'bytes':s.st_size,'sha256':h.hexdigest(),'physicalIdentity':list(identity(s))})
 need(rows,'Nonempty private output inventory');return rows

class HashedReader:
 def __init__(self,stream,row,clock,deadline):self.stream=stream;self.row=row;self.clock=clock;self.deadline=deadline;self.hash=hashlib.sha256();self.count=0
 def read(self,size=-1):
  need(self.clock()<self.deadline,'Private retention stream deadline');body=self.stream.read(size);self.count+=len(body);need(self.count<=self.row['bytes'],'Retained body exceeded catalog size');self.hash.update(body);return body
 def finish(self):need(self.count==self.row['bytes'] and self.hash.hexdigest()==self.row['sha256'],'Output changed during retention stream')

class BoundedWriter:
 def __init__(self,stream,maximum):self.stream=stream;self.maximum=maximum;self.count=0
 def write(self,body):
  need(self.count+len(body)<=self.maximum,'Private archive prewrite reservation exhausted');written=self.stream.write(body);self.count+=written;return written
 def tell(self):return self.count
 def flush(self):return self.stream.flush()

def readback_private(file,rows,maximum,clock=time.monotonic,deadline=None):
 s=file.lstat();need(file==file.resolve(strict=True) and stat.S_ISREG(s.st_mode) and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o400 and s.st_size<=maximum,'Physical bounded private archive');expected={r['member']:r for r in rows};seen=set();h=hashlib.sha256()
 with file.open('rb') as f:
  for body in iter(lambda:f.read(65536),b''):
   need(deadline is None or clock()<deadline,'Private archive hash deadline');h.update(body)
 with tarfile.open(file,mode='r:') as archive:
  for member in archive:
   need(deadline is None or clock()<deadline,'Private member readback deadline');need(member.isreg() and member.name in expected and member.name not in seen,'Unexpected/duplicate/nonregular private member');row=expected[member.name];need(member.size==row['bytes'] and member.mode==0o400,'Private member size/mode');seen.add(member.name);body=archive.extractfile(member);digest=hashlib.sha256();count=0
   for part in iter(lambda:body.read(65536),b''):
    need(deadline is None or clock()<deadline,'Private member hash deadline');count+=len(part);need(count<=row['bytes'],'Private member overrun');digest.update(part)
   need(count==row['bytes'] and digest.hexdigest()==row['sha256'],'Private retained-member hash mismatch')
 need(seen==set(expected),'Private members incomplete');need(identity(file.lstat())==identity(s),'Private archive changed during independent readback');return {'bytes':s.st_size,'sha256':h.hexdigest(),'membersVerified':len(seen),'allMemberBodiesRehashed':True}

def retain_private(roots,destination,limits,quiescence,clock=time.monotonic):
 need(quiescence.get('allBuildUidProcessesStopped') is True,'No trusted retention before build-UID quiescence');started=clock();deadline=started+600;rows=catalog(roots,limits,clock,deadline);need(not os.path.lexists(destination),'Fresh private retention destination');part=destination.with_name(destination.name+'.unaccepted');need(not os.path.lexists(part),'Preserve prior retention failure');reserved=sum(r['bytes']+1024 for r in rows)+1024*1024;need(reserved<=limits['captureBytes'],'Pre-reserved TAR framing/output bound');need(destination.parent==destination.parent.resolve(strict=True),'Physical private retention parent')
 with part.open('xb') as raw:
  os.fchmod(raw.fileno(),0o600);bounded=BoundedWriter(raw,reserved)
  with tarfile.open(fileobj=bounded,mode='w',format=tarfile.USTAR_FORMAT) as archive:
   for row in rows:
    need(clock()<deadline,'Private retention deadline');p=Path(row['file']);s=p.lstat();need(list(identity(s))==row['physicalIdentity'],'Output changed before retention');info=tarfile.TarInfo(row['member']);info.size=row['bytes'];info.mode=0o400
    with p.open('rb') as body:
     need(identity(os.fstat(body.fileno()))==identity(s),'Retained opened endpoint changed');reader=HashedReader(body,row,clock,deadline);archive.addfile(info,reader);reader.finish();need(identity(os.fstat(body.fileno()))==identity(s),'Output changed while retaining')
    need(identity(p.lstat())==identity(s),'Retained output endpoint changed')
  raw.flush();os.fsync(raw.fileno())
 need(clock()<deadline and part.stat().st_size<=reserved<=limits['captureBytes'],'Private archive deadline/bound');part.chmod(0o400);proof=readback_private(part,rows,reserved,clock,deadline);need(clock()<deadline,'Late private archive readback');part.rename(destination)
 if clock()>=deadline:
  destination.rename(part);raise ValueError('Late private retention commit revoked')
 return {'privateLocalRetentionComplete':True,'file':str(destination),**proof,'members':rows,'elapsedSeconds':clock()-started,'encryptionOrExportPerformed':False,'notAPublishedArtifact':True}
