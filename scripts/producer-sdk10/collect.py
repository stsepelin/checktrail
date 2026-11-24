#!/usr/bin/env python3
"""Private operator custody; final pair is not deleted before full roundtrip."""
import argparse,concurrent.futures,hashlib,json,os,pathlib,re,shutil,signal,stat,sys,threading,time,zipfile
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from common import *
from transport_base import Calls
from capture import roundtrip
from crypto_bridge import operation,ack_payload
from git_ack import AckAPI
def validate_meta(meta,ctx,ordinal):
 need(type(meta) is dict and meta.get('ordinal')==ordinal and meta.get('window')==(ordinal+1)//2,'exact carrier ordinal/window');series=meta.get('series');need(type(series) is dict and series.get('context')==ctx and series.get('kind')=='encrypted-original-sdk10-stopped-persistent-evidence','same original producer series/context');need(digest(encoded(series))==meta.get('seriesSHA256'),'full consistent series metadata identity');archive=series['archive'];need(type(archive.get('bytes')) is int and 0<archive['bytes']<=12*1024**3 and re.fullmatch('[0-9a-f]{64}',archive.get('sha256','')),'bounded stopped archive identity');plan=body_plan(archive['bytes']);need(series['plan']==plan and ordinal<=plan['totalCarriers'],'exact complete carrier plan');payload=ordinal<=plan['payloadParts'];expected_size=min(plan['partBytes'],archive['bytes']-(ordinal-1)*plan['partBytes']) if payload else 1024;need(meta.get('payload') is payload and meta.get('offset')==((ordinal-1)*plan['partBytes'] if payload else None) and meta.get('bytes')==expected_size,'exact source capture byte range');need(meta.get('finalWindow') is (meta['window']==plan['windows']) and re.fullmatch('[0-9a-f]{64}',meta.get('sha256','')),'final window and part hash');return series
def inspect_zip(path,ctx,ordinal):
 need(path.stat().st_size<=128*1024**2,'original source carrier ZIP bound')
 with zipfile.ZipFile(path) as z:
  entries=z.infolist();need(len(entries)==2 and {x.filename for x in entries}=={'part.bin','part.json'},'exact two regular carrier members')
  for x in entries:need(not x.is_dir() and x.compress_type in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED] and (x.external_attr>>16&0o170000) in [0,stat.S_IFREG],'regular inert carrier members')
  item=z.getinfo('part.json');need(item.file_size<=16384,'bounded first-party part metadata');meta=json.loads(z.read(item));series=validate_meta(meta,ctx,ordinal);item=z.getinfo('part.bin');need(item.file_size==meta['bytes'],'decoded original part byte bound');h=hashlib.sha256();n=0
  with z.open(item) as f:
   for block in iter(lambda:f.read(65536),b''):n+=len(block);need(n<=meta['bytes'],'part decoded-byte bound');h.update(block)
  need(n==meta['bytes'] and h.hexdigest()==meta['sha256'],'original part SHA256/size/ZIPCRC')
 return meta,series
def worker(folder,ctx,ordinal,meta,deadline,stop):
 folder.mkdir(mode=0o700);calls=Calls(folder,deadline,stop);row={'ordinal':ordinal,'artifactID':meta['id'],'state':'INCOMPLETE','deleteAttempted':False,'deletionKnownAbsent':False,'workerDirectory':str(folder),'durabilityAnchor':str(folder.parent.parent.parent)};error=None
 try:
  # A digest the listing showed must not change; one that appears only by ID
  # is checked against the downloaded ZIP, like every service digest.
  base='repos/stsepelin/checktrail/actions/artifacts/';actual=owned(calls.metadata(base+str(meta['id'])),ctx,ordinal);need(all(actual.get(k)==meta.get(k) for k in ['id','name','size_in_bytes']) and (meta.get('digest') is None or actual.get('digest')==meta['digest']),'original owned descriptor unchanged');code,_,carrier=calls.run(['--allow-escape-sequences',base+str(meta['id'])+'/zip'],128*1024**2,120);need(code==0,'original carrier transfer exit0');n,h=hash_file(carrier);need(n==actual['size_in_bytes'] and (actual.get('digest') is None or actual['digest']=='sha256:'+h),'service original ZIP hash/size');part,series=inspect_zip(carrier,ctx,ordinal);target=folder/'part.bin'
  with target.open('xb') as f,zipfile.ZipFile(carrier) as z,z.open('part.bin') as source:
   for b in iter(lambda:source.read(65536),b''):f.write(b)
   f.flush();os.fsync(f.fileno())
  target.chmod(0o400);need(hash_file(target)==(part['bytes'],part['sha256']),'independent physical retained part readback');fd=os.open(carrier,os.O_RDONLY)
  try:os.fsync(fd)
  finally:os.close(fd)
  candidate={**row,'state':'CUSTODIED','serviceDigest':actual.get('digest'),'carrierFile':str(carrier),'carrierSHA256':h,'carrierBytes':n,'physicalPartFile':str(target),'part':part,'series':series,'localZIPAndPartFsyncedAndRoundtripped':True,'ownedChildrenReaped':all(p in calls.reapedPIDs for p in calls.startedPIDs)};freeze(folder/'CUSTODY.json',encoded(candidate));sync_chain(folder,row['durabilityAnchor']);row.update(candidate,custodyReceiptSHA256=hash_file(folder/'CUSTODY.json')[1])
 except BaseException as e:error=type(e).__name__+': '+str(e) if isinstance(e,Refusal) else type(e).__name__
 finally:
  row.update(error=error,APIEvents=calls.events,ownedChildrenReaped=all(p in calls.reapedPIDs for p in calls.startedPIDs));freeze(folder/'DOWNLOAD-RESULT.json',encoded(row));syncdir(folder)
 return row
