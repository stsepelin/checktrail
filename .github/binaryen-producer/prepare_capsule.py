#!/usr/bin/env python3
"""Data-only adapter from verified remote custody records to a local capsule.

No network, extraction, Git invocation or source execution. Source objects and
raw commits stay in the runner's private workspace; this is not a publisher.
"""
import argparse,gzip,io,json,os,sys,tarfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from capsule import ROOTS,SELECTION,MAX_BODY,MAX_TOTAL,git_hash,json_data,need,read_physical,sha,validate_manifest

def prepare(parent,nested,raw_directory,output,expected_roots=ROOTS):
 parent=Path(parent).resolve();nested=Path(nested).resolve();raw_directory=Path(raw_directory).resolve();output=Path(output)
 need(output.is_absolute() and output.parent==output.parent.resolve() and not output.exists(),'Fresh physical capsule output required')
 stage=output.with_name('.'+output.name+'.next');need(not stage.exists(),'Capsule stage already exists')
 pbytes=read_physical(parent/'TERMINAL.json');nbytes=read_physical(nested/'TERMINAL.json');p=json_data(pbytes);n=json_data(nbytes)
 need(p['state']=='seven-root-custody-verified-not-producer-complete' and p['independentRetainedReread']['allRehashed'],'Parent custody incomplete')
 need(n['wholeTreeRecomputed'] is True and n['independentRetainedReread']['allRehashed'] and not n['nestedGitlinks'],'Nested custody incomplete')
 need(n['binding']['commit']==expected_roots[-1][3] and n['binding']['path']==expected_roots[-1][1].removeprefix(expected_roots[-2][1]+'/') and n['binding']['parentTerminalSHA256']==sha(pbytes),'Nested source binding differs')
 objects={};total=0
 def add(body):
  nonlocal total
  identity=sha(body)
  if identity not in objects:total+=len(body);need(total<=MAX_TOTAL,'Capsule aggregate body ceiling');objects[identity]=body
  return {'bytes':len(body),'sha256':identity}
 def import_pin(base,pin):
  need(pin['file']=='objects/'+pin['sha256'],'Unsafe captured object path')
  body=read_physical(base/pin['file']);need(len(body)==pin['bytes'] and sha(body)==pin['sha256'],'Captured object changed');return add(body)
 evidence=[add(pbytes),add(nbytes)]
 for base,value in [(parent,p),(nested,n)]:
  for pin in value['retainedObjectPins']:evidence.append(import_pin(base,pin))
 roots=[]
 for selected in expected_roots:
  ident,mount,repository,commit=selected
  if selected==expected_roots[-1]:
   captured={'retainedOrdinaryBodyIndex':n['retainedOrdinaryBodyIndex'],'typedGitlinkInventory':n['nestedGitlinks'],'noticePathAndBodyIndex':n['originalNoticeCandidates'],'declaredRootTree':n['rootTree']};base=nested
  else:
   captured=next(x for x in p['sources'] if x['id']==ident);base=parent
   need((captured['mountPath'],captured['repository'],captured['commit'])==(mount,repository,commit),'Parent source selection differs')
  raw=read_physical(raw_directory/(commit+'.raw'));need(git_hash('commit',raw)==commit,'Original raw commit missing or changed')
  files=[{'path':x['path'],'mode':x['mode'],'gitBlob':x['gitBlob'],'body':import_pin(base,x['retained'])} for x in captured['retainedOrdinaryBodyIndex']]
  notices=[{'path':x['path'],'body':import_pin(base,x['body'])} for x in captured['noticePathAndBodyIndex']]
  roots.append({'id':ident,'mountPath':mount,'repository':repository,'commit':commit,'tree':captured['declaredRootTree'],'rawCommit':add(raw),'files':files,'gitlinks':[{'path':x['path'],'commit':x['commit']} for x in captured['typedGitlinkInventory']],'notices':notices})
 manifest={'schemaVersion':1,'selection':SELECTION,'roots':roots,'evidence':list({x['sha256']:x for x in evidence}.values())}
 facts=validate_manifest(manifest,objects,expected_roots)
 manifest_body=(json.dumps(manifest,indent=2,sort_keys=True)+'\n').encode();need(len(manifest_body)<=MAX_BODY,'Capsule manifest ceiling')
 stage.mkdir(mode=0o700)
 class BoundedWriter:
  def __init__(self,stream):self.stream=stream;self.bytes=0
  def write(self,body):self.bytes+=len(body);need(self.bytes<=64*1024**2,'Compressed capsule ceiling');return self.stream.write(body)
  def flush(self):self.stream.flush()
 with (stage/'capsule.tar.gz').open('xb') as raw_stream:
  bounded=BoundedWriter(raw_stream)
  with gzip.GzipFile(filename='',fileobj=bounded,mode='wb',mtime=0) as encoded:
   with tarfile.open(fileobj=encoded,mode='w|',format=tarfile.USTAR_FORMAT) as archive:
    for name,body in [('manifest.json',manifest_body)]+[('objects/'+k,v) for k,v in sorted(objects.items())]:
     item=tarfile.TarInfo(name);item.mode=0o400;item.uid=0;item.gid=0;item.mtime=0;item.size=len(body);archive.addfile(item,io.BytesIO(body))
  raw_stream.flush();os.fsync(raw_stream.fileno())
 capsule=(stage/'capsule.tar.gz').read_bytes();receipt={'schemaVersion':1,'selection':SELECTION,'capsule':{'file':'capsule.tar.gz','bytes':len(capsule),'sha256':sha(capsule)},'manifestSHA256':sha(manifest_body),'roots':facts['roots'],'ordinaryFiles':facts['files'],'inputObjects':len(objects),'inputBodyBytes':total,'sourceExtracted':False,'producerExecuted':False,'fullOriginalNoticeClosure':False,'gateAComplete':False}
 with (stage/'CAPSULE.json').open('x') as stream:stream.write(json.dumps(receipt,indent=2)+'\n');stream.flush();os.fsync(stream.fileno())
 os.rename(stage,output)
 return receipt

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--parent',required=True);p.add_argument('--nested',required=True);p.add_argument('--raw-commits',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 print(json.dumps(prepare(a.parent,a.nested,a.raw_commits,a.output)))

if __name__=='__main__':main()
