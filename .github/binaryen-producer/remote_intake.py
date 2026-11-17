#!/usr/bin/env python3
"""Fixed eight-root Binaryen132 remote custody bridge. Data only, no source run."""
import argparse,hashlib,json,os,re,shutil,subprocess,sys,time,urllib.parse
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
import metadata_tools as m
from recover import recover

SELECTION_SHA256='33d419ee8fc76bcad488706a8f3ab731c1b02cad64f14e4f77c9b85ecdd13136'
SELECTION_BYTES=5034
LIMITS={'GitCommitMetadataPerResponseBytes':262144,'GitCommitMetadataRequests':8,
 'GitRecursiveTreePerResponseBytes':8*1024**2,'GitRecursiveTreeMetadataRequests':8,
 'canonicalBlobRestorationRequests':0,'canonicalBlobJSONPerResponseBytes':2*1024**2,
 'canonicalBlobDecodedPerBlobBytes':1024**2,'canonicalBlobDecodedAggregateBytes':0,
 'codeloadRequests':8,'compressedArchivePerResponseBytes':32*1024**2,'compressedArchiveAggregateBytes':64*1024**2,
 'allHTTPBodyAggregateBytes':100*1024**2,'allMetadataHTTPBodyAggregateBytes':32*1024**2,
 'archiveExpandedTarBytesPlusRestoredBlobDecodedBytes':512*1024**2,
 'newRequests':24,'wholeWallSeconds':600,'reserveSecondsForTerminalReceipts':30,'perRequestWallSeconds':45,
 'pathSegments':64,'pathUTF8Bytes':4096,'singleArchiveRegularBlobBytes':32*1024**2,'symlinkTargetBytes':4096,
 'tarMembersAcrossAllArchives':100000,'tarMembersPerArchive':50000}
IDS=['binaryen132-main',*['direct-gitlink-'+str(i) for i in range(1,7)],'nested-munit']

def load_selection(path,expected=SELECTION_SHA256,size=SELECTION_BYTES):
 path=Path(path);path=path if path.is_absolute() else Path.cwd()/path
 body=m.pinned_file({'file':str(path),'bytes':size,'sha256':expected});value=m.json_data(body)
 m.need(set(value)=={'schemaVersion','rootTag','sources','sourceCodeExecuted','producerComplete','publisherSignaturesLocallyVerified'},'Unexpected selection fields')
 m.need(value['schemaVersion']==1 and value['rootTag']=='version_132','Wrong selected release')
 rows=value['sources'];m.need(len(rows)==8 and [r['id'] for r in rows]==IDS,'Wrong source cohort')
 for row in rows:
  m.need(set(row)=={'id','repository','commit','rootTree','mountPath','archiveURL','archiveBytes','archiveSHA256','rawCommitBytes','rawCommitSHA256'},'Unexpected selected source fields')
  m.need(re.fullmatch('[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',row['repository']) and re.fullmatch('[a-f0-9]{40}',row['commit']) and re.fullmatch('[a-f0-9]{40}',row['rootTree']),'Malformed selected Git identity')
  for key in ['archiveSHA256','rawCommitSHA256']:m.need(re.fullmatch('[a-f0-9]{64}',row[key]),'Malformed selected byte pin')
  m.need(type(row['archiveBytes']) is int and 0<row['archiveBytes']<=32*1024**2 and type(row['rawCommitBytes']) is int and 0<row['rawCommitBytes']<=262144,'Invalid selected byte count')
  path=row['mountPath'];m.need(path=='.' if row is rows[0] else m.checked_path(path,LIMITS),'Invalid source mount')
  suffix='refs/tags/version_132' if row is rows[0] else row['commit']
  m.need(row['archiveURL']=='https://codeload.github.com/'+row['repository']+'/tar.gz/'+suffix,'Undeclared selected archive route')
 m.need(len({r['mountPath'] for r in rows})==8 and len({r['commit'] for r in rows})==8,'Duplicate selected source identity')
 return value,body

def urls(row):
 base='https://api.github.com/repos/'+row['repository']+'/git/'
 return [base+'commits/'+row['commit'],base+'trees/'+row['rootTree']+'?recursive=1',row['archiveURL']]

