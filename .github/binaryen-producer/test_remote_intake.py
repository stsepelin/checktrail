"""Eight-root synthetic API/archive controls. No real network or upstream code."""
import copy,datetime,gzip,hashlib,io,json,os,signal,subprocess,sys,tarfile,tempfile,unittest
from pathlib import Path
from unittest import mock
sys.path.insert(0,str(Path(__file__).resolve().parent))
import remote_intake as r
import metadata_tools as m

class Response:
 def __init__(self,url,body):self.url=url;self.stream=io.BytesIO(body);self.status=200;self.headers={'Content-Length':str(len(body))}
 def geturl(self):return self.url
 def read(self,length):return self.stream.read(length)
 def __enter__(self):return self
 def __exit__(self,*args):self.stream.close()
class Opener:
 def __init__(self,bodies):self.bodies=bodies;self.calls=[]
 def open(self,request,timeout):self.calls.append(request.full_url);return Response(request.full_url,self.bodies[request.full_url])

def tree(leaves):
 structure={}
 for path,(mode,body) in leaves.items():
  node=structure;parts=path.split('/')
  for part in parts[:-1]:node=node.setdefault(part,{})
  node[parts[-1]]=(mode,body)
 rows=[]
 def emit(node,prefix):
  body=b''
  for name,value in sorted(node.items(),key=lambda x:x[0].encode()+(b'/' if isinstance(x[1],dict) else b'')):
   path=(prefix+'/' if prefix else '')+name
   if isinstance(value,dict):mode='040000';kind='tree';identity=emit(value,path);size=None
   else:mode,content=value;kind='commit' if mode=='160000' else 'blob';identity=content if kind=='commit' else m.git_hash('blob',content);size=None if kind=='commit' else len(content)
   body+=mode.lstrip('0').encode()+b' '+name.encode()+b'\0'+bytes.fromhex(identity)
   item={'path':path,'mode':mode,'type':kind,'sha':identity}
   if size is not None:item['size']=size
   rows.append(item)
  return m.git_hash('tree',body)
 root=emit(structure,'');return {'sha':root,'truncated':False,'tree':rows}

def fixture():
 policy=json.loads((Path(__file__).parent/'selection.json').read_text());rows=copy.deepcopy(policy['sources']);bodies={};raw=[];trees=[]
 for index in reversed(range(8)):
  leaves={'LICENSE':('100644',('Original synthetic notice '+str(index)+'\n').encode()),'data.txt':('100644',('inert synthetic '+str(index)).encode())}
  if index==0:
   for child in rows[1:7]:leaves[child['mountPath']]=('160000',child['commit'])
  elif index==6:leaves['test/munit']=('160000',rows[7]['commit'])
  value=tree(leaves);row=rows[index];row['rootTree']=value['sha'];message='Original synthetic commit '+str(index)+'\n'
  body=('tree '+row['rootTree']+'\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\n'+message).encode();row['commit']=m.git_hash('commit',body);row['rawCommitSHA256']=m.digest(body);row['rawCommitBytes']=len(body);raw.append(body)
  row['archiveURL']='https://codeload.github.com/'+row['repository']+'/tar.gz/'+('refs/tags/version_132' if index==0 else row['commit'])
  api={'sha':row['commit'],'tree':{'sha':row['rootTree']},'parents':[],'author':{'name':'Fixture','email':'fixture@example.invalid','date':'1970-01-01T00:00:01Z'},'committer':{'name':'Fixture','email':'fixture@example.invalid','date':'1970-01-01T00:00:01Z'},'message':message,'verification':{'reason':'unsigned','verified':False,'payload':None,'signature':None}}
  buffer=io.BytesIO();prefix=row['repository'].split('/')[1]+'-'+('version_132' if index==0 else row['commit'])
  with tarfile.open(fileobj=buffer,mode='w',format=tarfile.USTAR_FORMAT) as archive:
   for entry in [{'path':'','type':'tree'},*value['tree']]:
    item=tarfile.TarInfo(prefix+('/'+entry['path'] if entry['path'] else '')+('/' if entry['type'] in ('tree','commit') else ''))
    if entry['type'] in ('tree','commit'):item.type=tarfile.DIRTYPE;item.mode=0o755;archive.addfile(item)
    else:content=leaves[entry['path']][1];item.mode=0o644;item.size=len(content);archive.addfile(item,io.BytesIO(content))
  wire=gzip.compress(buffer.getvalue(),mtime=0);row['archiveSHA256']=m.digest(wire);row['archiveBytes']=len(wire)
  commit_url,tree_url,archive_url=r.urls(row);bodies[commit_url]=json.dumps(api).encode();bodies[tree_url]=json.dumps(value).encode();bodies[archive_url]=wire;trees.append(value)
 policy['sources']=rows;return policy,json.dumps(policy).encode(),bodies

