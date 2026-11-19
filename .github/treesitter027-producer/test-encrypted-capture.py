"""Synthetic encrypted capture integration; no upstream/project/native execution."""
import hashlib,importlib.util,json,os,subprocess,tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('private_tree_capture',HERE/'encrypted-capture.py');E=importlib.util.module_from_spec(spec);spec.loader.exec_module(E)
class Tests(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.keytemp=tempfile.TemporaryDirectory(prefix='tree-crypto-test-key-');cls.keys=Path(cls.keytemp.name).resolve();node='''const fs=require('node:fs'),c=require('node:crypto');const k=c.generateKeyPairSync('rsa',{modulusLength:3072});fs.writeFileSync(process.argv[1]+'/key.pem',k.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'});fs.writeFileSync(process.argv[1]+'/public.json',JSON.stringify(k.publicKey.export({format:'jwk'})),{mode:0o600,flag:'wx'});''';subprocess.run(['node','-e',node,str(cls.keys)],capture_output=True,check=True,timeout=30);cls.public=json.loads((cls.keys/'public.json').read_bytes())
 @classmethod
 def tearDownClass(cls):cls.keytemp.cleanup()
 def setUp(self):self.temp=tempfile.TemporaryDirectory(prefix='tree-capture-integration-');self.root=Path(self.temp.name).resolve();self.capture=self.root/'capture';self.capture.mkdir();(self.capture/'RESULT.json').write_bytes(b'{"complete":false,"source":"synthetic"}');(self.capture/'public-upstream-output.bin').write_bytes(bytes(range(256))*1024);self.context={'run':123,'head':'a'*40,'attempt':1,'nonce':'tree-synthetic-capture'}
 def tearDown(self):
  for p in self.root.rglob('*'):
   if p.is_file() and not p.is_symlink():p.chmod(0o600)
   elif p.is_dir():p.chmod(0o700)
  self.temp.cleanup()
 def encrypt(self):
  archive=self.root/'capture.tar.gz';plain=E.pack(self.capture,archive,time.monotonic()+30);envelope=E.operation(self.root/'encrypt','encrypt',{'source':str(archive),'out':str(self.root/'capture.ctenc'),'seconds':30,'plaintext':plain,'context':self.context,'publicJWK':self.public},time.monotonic()+30);return archive,plain,envelope
 def decrypt(self,envelope,context=None):return E.operation(self.root/'decrypt','decrypt',{'privateKey':str(self.keys/'key.pem'),'parts':[{'path':str(self.root/'capture.ctenc'),'bytes':envelope['bytes'],'sha256':envelope['sha256']}],'envelope':envelope,'context':context or self.context,'out':str(self.root/'authenticated.tar.gz'),'seconds':30},time.monotonic()+30)
 def test_frozen_operator_recipient_contains_only_valid_public_rsa_fields(self):
  public=json.loads((HERE/'recipient-public.json').read_bytes());self.assertEqual(set(public),{'kty','n','e'});proof=E.operation(self.root/'recipient-validation','validate-recipient',{'publicJWK':public},time.monotonic()+30);self.assertTrue(proof['validPublicRecipient'])
 def test_actual_pack_envelope_authenticated_recovery_and_all_members(self):
  archive,plain,envelope=self.encrypt();proof=self.decrypt(envelope);restored=self.root/'restored';result=E.unpack_authenticated(self.root/'authenticated.tar.gz',restored,plain,proof,time.monotonic()+30);self.assertTrue(result['complete']);self.assertEqual(result['members'],2);self.assertEqual({p.name for p in restored.iterdir()},{p.name for p in self.capture.iterdir()});self.assertEqual((restored/'public-upstream-output.bin').read_bytes(),(self.capture/'public-upstream-output.bin').read_bytes());self.assertNotEqual((self.root/'capture.ctenc').read_bytes(),archive.read_bytes());self.assertNotIn(b'public-upstream-output.bin',(self.root/'capture.ctenc').read_bytes())
 def test_wrong_context_refuses_before_plaintext_and_parsing(self):
  archive,plain,envelope=self.encrypt()
  with self.assertRaisesRegex(Exception,'incomplete'):self.decrypt(envelope,{**self.context,'run':124})
  self.assertFalse((self.root/'authenticated.tar.gz').exists());self.assertFalse((self.root/'restored').exists())
 def test_ciphertext_bit_flip_refuses_authentication_without_output(self):
  archive,plain,envelope=self.encrypt();p=self.root/'capture.ctenc';b=bytearray(p.read_bytes());b[-1]^=1;p.chmod(0o600);p.write_bytes(b);envelope['sha256']=hashlib.sha256(b).hexdigest()
  with self.assertRaisesRegex(Exception,'incomplete'):self.decrypt(envelope)
  self.assertFalse((self.root/'authenticated.tar.gz').exists());self.assertFalse((self.root/'authenticated.tar.gz.UNAUTHENTICATED.pending').exists())
 def test_plaintext_parse_requires_authenticated_receipt(self):
  archive=self.root/'capture.tar.gz';plain=E.pack(self.capture,archive,time.monotonic()+30)
  with self.assertRaisesRegex(ValueError,'before parsing'):E.unpack_authenticated(archive,self.root/'restored',plain,{'authenticated':False},time.monotonic()+30)
  self.assertFalse((self.root/'restored').exists())
 def test_actual_local_recovery_wrapper_retains_failed_producer_without_accepting_it(self):
  result={'run':'123','attempt':'1','controllerCommit':'a'*40,'sourceCommit':'6070dbfefd326bd735e5683eb128cc1b57dad0c0','sourceTree':'4014272399391bf64752dc1564f09be2ff4ed3a9','complete':False,'failure':{'reason':'synthetic actual producer refusal'}};(self.capture/'RESULT.json').write_text(json.dumps(result));rows=[{'relativePath':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in self.capture.iterdir()];(self.capture/'CAPTURE-INDEX.json').write_text(json.dumps({'runId':'123','attempt':'1','controllerCommit':'a'*40,'files':rows}));archive,plain,envelope=self.encrypt();bundle=self.root/'bundle';bundle.mkdir();(bundle/'capture.ctenc').write_bytes((self.root/'capture.ctenc').read_bytes());(bundle/'ENVELOPE.json').write_text(json.dumps(envelope));(bundle/'READY.json').write_text(json.dumps({'context':self.context,'encryptedCaptureReady':True,'completionCreditFinalized':True,'completionBudgetExhausted':False,'bytes':envelope['bytes'],'sha256':envelope['sha256']}));code=self.root/'code';code.mkdir();(code/'recipient-public.json').write_text(json.dumps(self.public));(code/'native-inputs.json').write_bytes((HERE/'native-inputs.json').read_bytes());spec=importlib.util.spec_from_file_location('local_recovery_whole',HERE/'recover-private-capture.py');R=importlib.util.module_from_spec(spec);spec.loader.exec_module(R)
  with patch.object(R,'HERE',code):receipt=R.recover(bundle,self.root/'recovery',self.keys/'key.pem',self.context)
  self.assertTrue(receipt['authenticatedRecovery']);self.assertFalse(receipt['producerObservation']['acceptedOriginalProducerObservation']);self.assertFalse(receipt['fullSDKSourceBuildLegalOrGateAClosureClaimed']);self.assertEqual((self.root/'recovery/capture/RESULT.json').read_bytes(),(self.capture/'RESULT.json').read_bytes());self.assertFalse((self.root/'recovery/key.pem').exists())
 def test_local_recovery_rejects_nonfinal_ready_before_decryption_or_plaintext(self):
  archive,plain,envelope=self.encrypt();bundle=self.root/'bundle';bundle.mkdir();(bundle/'ENVELOPE.json').write_text(json.dumps(envelope));(bundle/'READY.json').write_text(json.dumps({'context':self.context,'encryptedCaptureReady':False,'completionCreditFinalized':True,'completionBudgetExhausted':True}));spec=importlib.util.spec_from_file_location('local_recovery_late',HERE/'recover-private-capture.py');R=importlib.util.module_from_spec(spec);spec.loader.exec_module(R)
  with self.assertRaisesRegex(ValueError,'timely'):R.recover(bundle,self.root/'recovery',self.keys/'key.pem',self.context)
  self.assertFalse((self.root/'recovery').exists())
 def test_timely_capture_ready_is_physical_readable_hash_metadata(self):
  upload=self.root/'upload';upload.mkdir()
  with patch.object(E.time,'monotonic',return_value=10):ready=E.finalize_upload(upload,self.context,5,'a'*64,100,0)
  self.assertTrue(ready['encryptedCaptureReady']);self.assertTrue(ready['completionCreditFinalized']);self.assertFalse(ready['completionBudgetExhausted']);self.assertEqual(json.loads((upload/'READY.json').read_bytes()),ready);self.assertEqual((upload/'READY.json').stat().st_mode&0o777,0o444)
 def test_expired_capture_ready_never_credits_physical_result(self):
  upload=self.root/'upload';upload.mkdir()
  with patch.object(E.time,'monotonic',return_value=101):ready=E.finalize_upload(upload,self.context,5,'a'*64,100,0)
  self.assertFalse(ready['encryptedCaptureReady']);self.assertTrue(ready['completionBudgetExhausted']);self.assertEqual(json.loads((upload/'READY.json').read_bytes()),ready)
 def test_capture_ready_late_after_persistence_is_revoked(self):
  upload=self.root/'upload';upload.mkdir();clock=iter([10,10,101])
  with patch.object(E.time,'monotonic',side_effect=lambda:next(clock,101)):ready=E.finalize_upload(upload,self.context,5,'a'*64,100,0)
  self.assertFalse(ready['encryptedCaptureReady']);self.assertTrue(ready['completionBudgetExhausted']);self.assertEqual(json.loads((upload/'READY.json').read_bytes()),ready)
 def test_pack_cap_and_symbolic_member_refuse(self):
  with patch.object(E,'MAX_PACK',10):
   with self.assertRaisesRegex(ValueError,'ceiling'):E.pack(self.capture,self.root/'too-big.tar.gz',time.monotonic()+30)
  (self.capture/'link').symlink_to('RESULT.json')
  with self.assertRaisesRegex(ValueError,'Physical'):E.pack(self.capture,self.root/'link.tar.gz',time.monotonic()+30)
  self.assertFalse((self.root/'link.tar.gz').exists())
if __name__=='__main__':unittest.main()
