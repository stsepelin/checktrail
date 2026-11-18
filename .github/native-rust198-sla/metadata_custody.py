"""Single encrypted first-party filesystem metadata member; no original body intake.
Private recipient material never runs on or travels to the hosted runner.
"""
from pathlib import Path
import argparse,hashlib,json,math,os,re,stat,sys,time
HERE=Path(__file__).resolve().parent;sys.path.insert(0,str(HERE/'reused-crypto'));sys.path.insert(0,str(HERE))
from common import need,encoded,freeze,hash_file,deadline_receipt
from crypto_bridge import operation
import resolve_sla as R
NONCE='rust198-sla-meta-1118-v1'
RESOLVER_SHA='c5c2e766cb92fa265133d64bef854dc93c60c79f76911db47d83cfbc21cbb324'
MAX_PLAIN=2*1024**2
MAX_CIPHER=MAX_PLAIN+65536
MAX_META=16384
MAX_READY=4096
MAX_ZIP=MAX_PLAIN+98304
MEMBERS={'metadata.ctenc':MAX_CIPHER,'ENVELOPE.json':MAX_META,'READY.json':MAX_READY}

def unique(pairs):
 result={}
 for key,value in pairs:need(key not in result,'unique metadata JSON fields');result[key]=value
 return result

def read(file,limit,owner=None,private=True):
 before=file.lstat();need(file==file.resolve(strict=True) and stat.S_ISREG(before.st_mode) and before.st_nlink==1 and 0<before.st_size<=limit and (not before.st_mode&0o077 if private else not before.st_mode&0o022) and (owner is None or before.st_uid==owner),'physical private bounded metadata input');fd=os.open(file,os.O_RDONLY|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as stream:
  need(R.endpoint(before)==R.endpoint(os.fstat(stream.fileno())),'opened exact private input');body=stream.read(limit+1)
 need(len(body)==before.st_size and R.endpoint(before)==R.endpoint(file.lstat()),'private input changed');return body

def crypto_context(run):
 actual=R.context(run);return {'run':int(actual['GITHUB_RUN_ID']),'attempt':int(actual['GITHUB_RUN_ATTEMPT']),'head':actual['GITHUB_SHA'],'nonce':NONCE}

def metadata_record(row,ancestor=False):
 allowed={'relativePath','path','status','errno','kind','device','inode','mode','uid','gid','links','bytes','mtimeNs','ctimeNs','linkText'};need(type(row) is dict and set(row)<=allowed,'only original filesystem metadata fields');root_fields={'path','kind','device','inode','mode','uid','gid','links','bytes','mtimeNs','ctimeNs'};bare_root=ancestor and row.get('path')=='/' and set(row)==root_fields and row.get('kind')=='directory';need(bare_root or row.get('status') in ['observed','missing','inaccessible','wrong-type-ancestor','unknown-os-error'],'closed filesystem observation status')
 for key,value in row.items():
  if key in ['relativePath','path','linkText']:need(type(value) is str and len(os.fsencode(value))<=4096,'finite original path/link metadata')
  elif key in ['status','kind']:need(type(value) is str and len(value)<=32,'closed metadata identifier')
  else:need(type(value) is int,'only integer original stat metadata')
 if bare_root or row.get('status')=='observed':need(row.get('kind') in ['directory','regular','symlink','other'],'closed original metadata type')
 if not ancestor:
  value=row.get('relativePath');need(type(value) is str and not value.startswith('/') and all(x not in ('','.','..') for x in value.split('/')) and value.split('/')[0]=='Contents' and len(value.split('/'))<=4,'finite relative app namespace metadata')

def validate_plain(name,body,context):
 need(name in ['RESULT.json','REFUSAL.json'] and 0<len(body)<=MAX_PLAIN,'one fixed bounded metadata member');value=json.loads(body,object_pairs_hook=unique);need(type(value) is dict,'metadata object')
 if name=='RESULT.json':
  expected={'kind','selectedApp','selectedProfileSHA256','sourceCohortSHA256','actualXcodeVersionNotReadOrVerifiedByThisResolver','requestedScopeFullyObserved','originalSelector','ancestors','directoryScopes','entries','counts','licenseLocatedQualifiedOrRetained','SDKSourceToolNativeOrModelExecuted','originalRegularFileBodiesOpened','existingPermissionsChanged','endpointEqualityIsNotContinuousImmutability','nativeAdmissionGranted','elapsedSeconds','runContext','firstPartyResolverSHA256'}
  need(set(value)==expected and value['kind']=='finite-xcode262-sla-path-metadata-only' and value['selectedApp']=='/Applications/Xcode_26.2.app' and value['selectedProfileSHA256']==R.PROFILE_SHA256 and value['sourceCohortSHA256']==R.SOURCE_COHORT_SHA256 and value['firstPartyResolverSHA256']==RESOLVER_SHA,'exact reviewed resolver schema/selection/source');need(crypto_context(value['runContext'])==context,'same actual metadata run context');need(value['SDKSourceToolNativeOrModelExecuted'] is False and value['originalRegularFileBodiesOpened'] is False and value['existingPermissionsChanged'] is False and value['licenseLocatedQualifiedOrRetained'] is False and value['nativeAdmissionGranted'] is False,'metadata only, never body/native/license credit');need(type(value['requestedScopeFullyObserved']) is bool and len(value['entries'])<=4096 and len(value['directoryScopes'])<=66 and len(value['ancestors'])==3,'finite actual selected metadata scope')
  need([r.get('path') for r in value['ancestors']]==['/','/Applications','/Applications/Xcode_26.2.app'],'selected app ancestor metadata only')
  for row in value['ancestors']:metadata_record(row,True)
  for row in value['entries']:metadata_record(row)
  need(type(value['counts']) is dict and set(value['counts'])=={'entries','directoriesScanned','localizationsScanned'} and value['counts']['entries']==len(value['entries']) and 0<=value['counts']['directoriesScanned']<=66 and 0<=value['counts']['localizationsScanned']<=64,'finite reconciled metadata counts');need(type(value['elapsedSeconds']) in [int,float] and math.isfinite(value['elapsedSeconds']) and 0<=value['elapsedSeconds']<60,'timely original metadata observation')
  for row in value['directoryScopes']:need(type(row) is dict and set(row)<={'relativePath','status','errno','entries'} and row.get('status') in ['scanned','missing','inaccessible','wrong-type-ancestor','unknown-os-error'],'only closed directory scope metadata')
  need(type(value['originalSelector']) is dict and set(value['originalSelector'])<={'status','kind','relativePath','observationScope','scopeRelativePath','directoryPresenceObserved','fileAbsenceEstablished','errno','ancestorStatus','ancestorKind','ancestorRelativePath'},'only closed original selector metadata');return value['requestedScopeFullyObserved']
 need(set(value)=={'metadataOnlyObserved','reasonIdentifier','observation','nativeAdmissionGranted'} and value['metadataOnlyObserved'] is False and value['nativeAdmissionGranted'] is False and type(value['reasonIdentifier']) is str and re.fullmatch('[a-z][a-z0-9-]{0,79}',value['reasonIdentifier']),'exact closed first-party refusal metadata');need(value['observation'] is None or (type(value['observation']) is dict and set(value['observation'])<={'relativePath','status','errno','kind','device','inode','mode','uid','gid','links','bytes','mtimeNs','ctimeNs','linkText'}),'only closed failure filesystem metadata');return False

def identity(name,body):
 member={'name':name,'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest(),'kind':'first-party-xcode-path-metadata-no-bodies'};return {'bytes':len(body),'sha256':member['sha256'],'internalMemberMapSHA256':hashlib.sha256(encoded(member)).hexdigest()}

def seal(source_directory,output,recipient_file,recipient_sha,run,source_outcome,deadline=None):
 deadline=deadline or time.monotonic()+60;started=time.monotonic();context=crypto_context(run);need(context['attempt']==1 and source_outcome in ['success','failure'],'fresh first metadata attempt/outcome');need(not os.path.lexists(output) and output.parent==output.parent.resolve(strict=True),'fresh encrypted output');raw=read(recipient_file,4096,private=False);need(hashlib.sha256(raw).hexdigest()==recipient_sha,'exact reviewed public recipient hash');recipient=json.loads(raw,object_pairs_hook=unique);need(set(recipient)=={'kty','n','e'} and recipient['kty']=='RSA','public recipient only');need(time.monotonic()<deadline,'metadata capture deadline');output.mkdir(mode=0o700);output.chmod(0o700)
 candidate=source_directory/'RESULT.json';candidate=candidate if candidate.exists() else source_directory/'REFUSAL.json';body=read(candidate,MAX_PLAIN,os.getuid());scope=validate_plain(candidate.name,body,context);need(source_outcome=='failure' or (candidate.name=='RESULT.json' and scope is True),'success requires genuinely complete original metadata');plain=identity(candidate.name,body);request={'source':str(candidate),'out':str(output/'metadata.ctenc'),'seconds':min(30,deadline-time.monotonic()),'plaintext':plain,'context':context,'publicJWK':recipient};envelope=operation(output/'private-crypto','encrypt',request,deadline);need(envelope['plaintext']==plain and envelope['context']==context and envelope['publicRecipientJWK']==recipient and envelope['bytes']<=MAX_CIPHER,'exact finite encrypted envelope');need(hash_file(output/'metadata.ctenc',deadline=deadline)==(envelope['bytes'],envelope['sha256']),'physical bounded cipher readback');need(body==read(candidate,MAX_PLAIN,os.getuid()),'metadata source remained identical');need(time.monotonic()<deadline,'metadata capture validation deadline');public={**envelope,'metadataMember':candidate.name,'metadataOnly':True,'resolverSHA256':RESOLVER_SHA};need(len(encoded(public))<=MAX_META,'finite public envelope metadata');freeze(output/'ENVELOPE.json',encoded(public))
 ready={'schemaVersion':1,'context':context,'metadataOnlyEncryptedReady':True,'sourceOutcome':source_outcome,'requestedScopeFullyObserved':scope,'resolverSHA256':RESOLVER_SHA,'metadataMember':candidate.name,'bytes':envelope['bytes'],'sha256':envelope['sha256'],'envelopeSHA256':hashlib.sha256(encoded(public)).hexdigest(),'licenseSDKSourceNativeOrGateACredit':False};need(len(encoded(ready))<=MAX_READY,'finite ready metadata');ready=deadline_receipt(output/'READY.json',ready,deadline,{'metadataOnlyEncryptedReady':False,'captureBudgetExhausted':True},started);need(ready['metadataOnlyEncryptedReady'] and not ready['completionBudgetExhausted'],'late encrypted metadata is not uploadable');need(set(p.name for p in output.iterdir() if p.is_file())==set(MEMBERS),'only three public cipher files');return ready

def recover(cipher_directory,output,private_key,context,recipient,deadline=None):
 deadline=deadline or time.monotonic()+120;need(not os.path.lexists(output) and output.parent==output.parent.resolve(strict=True),'fresh private recovery');need(private_key==private_key.resolve(strict=True) and private_key.stat().st_uid==os.getuid() and 0<private_key.stat().st_size<=8192 and stat.S_ISREG(private_key.stat().st_mode) and private_key.stat().st_nlink==1 and stat.S_IMODE(private_key.stat().st_mode)==0o400,'local private recipient only');ready=json.loads(read(cipher_directory/'READY.json',MAX_READY),object_pairs_hook=unique);envelope=json.loads(read(cipher_directory/'ENVELOPE.json',MAX_META),object_pairs_hook=unique);need(ready['context']==context==envelope['context'] and ready['metadataOnlyEncryptedReady'] is True and ready['completionCreditFinalized'] is True and ready['completionBudgetExhausted'] is False,'exact timely encrypted original context');need(ready['resolverSHA256']==RESOLVER_SHA==envelope['resolverSHA256'] and envelope['publicRecipientJWK']==recipient and ready['metadataMember']==envelope['metadataMember'] and ready['envelopeSHA256']==hashlib.sha256(encoded(envelope)).hexdigest(),'exact resolver/recipient/envelope');need(ready['bytes']==envelope['bytes']<=MAX_CIPHER and ready['sha256']==envelope['sha256'],'exact bounded original cipher');source=cipher_directory/'metadata.ctenc';need(hash_file(source,deadline=deadline)==(envelope['bytes'],envelope['sha256']),'whole physical ciphertext before decrypt');output.mkdir(mode=0o700);output.chmod(0o700);plain=output/'AUTHENTICATED-METADATA.json';auth=operation(output/'private-decrypt','decrypt',{'privateKey':str(private_key),'parts':[{'path':str(source),'bytes':envelope['bytes'],'sha256':envelope['sha256']}],'envelope':envelope,'context':context,'out':str(plain),'seconds':min(60,deadline-time.monotonic())},deadline);need(auth['authenticated'] is True and auth['plaintextParsingBeforeGCMAuthentication'] is False,'full original GCM authentication before metadata parse');body=read(plain,MAX_PLAIN);scope=validate_plain(envelope['metadataMember'],body,context);need(identity(envelope['metadataMember'],body)==envelope['plaintext'],'one exact internal metadata member');need(time.monotonic()<deadline,'whole private recovery deadline');receipt={'authenticatedMetadataRecovery':True,'context':context,'metadataBytes':len(body),'metadataSHA256':hashlib.sha256(body).hexdigest(),'sourceOutcome':ready['sourceOutcome'],'requestedScopeFullyObserved':scope,'originalRegularBodiesOrPrivateKeyExported':False,'licenseSDKNativeOrGateACredit':False};freeze(output/'RECOVERY.json',encoded(receipt));need(time.monotonic()<deadline,'private recovery receipt deadline');return receipt

def grant_cipher_upload(root,output,ready):
 need(root==root.resolve(strict=True) and output.parent==root and output==output.resolve(strict=True),'exact own encrypted output placement');need(root.stat().st_uid==os.getuid() and stat.S_IMODE(root.stat().st_mode)==0o700,'own private metadata root');need(ready['metadataOnlyEncryptedReady'] is True and ready['completionCreditFinalized'] is True and ready['completionBudgetExhausted'] is False,'only timely ciphertext may become runner-readable')
 for name,cap in MEMBERS.items():
  file=output/name;body=read(file,cap,os.getuid());need(name!='metadata.ctenc' or (len(body)==ready['bytes'] and hashlib.sha256(body).hexdigest()==ready['sha256']),'exact ciphertext upload member')
 need(json.loads(read(output/'READY.json',MAX_READY),object_pairs_hook=unique)==ready and hashlib.sha256(read(output/'ENVELOPE.json',MAX_META)).hexdigest()==ready['envelopeSHA256'],'exact final public metadata before chmod')
 for name in MEMBERS:(output/name).chmod(0o444)
 output.chmod(0o555);root.chmod(0o711)
 # Only these three cipher/public files become readable. Plain RESULT/REFUSAL
 # stay0400, private crypto evidence directories stay0700. Stock paths untouched.
 return output

def preflight(recipient_file,recipient_sha,run,output):
 crypto_context(run);body=read(recipient_file,4096,private=False);need(hashlib.sha256(body).hexdigest()==recipient_sha,'exact original public crypto recipient');recipient=json.loads(body,object_pairs_hook=unique);deadline=time.monotonic()+20;result=operation(output,'validate-recipient',{'publicJWK':recipient},deadline);need(result=={'validPublicRecipient':True} and time.monotonic()<deadline,'hosted first-party builtin crypto readiness');return {'firstPartyCryptoRuntimeAndPublicRecipientReady':True,'noOriginalMetadataOrPrivateKeyRead':True,'nativeAdmissionGranted':False}

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('mode',choices=['preflight','seal']);p.add_argument('--recipient-sha256',required=True);p.add_argument('--source-outcome',choices=['success','failure']);a=p.parse_args();need(os.getuid()==0,'reviewed root metadata capture only');run=R.context(os.environ)
 if a.mode=='preflight':
  target=Path('/opt')/('checktrail-rust198-sla-crypto-'+run['GITHUB_RUN_ID']+'-'+run['GITHUB_RUN_ATTEMPT']+'-'+run['GITHUB_SHA'][:12]);print(json.dumps(preflight(HERE/'recipient-public.json',a.recipient_sha256,run,target),sort_keys=True));return
 root=Path('/opt')/('checktrail-rust198-sla-'+run['GITHUB_RUN_ID']+'-'+run['GITHUB_RUN_ATTEMPT']+'-'+run['GITHUB_SHA'][:12]);ready=seal(root,root/'encrypted',HERE/'recipient-public.json',a.recipient_sha256,run,a.source_outcome);grant_cipher_upload(root,root/'encrypted',ready);print(json.dumps({'encryptedMetadataReady':True,'bytes':ready['bytes'],'sha256':ready['sha256'],'sourceOutcome':ready['sourceOutcome'],'nativeAdmissionGranted':False},sort_keys=True))
if __name__=='__main__':
 try:main()
 except Exception as error:print(json.dumps({'encryptedMetadataReady':False,'errorType':type(error).__name__,'nativeAdmissionGranted':False},sort_keys=True));raise SystemExit(1)
