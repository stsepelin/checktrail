"""Finite Docker API aliases, synthetic only."""
import copy,sys,pathlib,unittest
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import common,driver
class NativeIdentityControls(unittest.TestCase):
 def test_only_the_four_selected_supervisor_capabilities_admit_with_explicit_api_aliases(self):
  for caps in [['CHOWN','SETUID','SETGID','KILL'],['CAP_CHOWN','CAP_SETUID','CAP_SETGID','CAP_KILL'],['CAP_CHOWN','SETUID','CAP_SETGID','KILL']]:self.assertTrue(driver.native_identity_contract({'Config':{'User':'0:0'},'HostConfig':{'CapAdd':caps}}))
 def test_wrong_user_missing_extra_duplicate_unknown_prefix_and_nonlist_refuse(self):
  base={'Config':{'User':'0:0'},'HostConfig':{'CapAdd':['CHOWN','SETUID','SETGID','KILL']}}
  for caps in [None,[],['CHOWN','SETUID'],['CHOWN','SETUID','SETGID'],['CHOWN','SETUID','SETGID','KILL','SYS_ADMIN'],['CHOWN','CHOWN','SETGID','KILL'],['CAP_CAP_CHOWN','SETUID','SETGID','KILL'],['chown','SETUID','SETGID','KILL'],'CHOWN,SETUID,SETGID,KILL']:
   value=copy.deepcopy(base);value['HostConfig']['CapAdd']=caps
   with self.subTest(caps=caps),self.assertRaises(common.Refusal):driver.native_identity_contract(value)
  for user in ['0','root','0:1','10001:10001',None]:
   value=copy.deepcopy(base);value['Config']['User']=user
   with self.subTest(user=user),self.assertRaises(common.Refusal):driver.native_identity_contract(value)
if __name__=='__main__':unittest.main(verbosity=2)
