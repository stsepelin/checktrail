"""Pinned public original producer input bytes only; no unpacking or execution."""
import concurrent.futures,hashlib,json,os,ssl,threading,time,urllib.error,urllib.parse,urllib.request
from pathlib import Path

MAX_BYTES=1024**3
HOSTS={'static.rust-lang.org','nodejs.org','github.com','codeload.github.com','storage.googleapis.com','static.crates.io','registry.npmjs.org'}

def need(value,message):
 if not value:raise ValueError(message)

def rows(manifest):
 result=[]
 for group in ['primary','cargo','npm']:
  for source in manifest[group]:
   row=dict(source);row['kind']=group;row['id']=source.get('id') or 'cargo:'+source['name']+'@'+source['version'];result.append(row)
 return result

def validate(manifest):
 need(manifest['sourceCommit']=='6070dbfefd326bd735e5683eb128cc1b57dad0c0' and manifest['sourceTree']=='4014272399391bf64752dc1564f09be2ff4ed3a9','Only original native0.27.0 source is selected')
 need([len(manifest[k]) for k in ['primary','cargo','npm']]==[10,288,245] and len(manifest['npmLockAssociations'])==253,'Original input partition differs')
 inputs=rows(manifest);need(len({r['id'] for r in inputs})==543 and len({r['sha256'] for r in inputs})==543 and sum(r['bytes'] for r in inputs)==728978779<=MAX_BYTES,'Original input count/byte reservation differs')
 for row in inputs:
  u=urllib.parse.urlsplit(row['url']);need(u.scheme=='https' and u.hostname in HOSTS and u.netloc==u.hostname and not u.fragment,'Original HTTPS input endpoint required');need(len(row['sha256'])==64 and all(c in '0123456789abcdef' for c in row['sha256']) and 0<row['bytes']<=300*1024**2,'Original input pin/bound differs')
 return inputs

class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args):return None

def acquire(manifest,output,budget_class):
 inputs=validate(manifest);need(not output.exists() and not output.is_symlink(),'Fresh original download destination required');output.mkdir(mode=0o700);deadline=time.monotonic()+900;budget=budget_class({'archive':MAX_BYTES},deadline);records=[];failure=None;lock=threading.Lock()
 def worker(row):
  need(time.monotonic()<deadline,'Original intake deadline');url=row['url'];opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ssl.create_default_context()),NoRedirect());headers={'User-Agent':'Checktrail-original-native-custody/1','Accept-Encoding':'identity'};redirect=None
  try:response=opener.open(urllib.request.Request(url,headers=headers),timeout=min(30,max(.1,deadline-time.monotonic())))
  except urllib.error.HTTPError as error:
   need(row['id']=='wasmtime' and error.code==302,'Unexpected original input redirect');location=error.headers.get('Location','');target=urllib.parse.urlsplit(location);need(target.scheme=='https' and target.netloc=='release-assets.githubusercontent.com' and not target.fragment,'Unapproved original Wasmtime asset redirect');redirect={'code':302,'locationSHA256':hashlib.sha256(location.encode()).hexdigest(),'credentialsForwarded':False};response=opener.open(urllib.request.Request(location,headers=headers),timeout=min(30,max(.1,deadline-time.monotonic())))
  target=output/(row['sha256']+'.archive');part=output/(row['sha256']+'.part');received=0;h=hashlib.sha256()
  with response:
   need(response.status==200 and response.headers.get('Content-Encoding') in (None,'identity'),'Original exact identity response required');length=response.headers.get('Content-Length');need(length is None or int(length)==row['bytes'],'Original declared input size differs')
   if row.get('generation'):need(response.headers.get('x-goog-generation')==row['generation'],'Original pinned GCS generation differs')
   with part.open('xb') as stream:
    while True:
     chunk=budget.read(response,'archive',min(65536,row['bytes']-received+1))
     if not chunk:break
     need(received+len(chunk)<=row['bytes'],'Original response exceeds pinned size');stream.write(chunk);h.update(chunk);received+=len(chunk)
   need(received==row['bytes'] and h.hexdigest()==row['sha256'],'Original body size/SHA256 differs');part.chmod(0o444);part.rename(target)
  return {'id':row['id'],'kind':row['kind'],'file':str(target),'bytes':received,'sha256':h.hexdigest(),'originalURL':url,'redirect':redirect,'sourceOrSDKCodeExecuted':False}
 executor=concurrent.futures.ThreadPoolExecutor(max_workers=4);futures=[]
 try:
  futures=[executor.submit(worker,row) for row in inputs]
  for future in concurrent.futures.as_completed(futures):records.append(future.result())
 except Exception as error:
  budget.deadline=time.monotonic();failure={'type':type(error).__name__,'reason':str(error)[:512]}
  for future in futures:future.cancel()
 finally:
  executor.shutdown(wait=True,cancel_futures=True)
  ids={r['id'] for r in records};complete=time.monotonic()<deadline and failure is None and len(records)==len(ids)==len(inputs) and ids=={r['id'] for r in inputs};proof={'complete':complete,'records':sorted(records,key=lambda r:r['id']),'failure':failure,'actualTransportBytes':budget.used['archive'],'expectedBytes':sum(r['bytes'] for r in inputs),'sourceSDKPackageLifecycleNativeOrModelExecuted':False};(output/'CURATOR-RESULT.json').write_text(json.dumps(proof,sort_keys=True,indent=2)+'\n')
 need(complete,'Original native input acquisition incomplete');return proof