def pin(body):return {'bytes':len(body),'sha256':m.digest(body)}

def retained(store,p):return (store.root/p['file']).read_bytes()

def source(row,store,budget,client,raw_directory,raw_rows):
 commit_url,tree_url,archive_url=urls(row)
 cp=client.get(commit_url,'commit');value=m.json_data(retained(store,cp))
 m.need(value.get('sha')==row['commit'] and value.get('tree',{}).get('sha')==row['rootTree'],'Selected commit/root differs')
 remaining=LIMITS['wholeWallSeconds']-LIMITS['reserveSecondsForTerminalReceipts']-budget.elapsed()
 raw=recover(value,row['commit'],seconds=min(2,remaining),maximum=100000)
 m.need(raw is not None and len(raw['body'])==row['rawCommitBytes'] and raw['sha256']==row['rawCommitSHA256'],'Original raw commit bytes differ')
 m.need(raw['body'].split(b'\n',1)[0]==b'tree '+row['rootTree'].encode(),'Original raw commit tree differs')
 budget.tick();raw_pin=store.put(raw['body']);path=raw_directory/(row['commit']+'.raw')
 descriptor=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(descriptor,'wb') as stream:stream.write(raw['body']);stream.flush();os.fsync(stream.fileno())
 raw_rows.append({k:v for k,v in raw.items() if k!='body'}|{'id':row['id'],'file':path.name,'bytes':len(raw['body'])})
 tp=client.get(tree_url,'tree');rows=m.tree_projection(m.json_data(retained(store,tp)),row['rootTree'],LIMITS)
 ap=client.get(archive_url,'archive')
 m.need(ap['bytes']==row['archiveBytes'] and ap['sha256']==row['archiveSHA256'],'Selected archive bytes differ')
 suffix=urllib.parse.urlsplit(archive_url).path.rsplit('/',1)[1];prefix=row['repository'].split('/')[1]+'-'+suffix
 found=m.inspect_archive(store.root/ap['file'],prefix,rows,store,budget)
 ordinary={path:entry for path,entry in rows.items() if entry['type']=='blob'}
 m.need(set(found)==set(ordinary),'Archive omitted or added an ordinary canonical source')
 for name,item in found.items():
  expected=ordinary[name];m.need(item['gitBlob']==expected['sha'] and item['mode']==expected['mode'] and item['retained']['bytes']==expected['size'],'Archive canonical body/mode differs')
 notices=[{'repository':row['repository'],'path':name,'gitBlob':ordinary[name]['sha'],'body':found[name]['retained'],'knownOriginalPath':False,'outputProjectionRelationship':'unassessed'} for name in sorted(ordinary) if m.NOTICE.fullmatch(name.rsplit('/',1)[-1])]
 m.need(notices and all(x['body']['bytes']>0 for x in notices),'Original named notice candidate missing/empty')
 return {'id':row['id'],'repository':row['repository'],'commit':row['commit'],'mountPath':row['mountPath'],'state':'canonical-projection-verified-awaiting-final-reread','declaredRootTree':row['rootTree'],'canonicalRootTreeRecomputed':m.recompute_tree(rows,row['rootTree']),'wholeMetadataTreeRecomputed':True,'archiveWireIdentity':ap,'commitAPIMetadataIdentity':cp,'treeAPIMetadataIdentity':tp,'commitRawObjectIdentity':{'retainedOriginal':True,'gitSHA1':row['commit'],'body':raw_pin,'publisherSignatureLocallyVerified':False},'archiveProjectionOutcome':{'ordinaryBlobsObserved':len(found),'missingOrChangedCanonicalPaths':[],'exactOrdinaryProjection':True},'canonicalRestorationOperations':[],'ordinaryBlobCountAndBytes':{'count':len(ordinary),'bytes':sum(x['size'] for x in ordinary.values())},'typedGitlinkInventory':[{'path':name,'commit':item['sha'],'bodyAcquired':False} for name,item in rows.items() if item['type']=='commit'],'noticePathAndBodyIndex':notices,'retainedOrdinaryBodyIndex':[{'path':name,**found[name]} for name in sorted(ordinary)]}