def expected_descriptor(value,row,ctx):
 # A digest the service reported at custody must still be reported before delete.
 owned(value,ctx,row['ordinal']);need(value['id']==row['artifactID'] and value['size_in_bytes']==row['carrierBytes'] and (value.get('digest') is None or value['digest']=='sha256:'+row['carrierSHA256']) and (row.get('serviceDigest') is None or value.get('digest')==row['serviceDigest']),'same original immutable owned ZIP descriptor')
 return {k:value.get(k) for k in ['id','name','size_in_bytes','digest']}
def wait_exact_absence(calls,row,ctx,deadline,expected):
 for attempt in range(16):
  need(time.monotonic()<deadline-2,'original recovery deadline before absence observation');value=calls.metadata('repos/stsepelin/checktrail/actions/artifacts/'+str(row['artifactID']),missing=True)
  if value is None:
   need(time.monotonic()<deadline-1,'exact404 observation within original recovery budget');return {'exact404':True,'observations':attempt+1}
  need(expected_descriptor(value,row,ctx)==expected,'same owned descriptor during bounded consistency wait')
  need(attempt<15 and time.monotonic()<deadline-2,'bounded post-delete consistency wait exhausted');time.sleep(1)
 raise Refusal('unreachable absence loop')
def delete_after_custody(row,ctx,deadline,stop,final_roundtrip=False):
 folder=pathlib.Path(row['workerDirectory']);need(row.get('error') is None and row.get('custodyReceiptSHA256')==hash_file(folder/'CUSTODY.json')[1],'successful immutable custody receipt required');receipt=read_json(folder/'CUSTODY.json');download=read_json(folder/'DOWNLOAD-RESULT.json');need(receipt.get('state')=='CUSTODIED' and receipt.get('artifactID')==row['artifactID'] and receipt.get('part')==row['part'] and download.get('error') is None and download.get('custodyReceiptSHA256')==row['custodyReceiptSHA256'],'durable receipt/readback and terminal persistence agree');need(row['state']=='CUSTODIED' and row['localZIPAndPartFsyncedAndRoundtripped'] and row['ownedChildrenReaped'],'exact original complete local custody before delete');need(not row['part']['finalWindow'] or final_roundtrip,'final two source carriers retained remotely until full original archive/member roundtrip');calls=Calls(folder/'delete',deadline,stop);calls.out.mkdir(mode=0o700);expected=expected_descriptor(calls.metadata('repos/stsepelin/checktrail/actions/artifacts/'+str(row['artifactID'])),row,ctx);need(all(p in calls.reapedPIDs for p in calls.startedPIDs),'owned metadata child reaped before exact delete');freeze(folder/'DELETE-ATTEMPT.json',encoded({'ordinal':row['ordinal'],'artifactID':row['artifactID'],'custodyReceiptSHA256':row['custodyReceiptSHA256'],'fullArchiveRoundtripBeforeFinalDelete':final_roundtrip}));sync_chain(folder,row['durabilityAnchor']);row['deleteAttempted']=True
 try:
  row['deletion']=calls.delete(row['artifactID']);row['absenceProof']=wait_exact_absence(calls,row,ctx,deadline,expected);row['deletionKnownAbsent']=True;row['state']='COMPLETE'
 finally:
  row['deletionAPIEvents']=calls.events;row['deleteChildrenReaped']=all(p in calls.reapedPIDs for p in calls.startedPIDs);freeze(folder/'DELETE-RESULT.json',encoded(row));syncdir(folder)
 return row
