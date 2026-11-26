import copy,importlib.util,pathlib,sys,unittest
from unittest import mock
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import collect as m
import transport_base
class Controls(unittest.TestCase):
 def setUp(self):
  clock=mock.patch.object(m.time,'monotonic',return_value=0);clock.start();self.addCleanup(clock.stop)
  self.ctx={'run':12,'head':'a'*40,'nonce':'synthetic','attempt':1};self.row={'ordinal':1,'artifactID':34,'carrierBytes':15,'carrierSHA256':'b'*64};self.meta={'id':34,'name':m.name(self.ctx,1),'size_in_bytes':15,'expired':False,'digest':'sha256:'+'b'*64,'workflow_run':{'id':12,'head_sha':'a'*40}};self.expected=m.expected_descriptor(self.meta,self.row,self.ctx)
 def calls(self,values):
  class Calls:
   def __init__(self):self.values=iter(values);self.requests=0
   def metadata(self,path,missing):self.requests+=1;self.path=path;self.missing=missing;return next(self.values)
   def delete(self,*args):raise AssertionError('absence check must never issue DELETE')
  return Calls()
 def test_immediate_actual404_requires_one_request_and_no_delete(self):
  c=self.calls([None]);self.assertEqual(m.wait_exact_absence(c,self.row,self.ctx,100,self.expected),{'exact404':True,'observations':1});self.assertTrue(c.missing);self.assertTrue(c.path.endswith('/34'))
 def test_same_owned200_then404_is_bounded_and_keeps_absence_authority_at404(self):
  c=self.calls([self.meta,self.meta,None])
  with mock.patch.object(m.time,'sleep') as sleep:proof=m.wait_exact_absence(c,self.row,self.ctx,100,self.expected)
  self.assertEqual(proof,{'exact404':True,'observations':3});self.assertEqual(sleep.call_args_list,[mock.call(1),mock.call(1)])
 def test_changed_owned_identity_or_zip_descriptor_is_rejected(self):
  for field,value in [('id',35),('name','foreign'),('size_in_bytes',16),('digest','sha256:'+'c'*64),('workflow_run',{'id':13,'head_sha':'a'*40})]:
   changed=copy.deepcopy(self.meta);changed[field]=value
   with self.subTest(field=field),self.assertRaises(m.Refusal):m.wait_exact_absence(self.calls([changed]),self.row,self.ctx,100,self.expected)
 def test_service_digest_seen_at_custody_must_be_reported_again_before_delete(self):
  observed={**self.row,'serviceDigest':'sha256:'+'b'*64};vanished={**self.meta,'digest':None}
  with self.assertRaisesRegex(m.Refusal,'same original immutable owned ZIP descriptor'):m.expected_descriptor(vanished,observed,self.ctx)
  self.assertEqual(m.expected_descriptor(self.meta,observed,self.ctx)['digest'],'sha256:'+'b'*64)
  # Never reported by the service at custody: an absent digest stays acceptable.
  self.assertIsNone(m.expected_descriptor(vanished,self.row,self.ctx)['digest'])
 def test_digest_first_reported_during_the_wait_is_verified_and_then_kept(self):
  # The pre-delete descriptor had no digest; a later 200 may supply the one
  # matching the retained ZIP, once, and must keep it.
  undigested={**self.meta,'digest':None};expected=m.expected_descriptor(undigested,self.row,self.ctx);self.assertIsNone(expected['digest'])
  with mock.patch.object(m.time,'sleep'):
   self.assertEqual(m.wait_exact_absence(self.calls([undigested,self.meta,self.meta,None]),self.row,self.ctx,100,expected),{'exact404':True,'observations':4})
   for label,values,message in [('vanished',[self.meta,undigested],'same owned descriptor during bounded consistency wait'),('wrong',[{**self.meta,'digest':'sha256:'+'4'*60+'3517'}],'same original immutable owned ZIP descriptor')]:
    with self.subTest(label=label),self.assertRaisesRegex(m.Refusal,message):m.wait_exact_absence(self.calls(values),self.row,self.ctx,100,expected)
 def test_persistent200_never_becomes_absence_and_has_exact_request_bound(self):
  c=self.calls([self.meta]*16)
  with mock.patch.object(m.time,'sleep'),self.assertRaisesRegex(m.Refusal,'consistency wait exhausted'):m.wait_exact_absence(c,self.row,self.ctx,100,self.expected)
  self.assertEqual(c.requests,16)
 def test_expired_original_budget_does_not_start_a_request(self):
  c=self.calls([])
  with mock.patch.object(m.time,'monotonic',return_value=100),self.assertRaisesRegex(m.Refusal,'before absence'):m.wait_exact_absence(c,self.row,self.ctx,100,self.expected)
  self.assertEqual(c.requests,0)
 def test_late404_is_not_credited(self):
  c=self.calls([None])
  with mock.patch.object(m.time,'monotonic',side_effect=[0,101]),self.assertRaisesRegex(m.Refusal,'within original recovery budget'):m.wait_exact_absence(c,self.row,self.ctx,100,self.expected)
 def test_transport_refusal_cannot_become_absence(self):
  c=self.calls([]);c.metadata=mock.Mock(side_effect=m.Refusal('HTTP403'))
  with self.assertRaisesRegex(m.Refusal,'HTTP403'):m.wait_exact_absence(c,self.row,self.ctx,100,self.expected)
 def test_transport_actual404_requires_cli1_and_rejects_signal_or_inconsistent_exit(self):
  for rc in [0,1,2,-9]:
   calls=object.__new__(transport_base.Calls);calls.deadline=100;calls.events=[];calls.run=lambda *args:(rc,b'HTTP/2 404\n\n{}',None)
   with self.subTest(rc=rc):
    if rc==1:self.assertIsNone(calls.metadata('synthetic',missing=True))
    else:
     with self.assertRaisesRegex(transport_base.Refusal,'exact404 CLI1'):calls.metadata('synthetic',missing=True)
if __name__=='__main__':unittest.main(verbosity=2)