def publish(store,name,value):
 """A late atomic rename never leaves an apparently successful top receipt."""
 try:store.json(name,value);store.guard()
 except BaseException:
  if value.get('state') in ['eight-root-custody-verified-not-producer-complete','nested-source-custody-verified-not-producer-complete']:(store.root/name).unlink(missing_ok=True)
  raise

def run(selection,selection_body,output,opener=None,clock=None):
 budget=m.Budget(LIMITS,clock=clock);top=m.Store(Path(output));top.budget=budget
 parent=m.Store(top.root/'parent');parent.budget=budget;nested=m.Store(top.root/'nested');nested.budget=budget
 raw_directory=top.root/'raw-commits';raw_directory.mkdir(mode=0o700)
 allowed={url for row in selection['sources'] for url in urls(row)}
 m.need(len(allowed)==24,'Selected requests are not unique')
 parent_client=m.Client(parent,budget,allowed,opener);nested_client=m.Client(nested,budget,allowed,opener)
 raw_rows=[];cohort={'schemaVersion':1,'selectionSHA256':m.digest(selection_body),'state':'incomplete','sourceCodeExecuted':False,'producerComplete':False,'fullOriginalNoticeClosure':False,'publisherSignaturesLocallyVerified':False,'gateAComplete':False}
 top.json('INTAKE-PENDING.json',cohort);top.json('INTAKE.json',cohort)
 try:
  roots=[]
  for row in selection['sources'][:7]:roots.append(source(row,parent,budget,parent_client,raw_directory,raw_rows))
  m.need({x['path']:x['commit'] for x in roots[0]['typedGitlinkInventory']}=={r['mountPath']:r['commit'] for r in selection['sources'][1:7]},'Selected main recursive Gitlink inventory differs')
  expected_nested=selection['sources'][7]
  actual=[]
  for root in roots[1:]:
   for link in root['typedGitlinkInventory']:actual.append((root['id'],root['mountPath']+'/'+link['path'],link['commit']))
  m.need(actual==[('direct-gitlink-6',expected_nested['mountPath'],expected_nested['commit'])],'Unselected or missing nested Gitlink')
  parent_pending={'schemaVersion':1,'state':'incomplete','sources':roots,'sourceExtracted':False,'projectCodeExecuted':False,'producerComplete':False,'fullOriginalNoticeClosure':False,'gateAComplete':False,'independentRetainedReread':{'assessed':False}}
  parent.json('TERMINAL-PENDING.json',parent_pending);parent.json('TERMINAL.json',parent_pending)
  reread=parent.reread();parent.guard()
  for root in roots:root['state']='canonical-custody-verified-not-producer-complete';parent.json('SOURCE-'+root['id']+'.json',root)
  parent_terminal={**parent_pending,'state':'seven-root-custody-verified-not-producer-complete','independentRetainedReread':reread,'retainedObjectPins':list(parent.pins.values()),'actualRequestsAndBytes':dict(budget.counts)}
  publish(parent,'TERMINAL.json',parent_terminal)
  parent_body=(parent.root/'TERMINAL.json').read_bytes();parent.guard()
  row=source(expected_nested,nested,budget,nested_client,raw_directory,raw_rows);m.need(not row['typedGitlinkInventory'],'Further unselected recursive Gitlink')
  nr=nested.reread();nested.guard()
  nt={'schemaVersion':1,'state':'nested-source-custody-verified-not-producer-complete','binding':{'parentSource':'direct-gitlink-6','parentTerminalSHA256':m.digest(parent_body),'repository':expected_nested['repository'],'path':'test/munit','commit':expected_nested['commit']},'rootTree':row['declaredRootTree'],'wholeTreeRecomputed':True,'archive':row['archiveWireIdentity'],'commitAPIMetadata':row['commitAPIMetadataIdentity'],'treeAPIMetadata':row['treeAPIMetadataIdentity'],'rawCommitObjectRetained':True,'retainedOrdinaryBodyIndex':row['retainedOrdinaryBodyIndex'],'originalNoticeCandidates':row['noticePathAndBodyIndex'],'nestedGitlinks':[],'independentRetainedReread':nr,'retainedObjectPins':list(nested.pins.values()),'projectCodeExecuted':False,'producerComplete':False,'fullOriginalNoticeClosure':False,'gateAComplete':False,'publisherSignatureLocallyVerified':False}
  publish(nested,'TERMINAL.json',nt)
  for selected in selection['sources']:
   m.pinned_file({'file':str(raw_directory/(selected['commit']+'.raw')),'bytes':selected['rawCommitBytes'],'sha256':selected['rawCommitSHA256']})
  raw_record={'schemaVersion':1,'rawCommits':raw_rows,'sourceMetadataOnly':True,'projectCodeExecuted':False,'publisherSignaturesLocallyVerified':False}
  top.guard();encoded=(json.dumps(raw_record,indent=2,sort_keys=True)+'\n').encode();descriptor=os.open(raw_directory/'RESULT.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(descriptor,'wb') as stream:stream.write(encoded);stream.flush();os.fsync(stream.fileno())
  top.guard();m.need(budget.counts['requests']==24 and budget.counts['archiveRequests']==8 and budget.counts['commitRequests']==8 and budget.counts['treeRequests']==8 and budget.counts['blobRequests']==0,'Unexpected final request cohort')
  cohort.update(state='eight-root-custody-verified-not-producer-complete',sources=8,ordinaryBlobs=sum(x['ordinaryBlobCountAndBytes']['count'] for x in roots)+row['ordinaryBlobCountAndBytes']['count'],parentTerminal=pin(parent_body),nestedTerminal=pin((nested.root/'TERMINAL.json').read_bytes()),rawCommitRecord=pin(encoded),actualRequestsAndBytes=dict(budget.counts),elapsedSeconds=budget.elapsed())
  publish(top,'INTAKE.json',cohort)
  m.need(m.json_data((top.root/'INTAKE.json').read_bytes())==cohort,'Physical intake receipt differs');top.guard()
  return cohort
 except BaseException as error:
  cohort.update(state='incomplete',failure=type(error).__name__+': '+str(error),actualRequestsAndBytes=dict(budget.counts),elapsedSeconds=budget.elapsed())
  try:top.json('INTAKE.json',cohort)
  except BaseException:(top.root/'INTAKE.json').unlink(missing_ok=True)
  raise

def worker(manifest,output):
 selection,body=load_selection(Path(manifest));output=Path(output)
 m.need(shutil.disk_usage(output.parent).free>=2*1024**3,'Less than 2GiB local intake reserve')
 return run(selection,body,output)

def supervise(manifest,output,started=None,runner=None,clock=None):
 clock=clock or time.monotonic;runner=runner or subprocess.run;started=clock() if started is None else started
 remaining=600-(clock()-started)
 if remaining<=0:return 124
 code="import runpy,sys; module=runpy.run_path(sys.argv[1],run_name='binaryen_data_worker'); module['worker'](sys.argv[2],sys.argv[3])"
 command=[sys.executable,'-I','-B','-c',code,str(Path(__file__).resolve()),str(manifest),str(output)]
 try:result=runner(command,timeout=remaining,check=False);exit_code=result.returncode
 except subprocess.TimeoutExpired:exit_code=124
 if clock()-started>=600:exit_code=124
 if exit_code==0:
  path=Path(output)/'INTAKE.json';metadata=m.regular(path);m.need(metadata.st_size<=1024**2,'Intake receipt ceiling')
  value=m.json_data(path.read_bytes());m.need(value.get('state')=='eight-root-custody-verified-not-producer-complete' and value.get('selectionSHA256')==SELECTION_SHA256 and value.get('sources')==8 and value.get('sourceCodeExecuted') is False and value.get('producerComplete') is False and value.get('gateAComplete') is False,'Child exited without complete selected custody receipt')
 if exit_code:
  # A completed-looking child receipt after the outer deadline earns no credit.
  path=Path(output)/'INTAKE.json'
  if path.is_file() and m.json_data(path.read_bytes()).get('state')=='eight-root-custody-verified-not-producer-complete':path.unlink()
 return exit_code

def main():
 started=time.monotonic();p=argparse.ArgumentParser(description=__doc__);p.add_argument('--manifest',required=True);p.add_argument('--output',required=True);a=p.parse_args()
 code=supervise(a.manifest,a.output,started)
 if code==0:print((Path(a.output)/'INTAKE.json').read_text(),end='')
 raise SystemExit(code)

if __name__=='__main__':main()