def archive_roundtrip(out,rows,series,deadline,private_key):
 parts={x['ordinal']:x for x in rows};plan=series['plan'];need(all(i in parts and parts[i]['state'] in ['CUSTODIED','COMPLETE'] and parts[i].get('error') is None for i in range(1,plan['payloadParts']+1)),'all exact encrypted payload parts in custody');ordered=[]
 for i in range(1,plan['payloadParts']+1):
  row=parts[i];p=pathlib.Path(row['physicalPartFile']);need(hash_file(p)==(row['part']['bytes'],row['part']['sha256']),'fresh independent encrypted physical part hash');ordered.append({'path':str(p),'bytes':row['part']['bytes'],'sha256':row['part']['sha256']})
 # No assembled ciphertext copy: ZIPs + decoded cipher parts + authenticated
 # plaintext stay inside the original three-times12GiB local envelope.
 target=out/'STOPPED-EVIDENCE.tar.gz';auth=operation(out/'authenticated-decrypt','decrypt',{'parts':ordered,'envelope':series['archive'],'context':series['context'],'privateKey':str(private_key),'out':str(target),'seconds':max(.001,min(4500,deadline-time.monotonic()-5))},deadline);need(auth.get('authenticated') is True and auth.get('plaintextParsingBeforeGCMAuthentication') is False,'final GCM authentication before any decompression/member parse');plain=series['archive']['plaintext'];need(hash_file(target)==(plain['bytes'],plain['sha256']),'authenticated full private plaintext physical readback');proof=roundtrip(target,deadline,32*1024**3);need(proof['internalMemberMapSHA256']==plain['internalMemberMapSHA256'],'original authenticated internal member map identity');receipt={'archiveFile':str(target),'bytes':plain['bytes'],'sha256':plain['sha256'],**proof,'sourceOrLogBodiesEmitted':False,'envelopeAuthentication':auth};freeze(out/'INDEPENDENT-ARCHIVE-ROUNDTRIP.json',encoded(receipt));sync_chain(out,out.parent);return proof

def publish_recovery_ack(out,rows,series,ctx,deadline,private_key):
 ledger={'context':ctx,'seriesSHA256':digest(encoded(series)),'parts':[{'ordinal':r['ordinal'],'artifactID':r['artifactID'],'carrierSHA256':r['carrierSHA256'],'physicalPartSHA256':r['part']['sha256'],'custodyReceiptSHA256':r['custodyReceiptSHA256']} for r in sorted(rows,key=lambda r:r['ordinal'])]};freeze(out/'DURABLE-CUSTODY-LEDGER.json',encoded(ledger));sync_chain(out,out.parent);payload=ack_payload(series,hash_file(out/'INDEPENDENT-ARCHIVE-ROUNDTRIP.json')[1],hash_file(out/'DURABLE-CUSTODY-LEDGER.json')[1]);ack=operation(out/'sign-recovery-ack','sign-ack',{'payload':payload,'privateKey':str(private_key)},deadline);freeze(out/'SIGNED-RECOVERY-ACK.json',encoded(ack));sync_chain(out,out.parent);api=AckAPI(out/'ack-publication',deadline,series['recoveryACKChannel'],ctx,write=True);proof=api.publish(ack);freeze(out/'PUBLISHED-RECOVERY-ACK.json',encoded(proof));sync_chain(out,out.parent);return proof
def without_deleted(listing,deleted):
 """The run listing without members whose exact 404 was already observed, and how many it still showed.

 The run listing can trail the per-artifact endpoint, so a deleted member may
 stay listed for a while. Only the same ID under the same name qualifies;
 anything else stays in the listing and is judged like any other entry.
 """
 items=listing.get('artifacts');total=listing.get('total_count');need(type(items) is list and type(total) is int,'bounded two-slot listing schema')
 lingering=[x for x in items if type(x) is dict and x.get('id') in deleted and x.get('name')==deleted[x['id']]];rest=[x for x in items if x not in lingering]
 # The count can drop before the rows do. A listing that still shows a deleted
 # member is waited out anyway, so only its other rows are judged.
 return {**listing,'total_count':len(rest) if lingering else total,'artifacts':rest},len(lingering)
