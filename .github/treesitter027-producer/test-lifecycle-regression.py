"""Native controller cleanup regression; synthetic children only."""
import importlib.util,json,os,signal,subprocess,sys,tempfile,time,unittest
from pathlib import Path
from unittest import mock
HERE=Path(__file__).resolve().parent
path=HERE/'reused-native-v5/controller.py';spec=importlib.util.spec_from_file_location('old_tree',path);M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)
class CleanupRegression(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='checktrail-tree-old-causal-');self.addCleanup(self.temp.cleanup);self.work=Path(self.temp.name).resolve();(self.work/'capture').mkdir();self.children=[];self.original=M.subprocess.Popen
 def spawn(self,*a,**kw):
  p=self.original(*a,**kw);self.children.append(p);return p
 def tearDown(self):
  for p in self.children:
   try:p.wait(timeout=3)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=3)
 def test_native_eperm_must_not_replace_log_guard(self):
  limits={**M.LIMITS,'logBytes':64};host={'buildUid':os.getuid(),'buildUser':'nobody'}
  with mock.patch.object(M,'ps_rows',return_value=[]),mock.patch.dict(M.LIMITS,limits),mock.patch.object(M.subprocess,'Popen',side_effect=self.spawn),mock.patch.object(M.os,'killpg',side_effect=PermissionError(1,'synthetic denied signal')):
   native=M.Native(self.work,host);error=None
   try:native.run('synthetic-overflow',[sys.executable,'-I','-B','-c','import os;os.write(1,b"x"*65)'],dict(os.environ),self.work,5,as_build=False)
   except BaseException as caught:error=caught
   self.assertIsInstance(error,ValueError,'original ValueError log guard must survive cleanup EPERM')
   self.assertEqual(str(error),'Native aggregate log ceiling')
   self.assertTrue((self.work/'capture/PHASES.json').exists(),'failure accounting must persist')
 def test_finished_query_eperm_must_not_replace_success(self):
  with mock.patch.object(M.subprocess,'Popen',side_effect=self.spawn),mock.patch.object(M.os,'killpg',side_effect=PermissionError(1,'synthetic denied signal')):
   error=None;value=None
   try:value=M.capture_control_query(self.work/'capture','synthetic-query',[sys.executable,'-I','-B','-c','pass'],dict(os.environ),seconds=5)
   except BaseException as caught:error=caught
   self.assertIsNone(error,'finished/reaped child must never cause an unauthorized group signal')
   self.assertEqual(value[0],0)
if __name__=='__main__':unittest.main()
