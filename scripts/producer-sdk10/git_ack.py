"""Append-only public hash/signature ACK transport; no project bodies or trials."""
import base64,json,pathlib,re,time
from common import need,freeze,encoded,process,read_json,hash_file,digest
REPO='repos/stsepelin/checktrail/'
MESSAGE='Record durable SDK10 recovery acknowledgement'
def ack_path(ctx):return '.checktrail-recovery/ack-'+str(ctx['run'])+'-1-'+ctx['nonce']+'.json'
def binding(value,ctx):
 need(type(value) is dict and set(value)=={'ref','parent'} and value['ref']=='heads/diagnostic/sdk10-recovery-'+ctx['nonce'] and re.fullmatch('[0-9a-f]{40}',value['parent']),'preexisting dedicated diagnostic ACK ref/parent');return value
class AckAPI:
 def __init__(self,folder,deadline,channel,ctx,write=False):self.folder=pathlib.Path(folder);self.folder.mkdir(mode=0o700);self.deadline=deadline;self.channel=binding(channel,ctx);self.ctx=ctx;self.write=write;self.sequence=0
 def call(self,suffix,method='GET',payload=None):
  ref=self.channel['ref'];allowed_get=suffix=='git/ref/'+ref or re.fullmatch(r'git/(?:commits|trees|blobs)/[0-9a-f]{40}',suffix);allowed_write=method=='POST' and suffix in ['git/blobs','git/trees','git/commits'] or method=='PATCH' and suffix=='git/refs/'+ref
  need((method=='GET' and allowed_get and payload is None) or (self.write and allowed_write and type(payload) is dict),'exact reviewed public ACK API effects');self.sequence+=1;stem=self.folder/('ack-api-'+str(self.sequence).zfill(3));args=['gh','api','--hostname','github.com','--method',method,'--include',REPO+suffix]
  if payload is not None:
   body=encoded(payload);need(len(body)<=32768,'bounded public hash/signature ACK request');file=stem.with_suffix('.input.json');freeze(file,body);args+=['--input',str(file)]
  call_deadline=min(self.deadline,time.monotonic()+30);row,p=process(args,stem,call_deadline,131072);raw=p.read_bytes();parts=re.split(br'\r?\n\r?\n',raw,maxsplit=1);need(len(parts)==2,'public ACK response framing');status=re.match(br'HTTP/[12](?:\.[01])? ([0-9]{3})',parts[0]);need(status and int(status.group(1))==(201 if method=='POST' else 200) and row['exitCode']==0 and row['reason'] is None,'exact public ACK request completion');value=json.loads(parts[1]);need(time.monotonic()<call_deadline,'ACK response capture/parse exhausted original budget');return value
 def current(self):
  r=self.call('git/ref/'+self.channel['ref']);need(r.get('ref')=='refs/'+self.channel['ref'] and (r.get('object') or {}).get('type')=='commit','exact dedicated ACK commit ref');sha=r['object']['sha'];need(re.fullmatch('[0-9a-f]{40}',sha),'ACK ref exact commit identity');return sha
 def publish(self,ack):
  raw=encoded(ack);need(len(raw)<=16384,'bounded signed hash-only ACK body');need(self.current()==self.channel['parent'],'append-only expected original ACK parent; refuse moved ref');parent=self.call('git/commits/'+self.channel['parent']);tree=parent['tree']['sha'];need(re.fullmatch('[0-9a-f]{40}',tree),'pinned parent tree');blob=self.call('git/blobs','POST',{'encoding':'base64','content':base64.b64encode(raw).decode()});need(blob.get('sha')==__import__('hashlib').sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest(),'ACK original Git blob identity');created=self.call('git/trees','POST',{'base_tree':tree,'tree':[{'path':ack_path(self.ctx),'mode':'100644','type':'blob','sha':blob['sha']}]});commit=self.call('git/commits','POST',{'message':MESSAGE,'tree':created['sha'],'parents':[self.channel['parent']]});sha=commit['sha'];need(re.fullmatch('[0-9a-f]{40}',sha),'new ACK commit identity');self.call('git/refs/'+self.channel['ref'],'PATCH',{'sha':sha,'force':False});need(self.current()==sha,'published append-only ACK ref readback');found=self.fetch();need(found is not None and found['ack']==ack and found['commit']==sha,'public signed ACK immutable readback');return found
 def fetch(self):
  sha=self.current()
  if sha==self.channel['parent']:return None
  commit=self.call('git/commits/'+sha);need(commit.get('sha')==sha and [x['sha'] for x in commit.get('parents',[])]==[self.channel['parent']] and commit.get('message')==MESSAGE,'exact one append-only recovery commit');tree=commit['tree']['sha'];segments=ack_path(self.ctx).split('/')
  for index,name in enumerate(segments):
   listing=self.call('git/trees/'+tree);need(listing.get('truncated') is False and listing.get('sha')==tree and type(listing.get('tree')) is list,'complete nonrecursive ACK tree');matches=[x for x in listing['tree'] if x.get('path')==name];need(len(matches)==1,'unique exact ACK path');entry=matches[0]
   if index<len(segments)-1:need(entry.get('type')=='tree' and entry.get('mode')=='040000','exact ACK directory tree');tree=entry['sha']
   else:need(entry.get('type')=='blob' and entry.get('mode')=='100644','exact ACK blob mode');blob=self.call('git/blobs/'+entry['sha']);need(blob.get('encoding')=='base64' and 0<blob.get('size',0)<=16384,'bounded signed ACK blob');raw=base64.b64decode(blob['content'],validate=False);need(len(raw)==blob['size'] and __import__('hashlib').sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()==entry['sha'],'ACK exact Git blob physical identity');return {'commit':sha,'blob':entry['sha'],'ack':json.loads(raw),'rawSHA256':digest(raw)}
