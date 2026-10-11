// The plugin records native exception identity per pytest phase; a rendered
// traceback containing an assertion word cannot manufacture a killed mutation.
export const mutationPytestRunner = String.raw`
import contextlib
import json
import pathlib
import sys
root=str(pathlib.Path(sys.argv[1]).resolve())
sys.path[:0]=[root,str(pathlib.Path(root)/".checktrail/mutation-python-tools")]
try:
    import pytest
except ModuleNotFoundError as error:
    if error.name != "pytest":
        raise
    print(json.dumps({"format":"checktrail-mutation-pytest-1","unavailable":"pytest"}))
    sys.exit(3)
if sys.version_info[:3] != (3,12,13) or pytest.__version__ != "9.1.1":
    print(json.dumps({"format":"checktrail-mutation-pytest-1","unavailable":"version"}))
    sys.exit(3)
class Evidence:
    def __init__(self):
        self.items=[]
        self.reports=[]
        self.typed={}
        self.deselected=[]
        self.collection_errors=[]
        self.finished=False
    def pytest_collection_finish(self,session):
        self.items=[{"id":item.nodeid,"file":str(item.path.resolve()),"line":item.location[1]+1} for item in session.items]
    def pytest_deselected(self,items):
        self.deselected.extend(item.nodeid for item in items)
    def pytest_collectreport(self,report):
        if report.failed:
            self.collection_errors.append(report.nodeid)
    @pytest.hookimpl(wrapper=True)
    def pytest_runtest_makereport(self,item,call):
        report=yield
        error=None if call.excinfo is None else call.excinfo.value
        self.typed[(item.nodeid,call.when)]=None if error is None else {"name":type(error).__module__+"."+type(error).__qualname__,"assertion":isinstance(error,AssertionError)}
        return report
    def pytest_runtest_logreport(self,report):
        self.reports.append({"id":report.nodeid,"phase":report.when,"outcome":report.outcome,"xfail":hasattr(report,"wasxfail"),"exception":self.typed.get((report.nodeid,report.when))})
    def pytest_sessionfinish(self,session,exitstatus):
        self.finished=True
plugin=Evidence()
files=[str(pathlib.Path(file).resolve()) for file in sys.argv[2:]]
with contextlib.redirect_stdout(sys.stderr):
    code=pytest.main(["--capture=no","-o","addopts=","-o","xfail_strict=true","--maxfail=0","-p","no:cacheprovider","-p","no:terminal","--",*files],plugins=[plugin])
print(json.dumps({"schemaVersion":1,"format":"checktrail-mutation-pytest-1","python":".".join(map(str,sys.version_info[:3])),"version":pytest.__version__,"selectedFiles":files,"exitCode":int(code),"finished":plugin.finished,"items":plugin.items,"reports":plugin.reports,"deselected":plugin.deselected,"collectionErrors":plugin.collection_errors}))
sys.exit(int(code))
`;
