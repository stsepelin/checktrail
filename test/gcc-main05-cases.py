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
result=unittest.TextTestRunner(verbosity=2).run(suite)
print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skips':len(result.skipped),
 'sourceOrCompilerOrSdkOrDockerExecuted':False,'native05Granted':False}))
sys.exit(0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1)
