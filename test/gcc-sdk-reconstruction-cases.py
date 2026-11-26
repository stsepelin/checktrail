"""Run the finite SDK synthetic family with one real unittest counter schema.

Legacy entries print JSON counters; newer entries use unittest.main with only
stderr. Import each explicit first-party module and execute its actual declared
unittest cases uniformly. No missing CLI counter field is accepted as evidence.
"""
import ast
import contextlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

HERE=Path(__file__).resolve().parent
CASE_MODULES=(
    'gcc-sdk-material-cases.py',
    'gcc-sdk-hosted-cases.py',
    'gcc-sdk-derived-cases.py',
    'gcc-sdk-derived-run-cases.py',
    'gcc-sdk-format-layout-cases.py',
    'gcc-sdk-structured-diagnostics-cases.py',
    'gcc-sdk-unrecognized-row-cases.py',
    'gcc-sdk-footer-layout-cases.py',
    'gcc-sdk-empty-false-cases.py',
    'gcc-sdk-onhost-receipt-cases.py',
)

class ObservedResult(unittest.TextTestResult):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs);self.started=[];self.passed=[];self.terminal=[]
    def startTest(self,test):super().startTest(test);self.started.append(test.id())
    def addSuccess(self,test):super().addSuccess(test);self.passed.append(test.id())
    def stopTest(self,test):super().stopTest(test);self.terminal.append(test.id())

def main():
    if len(sys.argv)!=1:raise ValueError('Fixed SDK synthetic family requires no arguments')
    suite=unittest.TestSuite();expected=[];owners={};declared={}
    with contextlib.redirect_stdout(sys.stderr):
        for file in CASE_MODULES:
            path=HERE/file
            if path.is_symlink() or not path.is_file():raise ValueError('Physical SDK synthetic module required: '+file)
            name=path.stem.replace('-','_');tree=ast.parse(path.read_bytes())
            ids=[name+'.'+cls.name+'.'+method.name for cls in tree.body if isinstance(cls,ast.ClassDef)
                 for method in cls.body if isinstance(method,ast.FunctionDef) and method.name.startswith('test')]
            if not ids or len(ids)!=len(set(ids)) or any(identity in owners for identity in ids):raise ValueError('Nonempty unique declared SDK case identities required: '+file)
            expected+=ids;declared[file]=ids
            for identity in ids:owners[identity]=file
            spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            suite.addTests(unittest.defaultTestLoader.loadTestsFromModule(module))
        result=unittest.TextTestRunner(stream=sys.stderr,verbosity=2,resultclass=ObservedResult).run(suite)
    def module_ids(ids,file):return [identity for identity in ids if owners.get(identity)==file]
    module_counts={file:{'declared':len(ids),'started':len(module_ids(result.started,file)),
                       'passed':len(module_ids(result.passed,file)),'terminal':len(module_ids(result.terminal,file))}
                   for file,ids in declared.items()}
    actual_modules=sorted({owners[identity] for identity in result.started if identity in owners})
    exact=(sorted(expected)==sorted(result.started)==sorted(result.passed)==sorted(result.terminal) and
           len(set(result.started))==len(expected) and actual_modules==sorted(CASE_MODULES))
    qualified=result.wasSuccessful() and not result.skipped and not result.expectedFailures and not result.unexpectedSuccesses and exact
    value={'schemaVersion':1,'qualified':qualified,'caseModules':list(CASE_MODULES),'executedCaseModules':actual_modules,
           'expectedCaseIds':sorted(expected),'startedCaseIds':result.started,'passedCaseIds':result.passed,'terminalCaseIds':result.terminal,
           'moduleCounts':module_counts,'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),
           'skips':len(result.skipped),'expectedFailures':len(result.expectedFailures),'unexpectedSuccesses':len(result.unexpectedSuccesses),
           'dockerCompilerOrUpstreamExecuted':False}
    print(json.dumps(value,sort_keys=True,separators=(',',':')))
    return 0 if qualified else 1

if __name__=='__main__':raise SystemExit(main())
