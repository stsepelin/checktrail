"""Run only first-party synthetic original-main05 controls; no producer execution."""
import importlib.util
import json
from pathlib import Path
import sys
import unittest

ROOT=Path(__file__).resolve().parent
CASES=['attempt','capacity','container-identity','driver','export','history','ledger','observer','retain','sdk','sdk-image','service','stage','start','state','transport']
GROUPS = {
 'core': [('gcc-main05-'+name+'-cases.py', 'main05_'+name.replace('-', '_')) for name in CASES],
 'continuation': [('gcc-staged-phase-contract-cases.py', 'finite_phase_contract')] + [
  ('gcc-staged-'+name+'-cases.py', 'staged_'+name.replace('-', '_'))
  for name in ['host-activation','host-bridge','selected-body','phase-evidence']],
 'native': [('gcc-native05-'+name+'-cases.py', 'native05_'+name.replace('-', '_'))
  for name in ['noexport','sdk-local','assembly']],
}
if len(sys.argv) > 2 or (len(sys.argv) == 2 and sys.argv[1] not in GROUPS):
 raise SystemExit('Expected one fixed synthetic group: core, continuation or native')
selected = list(GROUPS) if len(sys.argv) == 1 else sys.argv[1:]
manifest = {group: [module for _,module in entries] for group,entries in GROUPS.items()}
all_modules = [module for modules in manifest.values() for module in modules]
if len(all_modules) != len(set(all_modules)):
 raise SystemExit('Synthetic case groups overlap')
suite=unittest.TestSuite()
discovered=0
for group in selected:
 for filename,name in GROUPS[group]:
  spec=importlib.util.spec_from_file_location(name,ROOT/filename)
  module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
  cases=unittest.defaultTestLoader.loadTestsFromModule(module)
  if cases.countTestCases() == 0:
   raise SystemExit('Empty synthetic module: '+name)
  discovered += cases.countTestCases()
  suite.addTests(cases)

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
 'executedCaseModules':sorted(result.executed_case_modules),'groupManifest':manifest,'selectedGroups':selected,'discoveredCases':discovered}))
sys.exit(0 if result.wasSuccessful() and result.testsRun>0 and not result.skipped else 1)
