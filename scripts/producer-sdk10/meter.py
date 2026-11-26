#!/usr/bin/env python3
"""Bounded live metadata meter anchored to no-follow directory descriptors."""
import array,errno,hashlib,json,os,stat,sys,time
MAX_ENTRIES=2000000
class Incomplete(RuntimeError):
 def __init__(self,message,code='non-race-incomplete',retryable=False):super().__init__(message);self.code=code;self.retryable=retryable
class InodeTable:
 """(dev, inode) to a 64-bit digest of the observed metadata, in three flat arrays.

 A dict of tuples costs about 370 bytes per inode, beyond the sampler's
 256 MiB container at MAX_ENTRIES; these arrays cost 24 bytes per slot at a
 0.75 load, allocated once. The digest is BLAKE2b of the exact metadata, at
 any integer width, so two different observations of one inode match only by
 a 64-bit collision.
 """
 def __init__(self,capacity=MAX_ENTRIES):
  self.capacity=capacity;self.size=capacity*4//3+1;self.count=0
  self.dev=array.array('Q',[0])*self.size;self.ino=array.array('Q',[0])*self.size;self.digest=array.array('Q',[0])*self.size
 def observe(self,dev,ino,observed):
  """None after recording a new inode; otherwise whether it matches its first observation."""
  value=int.from_bytes(hashlib.blake2b(repr(tuple(observed)).encode(),digest_size=8).digest(),'little');slot=((ino*0x9E3779B97F4A7C15)^dev)%self.size
  while self.ino[slot]:
   if self.ino[slot]==ino+1 and self.dev[slot]==dev:return self.digest[slot]==value
   slot=(slot+1)%self.size
  if self.count>=self.capacity:raise Incomplete('live work meter unique inode bound')
  self.dev[slot]=dev;self.ino[slot]=ino+1;self.digest[slot]=value;self.count+=1;return None
