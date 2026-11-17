"""Recover content-addressed commit bytes; accept only exact known Git IDs."""
import datetime,hashlib,itertools,re,time

def git_id(body):return hashlib.sha1(b'commit '+str(len(body)).encode()+b'\0'+body).hexdigest()
def timezone(minutes):
 sign='-' if minutes<0 else '+';minutes=abs(minutes)
 return sign+f'{minutes//60:02d}{minutes%60:02d}'
def recover(value,target,seconds=2,maximum=100000):
 assert re.fullmatch('[0-9a-f]{40}',target) and value['sha']==target
 start=time.monotonic();attempts=0
 def check(body,method):
  nonlocal attempts
  attempts+=1
  if attempts>maximum or time.monotonic()-start>=seconds:raise TimeoutError('Bounded commit reconstruction exhausted')
  if git_id(body)==target:return {'body':body,'method':method,'attempts':attempts,'sha256':hashlib.sha256(body).hexdigest(),'gitSHA1':target,'publisherSignatureLocallyVerified':False}
  return None
 verification=value.get('verification',{})
 payload=verification.get('payload');signature=verification.get('signature')
 if isinstance(payload,str) and isinstance(signature,str):
  assert len(payload.encode())<=262144 and len(signature.encode())<=65536
  headers,message=payload.split('\n\n',1)
  for sig in dict.fromkeys([signature,signature.rstrip('\n')]):
   for separator in ['\n\n','\n']:
    body=(headers+'\ngpgsig '+sig.replace('\n','\n ')+separator+message).encode()
    match=check(body,'exact signed payload/signature reconstruction')
    if match:return match
  return None
 assert verification.get('reason')=='unsigned' and payload is None and signature is None,'Unsupported absent signature metadata'
 tree=value['tree']['sha'];assert re.fullmatch('[0-9a-f]{40}',tree)
 parents=[p['sha'] for p in value['parents']];assert len(parents)<=16 and all(re.fullmatch('[0-9a-f]{40}',p) for p in parents)
 def identity(row):
  name,email=row['name'],row['email'];assert isinstance(name,str) and isinstance(email,str) and len(name)<=1024 and len(email)<=1024
  assert not any(x in name+email for x in '\r\n\0')
  date=datetime.datetime.fromisoformat(row['date'].replace('Z','+00:00'));assert date.tzinfo is not None
  return name+' <'+email+'> '+str(int(date.timestamp()))+' '
 author=identity(value['author']);committer=identity(value['committer'])
 message=value['message'];assert isinstance(message,str) and len(message.encode())<=65536
 prefix='tree '+tree+'\n'+''.join('parent '+p+'\n' for p in parents)
 messages=list(dict.fromkeys([message,message+'\n',message.rstrip('\n')]))
 shared=list(dict.fromkeys(['+0000','-0000']+[timezone(i) for i in range(-840,841)]))
 common=list(dict.fromkeys(['+0000','-0000']+[timezone(i) for i in range(-840,841,15)]))
 pairs=itertools.chain(((z,z) for z in shared),itertools.product(common,repeat=2))
 for a,c in pairs:
  for text in messages:
   body=(prefix+'author '+author+a+'\ncommitter '+committer+c+'\n\n'+text).encode()
   match=check(body,'API-field reconstruction with bounded original timezone search; exact Git object match')
   if match:return match
 return None
