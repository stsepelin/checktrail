"""Tree common.process cleanup regression; synthetic children only."""
from pathlib import Path
import importlib.util,os,subprocess,sys,tempfile,time,unittest
from unittest import mock
HERE=Path(__file__).resolve().parent;SOURCE=HERE/'reused-sdk-crypto/common.py'
spec=importlib.util.spec_from_file_location('tree_common_old',SOURCE);C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
class CommonRegression(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='checktrail-tree-common-old-');self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name).resolve();self.original=C.subprocess.Popen;self.children=[]
 def spawn(self,*args,**kwargs):
  p=self.original(*args,**kwargs);self.children.append(p);return p
 def tearDown(self):
  for p in self.children:
   try:p.wait(timeout=3)
   except subprocess.TimeoutExpired:p.kill();p.wait(timeout=2)
 def test_common_output_guard_must_keep_refusal_and_receipt_on_eperm(self):
  out=self.root/'bound';error=None
  with mock.patch.object(C.subprocess,'Popen',side_effect=self.spawn),mock.patch.object(C.os,'killpg',side_effect=PermissionError(1,'synthetic denied signal')):
   try:C.process([sys.executable,'-I','-B','-c','import os,time;os.write(1,b"x"*65);time.sleep(1)'],out,time.monotonic()+5,cap=64)
   except BaseException as caught:error=caught
  self.assertIsInstance(error,C.Refusal,'common output Refusal must survive cleanup EPERM')
  self.assertTrue(out.with_suffix('.receipt.json').exists(),'bounded failure receipt must survive cleanup EPERM')
 def test_common_deadline_must_keep_receipt_on_eperm(self):
  out=self.root/'deadline';error=None;value=None
  with mock.patch.object(C.subprocess,'Popen',side_effect=self.spawn),mock.patch.object(C.os,'killpg',side_effect=PermissionError(1,'synthetic denied signal')):
   try:value=C.process([sys.executable,'-I','-B','-c','import time;time.sleep(1)'],out,time.monotonic()+.05)
   except BaseException as caught:error=caught
  self.assertIsNone(error,'common deadline is a returned failure receipt, never cleanup PermissionError')
  self.assertIsNotNone(value[0]['reason']);self.assertTrue(out.with_suffix('.receipt.json').exists())
if __name__=='__main__':unittest.main()