def sample_once(root,deadline,hook=None):
 start=time.monotonic();logical=allocated=unique_allocated=members=repeated=0;inodes=InodeTable();frames=[];reason=None;failure_code=None;retryable=False
 def check(c,message,code='non-race-incomplete',retryable=False):
  if not c:raise Incomplete(message,code,retryable)
 def stamp(s):return (s.st_mode,s.st_size,s.st_blocks,s.st_mtime_ns,s.st_ctime_ns,s.st_nlink)
 def account(s):
  nonlocal allocated,unique_allocated,members,repeated
  check(type(s.st_blocks) is int and s.st_blocks>=0,'inode allocated-block metadata unavailable')
  check(0<=s.st_dev<2**64 and 0<=s.st_ino<2**64-1,'inode identity within the table bounds');same=inodes.observe(s.st_dev,s.st_ino,stamp(s))
  if same is not None:
   check(same,'same inode metadata changed between observed paths','inode-observation-changed',True);repeated+=1
  else:unique_allocated+=s.st_blocks*512
  members+=1;allocated+=s.st_blocks*512
 def directory_error(error,message):
  if error.errno in [errno.ENOENT,errno.ENOTDIR,errno.ELOOP]:raise Incomplete(message,'directory-vanished-or-replaced',True)
  raise Incomplete('directory metadata unavailable','directory-metadata-unavailable')
 def binding_same(frame):
  binding=frame['binding']
  if binding is None:return
  parent,name,dev,ino=binding
  try:s=os.stat(name,dir_fd=parent,follow_symlinks=False)
  except OSError as e:directory_error(e,'directory binding disappeared during sample')
  check(stat.S_ISDIR(s.st_mode) and (s.st_dev,s.st_ino)==(dev,ino),'directory binding replaced during sample','directory-identity-replaced',True)
 def push(fd,binding):
  try:it=os.scandir(fd)
  except BaseException:os.close(fd);raise
  frames.append({'fd':fd,'iterator':it,'binding':binding})
 try:
  fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW);push(fd,None)
  while frames:
   check(time.monotonic()<deadline,'live work meter shared20-second wall bound','sampler-deadline');check(len(frames)<=256,'live work meter directory depth bound');frame=frames[-1];binding_same(frame)
   try:entry=next(frame['iterator'])
   except StopIteration:
    binding_same(frame);frame['iterator'].close();os.close(frame['fd']);frames.pop();continue
   check(members<MAX_ENTRIES,'live work meter entry bound')
   try:before=os.stat(entry.name,dir_fd=frame['fd'],follow_symlinks=False)
   except OSError as e:
    if e.errno==errno.ENOENT:raise Incomplete('entry vanished after enumeration','entry-vanished-during-sample',True)
    raise Incomplete('entry metadata unavailable during sample')
   if hook is not None:hook('after-stat',frame['fd'],entry.name,before)
   if stat.S_ISDIR(before.st_mode):
    try:child=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=frame['fd'])
    except OSError as e:directory_error(e,'directory replaced or unavailable before descriptor open')
    opened=os.fstat(child)
    if not stat.S_ISDIR(opened.st_mode) or (opened.st_dev,opened.st_ino)!=(before.st_dev,before.st_ino):os.close(child);raise Incomplete('directory identity changed before descriptor open','directory-identity-replaced',True)
    if hook is not None:hook('after-open',frame['fd'],entry.name,opened)
    # Verify the original parent entry before traversing the held descriptor.
    try:current=os.stat(entry.name,dir_fd=frame['fd'],follow_symlinks=False)
    except OSError as e:os.close(child);directory_error(e,'directory disappeared after descriptor open')
    if not stat.S_ISDIR(current.st_mode) or (current.st_dev,current.st_ino)!=(opened.st_dev,opened.st_ino):os.close(child);raise Incomplete('directory binding replaced after descriptor open','directory-identity-replaced',True)
    try:
     check(stamp(before)==stamp(opened)==stamp(current),'opened directory metadata changed during sample','inode-metadata-changed-during-sample',True);account(current)
    except BaseException:os.close(child);raise
    push(child,(frame['fd'],entry.name,opened.st_dev,opened.st_ino))
   else:
    try:after=os.stat(entry.name,dir_fd=frame['fd'],follow_symlinks=False)
    except OSError as e:
     if e.errno==errno.ENOENT:raise Incomplete('entry vanished after metadata observation','entry-vanished-during-sample',True)
     raise Incomplete('entry metadata unavailable after observation')
    check((after.st_dev,after.st_ino,stat.S_IFMT(after.st_mode))==(before.st_dev,before.st_ino,stat.S_IFMT(before.st_mode)),'entry identity replaced during sample','entry-identity-replaced',True)
    check(stamp(before)==stamp(after),'inode metadata changed during sample','inode-metadata-changed-during-sample',True);account(after)
    if stat.S_ISREG(after.st_mode):logical+=after.st_size
 except (Incomplete,OSError) as e:
  reason=str(e) if isinstance(e,Incomplete) else 'descriptor-based sample unavailable';failure_code=e.code if isinstance(e,Incomplete) else 'descriptor-operation-unavailable';retryable=e.retryable if isinstance(e,Incomplete) else False
 finally:
  for frame in reversed(frames):frame['iterator'].close();os.close(frame['fd'])
 return {'members':members,'regularLogicalBytes':logical,'allocatedBytesWithHardlinkDoubleCounting':allocated,'allocatedBytesUniqueInodes':unique_allocated,'uniqueObservedInodes':inodes.count,'repeatedInodePaths':repeated,'allocationAccounting':'stable-dev-inode-once','elapsedSeconds':time.monotonic()-start,'samplingComplete':reason is None,'incompleteReason':reason,'incompleteCode':failure_code,'retryableDirectoryRace':retryable,'retryableFilesystemRace':retryable,'directoryTraversal':'descriptor-relative O_DIRECTORY|O_NOFOLLOW; original inode bindings rechecked; mounted descendants traversed without a same-device filter','liveConcurrentProducerSnapshotConsistent':False}
def sample(root='/work',hook=None):
 start=time.monotonic();deadline=start+20;attempts=[]
 for number in [1,2]:
  if hook is not None:hook('before-attempt',None,None,number)
  result=sample_once(root,deadline,hook)
  attempts.append({'attempt':number,**result,'creditedToCompletedSample':result['samplingComplete']})
  if result['samplingComplete'] or not result['retryableDirectoryRace'] or number==2 or time.monotonic()>=deadline:break
 # Only the final COMPLETE attempt supplies credited counters. Failed attempts
 # remain explicit metadata and never accumulate into the completed sample.
 result.update({'attempts':attempts,'wholeSampleRetries':len(attempts)-1,'failedAttemptCountersCredited':False,'samplerSecondsMaximum':20,'elapsedSeconds':time.monotonic()-start})
 return result
if __name__=='__main__':
 result=sample();print(json.dumps(result));sys.exit(0 if result['samplingComplete'] else 2)
