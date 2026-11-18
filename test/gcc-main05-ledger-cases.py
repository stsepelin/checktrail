"""Synthetic actual-signal accounting; no source/producer execution."""
import copy
import importlib.util
from pathlib import Path
import unittest

ROOT=Path(__file__).resolve().parent.parent

def load(path):
 spec=importlib.util.spec_from_file_location(path.stem.replace('-','_'),path);v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);return v

m=load(ROOT/'scripts/producer-qualification/gcc-staged-plan.py')
f=load(ROOT/'test/gcc-staged-cases.py')


class SignalLedger(unittest.TestCase):
 def fixture(self):
  config=f.configuration(hppa64=True);ledger=m.new_ledger(config)
  ledger=m.append_attempt(ledger,config,f.completed(ledger,config));row=f.completed(ledger,config)
  row.update(outcome='failed',exitCode=None,signal=15,terminalObserved=True,checkpointSha256=None,stampIdentities=[],nativeSeconds=100)
  return config,ledger,row

 def test_actual_signal_is_charged_without_checkpoint_advance_or_invented_exit(self):
  config,ledger,row=self.fixture();before=m.validate_ledger(ledger,config);result=m.append_attempt(ledger,config,row)
  selected,tip,spent,completed,last=m.validate_ledger(result,config)
  self.assertEqual(completed,1);self.assertEqual(last,before[-1]);self.assertEqual(spent,before[2]+100)
  self.assertEqual(selected['phases'][completed]['phase'],'native');self.assertEqual(tip,m.sha(m.canonical(row)))
  self.assertIsNone(result['attempts'][-1]['exitCode']);self.assertEqual(result['attempts'][-1]['signal'],15)
  self.assertEqual(row['predecessorSha256'],before[1]);self.assertTrue(result['attempts'][-1]['terminalObserved'])

 def test_legacy_nonzero_exit_remains_valid_and_missing_mixed_bool_or_out_of_range_signal_refuses(self):
  config,ledger,row=self.fixture();legacy={**row,'exitCode':3};legacy.pop('signal');m.append_attempt(ledger,config,legacy)
  for signal in [None,False,True,0,-1,128,'15']:
   changed={**row,'signal':signal}
   with self.subTest(signal=signal),self.assertRaises(ValueError):m.append_attempt(ledger,config,changed)
  for signal in [1,127]:m.append_attempt(ledger,config,{**row,'signal':signal})
  for code in [-15,256,True]:
   with self.subTest(code=code),self.assertRaises(ValueError):m.append_attempt(ledger,config,{**legacy,'exitCode':code})
  for changed in [{**row,'exitCode':3},{**row,'terminalObserved':False},{**row,'checkpointSha256':'a'*64},{**row,'exitCode':0,'signal':None}]:
   with self.subTest(changed=changed),self.assertRaises(ValueError):m.append_attempt(ledger,config,changed)

 def test_known_signal_cannot_be_hidden_in_completed_retention_failed_or_unknown_timeout(self):
  config,ledger,row=self.fixture()
  complete=f.completed(ledger,config);complete['signal']=15
  with self.assertRaises(ValueError):m.append_attempt(ledger,config,complete)
  retained={**row,'outcome':'retention-failed','exitCode':0,'quiescenceObserved':True,'retentionStage':'capture','retentionFailure':'Synthetic capture failure'}
  with self.assertRaises(ValueError):m.append_attempt(ledger,config,retained)
  unknown={**row,'outcome':'timeout-incomplete','terminalObserved':False}
  with self.assertRaises(ValueError):m.append_attempt(ledger,config,unknown)
  unknown.pop('signal');m.append_attempt(ledger,config,unknown)

 def test_old_rows_are_not_rewritten_and_their_existing_hash_chain_is_preserved(self):
  config,ledger,row=self.fixture();before=copy.deepcopy(ledger);tip=m.validate_ledger(ledger,config)[1]
  self.assertNotIn('signal',ledger['attempts'][0]);result=m.append_attempt(ledger,config,row)
  self.assertEqual(ledger,before);self.assertEqual(result['attempts'][0],before['attempts'][0])
  self.assertNotIn('signal',result['attempts'][0]);self.assertEqual(result['attempts'][-1]['predecessorSha256'],tip)


if __name__=='__main__':unittest.main(verbosity=2)