def collect(a):
 ctx=context(a.nonce,a.run,a.head);key_stat=a.private_key.lstat();need(stat.S_ISREG(key_stat.st_mode) and not a.private_key.is_symlink() and stat.S_IMODE(key_stat.st_mode)&0o077==0,'local-only protected operator private key file');need(not a.out.exists(),'fresh private operator collection root');need(shutil.disk_usage(a.out.parent).free>=3*12*1024**3+10*1024**3+2*128*1024**2,'private ZIP/parts/full-archive independent capacity admission');a.out.mkdir(mode=0o700);control=a.out/'control';control.mkdir(mode=0o700);start=time.monotonic();whole=start+a.seconds-10;calls=Calls(control,whole,a.stop);rows=[];windows=[];series=None;error=None;result={'schemaVersion':1,'state':'INCOMPLETE','context':ctx,'sourceOrNativeExecutedLocally':False,'GateAClosureClaimed':False};executor=concurrent.futures.ThreadPoolExecutor(max_workers=2,thread_name_prefix='sdk10-owned-part');window=1;recovery_deadline=None;last_run_status=start;deleted={}
 try:
  run=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run']));need(run.get('head_sha')==ctx['head'] and run.get('event')=='workflow_dispatch' and run.get('run_attempt')==1 and run.get('path')==a.workflow,'exact source producer workflow/run/head');freeze(a.out/'RUN-BINDING.json',encoded(run))
  while series is None or window<=series['plan']['windows']:
   # Only the wait for the first pair may use the whole bound. Listing it
   # starts the 75-minute recovery budget, and every later listing, handshake,
   # download and sleep ends within that budget.
   limit=whole if recovery_deadline is None else recovery_deadline;calls.deadline=limit
   need(not a.stop.is_set() and time.monotonic()<limit-2,'operator finite whole waiting bound' if recovery_deadline is None else 'original recovery budget before next window');ordinals=[window*2-1,window*2];folder=a.out/('window-'+str(window).zfill(2));folder.mkdir(mode=0o700);members=None
   while members is None:
    # A member deleted earlier may still be listed; the next pair is admitted only once none is.
    listing=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run'])+'/artifacts?per_page=100');current,lingering=without_deleted(listing,deleted);members=validate_window_listing(current,ctx,ordinals)
    if lingering:members=None
    if members is None:
     if time.monotonic()-last_run_status>=60:
      latest=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run']));need(latest.get('head_sha')==ctx['head'] and latest.get('run_attempt')==1,'same original run while waiting');last_run_status=time.monotonic();need(latest.get('status')!='completed','original producer completed without the complete next owned window; preserve incomplete evidence')
     freeze(folder/('INCOMPLETE-LISTING-'+str(calls.seq)+'.json'),encoded(listing));need(time.monotonic()<limit-2 and not a.stop.is_set(),'bounded source window availability wait');time.sleep(max(0,min(15 if series is None else 2,limit-2-time.monotonic())))
   if recovery_deadline is None:recovery_deadline=min(whole,time.monotonic()+4500)
   deadline=min(whole,recovery_deadline);calls.deadline=deadline;hand=None
   while hand is None:
    jobs=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run'])+'/attempts/1/jobs?per_page=100');hand=handshake(jobs,ctx,window)
    if hand is None:need(time.monotonic()<deadline-2 and not a.stop.is_set(),'bounded exact window completed-step wait');time.sleep(1)
   freeze(folder/'OBSERVED-HANDSHAKE.json',encoded(hand));ownership={'context':ctx,'window':window,'members':members};freeze(folder/'OWNERSHIP.json',encoded(ownership));futures=[executor.submit(worker,folder/('worker-'+str(i).zfill(6)),ctx,i,meta,deadline,a.stop) for i,meta in zip(ordinals,members)];pair=[]
   for future in concurrent.futures.as_completed(futures):pair.append(future.result())
   pair.sort(key=lambda x:x['ordinal']);rows.extend(pair);need(all(x['state']=='CUSTODIED' and x.get('error') is None and x['ownedChildrenReaped'] for x in pair),'both exact pair members fully custodied before future window')
   for row in pair:
    if series is None:series=row['series'];freeze(a.out/'SOURCE-CAPTURE-SERIES.json',encoded(series))
    need(row['series']==series and validate_meta(row['part'],ctx,row['ordinal'])==series,'same complete immutable original capture series across all carriers')
   final=window==series['plan']['windows']
   if final:result['independentArchiveRoundtrip']=archive_roundtrip(a.out,rows,series,deadline,a.private_key);result['signedRecoveryACK']=publish_recovery_ack(a.out,rows,series,ctx,deadline,a.private_key)
   for row in pair:
    delete_after_custody(row,ctx,deadline,a.stop,final)
    if row.get('deletionKnownAbsent') is True:deleted[row['artifactID']]=name(ctx,row['ordinal'])
   freeze(folder/'WINDOW-RESULT.json',encoded({'window':window,'handshake':hand,'allTwoOriginalPartsCustodiedBeforeExactDelete':True,'fullArchiveRoundtripBeforeFinalDelete':final,'ownedIDs':[x['artifactID'] for x in pair]}));windows.append(window);window+=1
  # The finalizer emits only bounded first-party metadata to the workflow log.
  # It executes AFTER the final independent-custody404 acknowledgement. Waiting
  # for the producer job to finish is not a carrier wait and keeps the whole bound.
  calls.deadline=whole;terminal=None
  while terminal is None:
   need(time.monotonic()<whole-2,'bounded final owned cleanup/run metadata wait');run=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run']))
   if run.get('status')!='completed':time.sleep(2);continue
   jobs=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run'])+'/attempts/1/jobs?per_page=100');need(jobs.get('total_count')==1 and len(jobs.get('jobs',[]))==1,'one exact final source job');job=jobs['jobs'][0];need(job.get('head_sha')==ctx['head'] and job.get('name')=='sdk10-original','exact final job identity');code,raw,path=calls.run(['--allow-escape-sequences','repos/stsepelin/checktrail/actions/jobs/'+str(job['id'])+'/logs'],2*1024**2,60);need(code==0,'bounded final first-party metadata log retrieval');matches=[]
   for line in raw.decode('utf8','replace').splitlines():
    marker='CHECKTRAIL_SDK10_TERMINAL=';index=line.find(marker)
    if index>=0:
     try:v=json.loads(line[index+len(marker):]);need(v.get('context')==ctx,'terminal metadata exact source run/head/nonce');matches.append(v)
     except (ValueError,Refusal):pass
   need(len(matches)==1,'one exact terminal first-party metadata record');terminal=matches[0];freeze(a.out/'SOURCE-TERMINAL.json',encoded(terminal));result['remoteRunConclusion']=run.get('conclusion');result['remoteOwnedCleanup']=terminal['cleanup']
  while True:
   listing=calls.metadata('repos/stsepelin/checktrail/actions/runs/'+str(ctx['run'])+'/artifacts?per_page=100');items=listing.get('artifacts');need(type(listing.get('total_count')) is int and 0<=listing['total_count']<=2 and type(items) is list and len(items)<=2,'bounded final original-carrier listing');need(all(type(x) is dict and x.get('id') in [row['artifactID'] for row in rows] for x in items),'no foreign final artifact')
   if listing['total_count']==0 and items==[]:break
   need(time.monotonic()<whole-2,'bounded consistent final zero-artifact observation');time.sleep(2)
  result.update(state='COMPLETE private original stopped-evidence custody and independent roundtrip',completedParts=len(rows),series=series,allOriginalCarriersDeletedOnlyAfterCustody=True,originalProducerReportedState=terminal['state'])
 except BaseException as e:error=type(e).__name__+': '+str(e) if isinstance(e,Refusal) else type(e).__name__
 finally:
  executor.shutdown(wait=True);result.update(error=error,parts=rows,completedWindows=windows,elapsedSeconds=time.monotonic()-start,metadataAPIEvents=calls.events,sourceCodeOrCompilerExecutedByCollector=False);freeze(a.out/'RESULT.json',encoded(result));syncdir(a.out);print(json.dumps({'state':result['state'],'error':error,'completedParts':result.get('completedParts',sum(x['state']=='COMPLETE' for x in rows)),'sourceProducerState':result.get('originalProducerReportedState')}))
 if error:raise SystemExit(1)
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--run',type=int,required=True);p.add_argument('--head',required=True);p.add_argument('--nonce',required=True);p.add_argument('--out',type=pathlib.Path,required=True);p.add_argument('--private-key',type=pathlib.Path,required=True);p.add_argument('--workflow',default='.github/workflows/ci.yml');p.add_argument('--seconds',type=int,default=28800);a=p.parse_args();need(0<a.seconds<=28800,'bounded operator metadata wait plus original350min hosted job');a.stop=threading.Event()
 def stop(sig,frame):a.stop.set();raise Refusal('operator whole collection deadline or owned signal')
 for sig in [signal.SIGALRM,signal.SIGTERM,signal.SIGINT]:signal.signal(sig,stop)
 signal.alarm(a.seconds-5)
 try:collect(a)
 finally:signal.alarm(0)
