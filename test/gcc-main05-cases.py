"""Run only first-party synthetic original-main05 controls; no producer execution."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parent
CASES=['attempt','capacity','driver','export','history','ledger','observer','retain','sdk','sdk-image','service','stage','start','state','transport']
suite=unittest.TestSuite()
for name in CASES:
 path=ROOT/('gcc-main05-'+name+'-cases.py')
 spec=importlib.util.spec_from_file_location('main05_'+name.replace('-','_'),path)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
path=ROOT/'gcc-staged-phase-contract-cases.py'
spec=importlib.util.spec_from_file_location('finite_phase_contract',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
STAGED_CASES=['host-activation','host-bridge','selected-body','phase-evidence']
for name in STAGED_CASES:
 path=ROOT/('gcc-staged-'+name+'-cases.py')
 spec=importlib.util.spec_from_file_location('staged_'+name.replace('-','_'),path)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))

NATIVE_CASES=['noexport','sdk-local','assembly']
for name in NATIVE_CASES:
 path=ROOT/('gcc-native05-'+name+'-cases.py')
 spec=importlib.util.spec_from_file_location('native05_'+name.replace('-','_'),path)
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))

class CoverageResult(unittest.TextTestResult):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,**kwargs)
  self.executed_case_modules=set()
 def startTest(self,test):
  super().startTest(test)
  self.executed_case_modules.add(test.__class__.__module__)

result=unittest.TextTestRunner(verbosity=2,resultclass=CoverageResult).run(suite)
print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),
 'sourceOrCompilerOrSdkOrDockerExecuted':False,'native05Granted':False,
 'executedCaseModules':sorted(result.executed_case_modules)}))
sys.exit(0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1)