class Controls(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='synthetic-',dir=Path(__file__).parent);self.root=Path(self.temp.name)
  self.patch=mock.patch.object(m.urllib.request,'build_opener',side_effect=AssertionError('Real network forbidden in synthetic controls'));self.patch.start();self.addCleanup(self.patch.stop)
 def tearDown(self):self.temp.cleanup()
 def test_all_eight_sources_twentyfour_gets_raw_objects_and_nested_binding(self):
  policy,body,bodies=fixture();opener=Opener(bodies);out=self.root/'out';result=r.run(policy,body,out,opener)
  self.assertEqual(result['state'],'eight-root-custody-verified-not-producer-complete');self.assertEqual(len(opener.calls),24);self.assertEqual(len(set(opener.calls)),24)
  self.assertEqual(result['actualRequestsAndBytes']['blobRequests'],0);self.assertFalse(result['producerComplete']);self.assertFalse(result['sourceCodeExecuted']);self.assertFalse(result['gateAComplete'])
  parent=(out/'parent/TERMINAL.json').read_bytes();nested=json.loads((out/'nested/TERMINAL.json').read_bytes());self.assertEqual(nested['binding']['parentTerminalSHA256'],m.digest(parent));self.assertEqual(nested['nestedGitlinks'],[])
  raw=json.loads((out/'raw-commits/RESULT.json').read_bytes());self.assertEqual(len(raw['rawCommits']),8)
  for selected in policy['sources']:
   content=(out/'raw-commits'/(selected['commit']+'.raw')).read_bytes();self.assertEqual(m.git_hash('commit',content),selected['commit']);self.assertEqual(m.digest(content),selected['rawCommitSHA256'])
 def test_wrong_selection_pin_refuses_before_requests_and_valid_schema_is_bounded(self):
  policy,body,bodies=fixture();path=self.root/'selection.json';path.write_bytes(body)
  with self.assertRaisesRegex(ValueError,'Pinned file bytes differ'):r.load_selection(path,expected='0'*64,size=len(body))
  parsed,_=r.load_selection(path,expected=m.digest(body),size=len(body));self.assertEqual(len(parsed['sources']),8)
  bad=copy.deepcopy(policy);bad['sources'][2]['archiveURL']='https://example.invalid/inert';wire=json.dumps(bad).encode();path.write_bytes(wire)
  with self.assertRaisesRegex(ValueError,'Undeclared selected archive'):r.load_selection(path,expected=m.digest(wire),size=len(wire))
 def test_wrong_raw_commit_or_tree_or_archive_pin_stops_without_success(self):
  for kind in ['raw','tree','archive']:
   policy,body,bodies=fixture();opener=Opener(bodies)
   if kind=='raw':policy['sources'][0]['rawCommitSHA256']='0'*64
   elif kind=='tree':
    url=r.urls(policy['sources'][0])[1];value=json.loads(bodies[url]);value['sha']='f'*40;bodies[url]=json.dumps(value).encode()
   else:policy['sources'][0]['archiveSHA256']='0'*64
   out=self.root/kind
   with self.subTest(kind=kind),self.assertRaises(ValueError):r.run(policy,body,out,opener)
   self.assertEqual(json.loads((out/'INTAKE.json').read_bytes())['state'],'incomplete')
   self.assertLessEqual(len(opener.calls),3)
 def test_new_nested_pointer_is_never_followed(self):
  policy,body,bodies=fixture();url=r.urls(policy['sources'][6])[1];value=json.loads(bodies[url]);value['tree'].append({'path':'extra','mode':'160000','type':'commit','sha':'f'*40});bodies[url]=json.dumps(value).encode();opener=Opener(bodies)
  with self.assertRaisesRegex(ValueError,'Root tree differs'):r.run(policy,body,self.root/'out',opener)
  self.assertFalse(any('f'*40 in url for url in opener.calls));self.assertLess(len(opener.calls),24)
 def test_shared_request_and_http_budgets_apply_across_parent_and_nested(self):
  policy,body,bodies=fixture();opener=Opener(bodies)
  with mock.patch.dict(r.LIMITS,{'newRequests':21}),self.assertRaisesRegex(ValueError,'Request ceiling'):r.run(policy,body,self.root/'out',opener)
  self.assertEqual(len(opener.calls),21)
  parent=json.loads((self.root/'out/parent/TERMINAL.json').read_bytes());self.assertEqual(parent['state'],'seven-root-custody-verified-not-producer-complete')
  self.assertEqual(json.loads((self.root/'out/INTAKE.json').read_bytes())['state'],'incomplete')
 def test_late_reread_withholds_top_success(self):
  class Clock:
   value=0
   def __call__(self):return self.value
  clock=Clock();original=m.Store.reread
  def late(store):value=original(store);clock.value=601;return value
  policy,body,bodies=fixture();out=self.root/'out'
  with mock.patch.object(m.Store,'reread',late),self.assertRaisesRegex(ValueError,'Terminal whole intake deadline'):r.run(policy,body,out,Opener(bodies),clock)
  self.assertFalse((out/'INTAKE.json').exists());self.assertEqual(json.loads((out/'INTAKE-PENDING.json').read_bytes())['state'],'incomplete')
 def test_outer_supervisor_rejects_late_zero_and_has_no_competing_alarm(self):
  out=self.root/'out';out.mkdir();(out/'INTAKE.json').write_text(json.dumps({'state':'eight-root-custody-verified-not-producer-complete'}));values=iter([0,1,601]);calls=[];alarm=signal.getsignal(signal.SIGALRM)
  def runner(command,**options):calls.append((command,options));return subprocess.CompletedProcess(command,0)
  self.assertEqual(r.supervise('selection.json',out,runner=runner,clock=lambda:next(values)),124);self.assertFalse((out/'INTAKE.json').exists());self.assertEqual(signal.getsignal(signal.SIGALRM),alarm)
  command,options=calls[0];self.assertEqual(command[:4],[sys.executable,'-I','-B','-c']);self.assertEqual(options,{'timeout':599,'check':False})
 def test_supervisor_requires_complete_physical_selected_receipt_after_zero_exit(self):
  out=self.root/'out';out.mkdir();path=out/'INTAKE.json';valid={'state':'eight-root-custody-verified-not-producer-complete','selectionSHA256':r.SELECTION_SHA256,'sources':8,'sourceCodeExecuted':False,'producerComplete':False,'gateAComplete':False}
  values=iter([0,1,2]);path.write_text(json.dumps(valid));runner=lambda command,**kw:subprocess.CompletedProcess(command,0)
  self.assertEqual(r.supervise('selection.json',out,runner=runner,clock=lambda:next(values)),0)
  path.write_text(json.dumps({**valid,'sources':7}));values=iter([0,1,2])
  with self.assertRaisesRegex(ValueError,'without complete selected custody'):r.supervise('selection.json',out,runner=runner,clock=lambda:next(values))

if __name__=='__main__':unittest.main(verbosity=2)
