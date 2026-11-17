#!/usr/bin/env python3
"""Bounded live metadata meter anchored to no-follow directory descriptors."""
import os,stat,time,json,sys,errno
class Incomplete(RuntimeError):
 def __init__(self,message,code='non-race-incomplete',retryable=False):super().__init__(message);self.code=code;self.retryable=retryable
def sample_once(root,deadline,hook=None):
 start=time.monotonic();logical=allocated=members=0;frames=[];reason=None;failure_code=None;retryable=False
 def check(c,message,code='non-race-incomplete',retryable=False):
  if not c:raise Incomplete(message,code,retryable)
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
   check(members<2000000,'live work meter entry bound')
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
    members+=1;allocated+=opened.st_blocks*512;push(child,(frame['fd'],entry.name,opened.st_dev,opened.st_ino))
   else:
    try:after=os.stat(entry.name,dir_fd=frame['fd'],follow_symlinks=False)
    except OSError as e:
     if e.errno==errno.ENOENT:raise Incomplete('entry vanished after metadata observation','entry-vanished-during-sample',True)
     raise Incomplete('entry metadata unavailable after observation')
    check((after.st_dev,after.st_ino,stat.S_IFMT(after.st_mode))==(before.st_dev,before.st_ino,stat.S_IFMT(before.st_mode)),'entry identity replaced during sample','entry-identity-replaced',True);members+=1;allocated+=after.st_blocks*512
    if stat.S_ISREG(after.st_mode):logical+=after.st_size
 except (Incomplete,OSError) as e:
  reason=str(e) if isinstance(e,Incomplete) else 'descriptor-based sample unavailable';failure_code=e.code if isinstance(e,Incomplete) else 'descriptor-operation-unavailable';retryable=e.retryable if isinstance(e,Incomplete) else False
 finally:
  for frame in reversed(frames):frame['iterator'].close();os.close(frame['fd'])
 return {'members':members,'regularLogicalBytes':logical,'allocatedBytesWithHardlinkDoubleCounting':allocated,'elapsedSeconds':time.monotonic()-start,'samplingComplete':reason is None,'incompleteReason':reason,'incompleteCode':failure_code,'retryableDirectoryRace':retryable,'retryableFilesystemRace':retryable,'directoryTraversal':'descriptor-relative O_DIRECTORY|O_NOFOLLOW; original inode bindings rechecked','liveConcurrentProducerSnapshotConsistent':False}
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
