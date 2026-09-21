export const pytestRunner = String.raw`
import contextlib
import json
import pathlib
import sys

try:
    import pytest
except ModuleNotFoundError as error:
    if error.name != "pytest":
        raise
    print(json.dumps({"format": "checktrail-pytest-1", "unavailable": "pytest"}))
    sys.exit(3)

class Evidence:
    def __init__(self):
        self.items = []
        self.reports = []
        self.deselected = []
        self.collection_errors = []
        self.finished = False

    def pytest_collection_finish(self, session):
        self.items = [{"id": item.nodeid, "file": str(item.path.resolve())} for item in session.items]

    def pytest_deselected(self, items):
        self.deselected.extend(item.nodeid for item in items)

    def pytest_collectreport(self, report):
        if report.failed:
            self.collection_errors.append(report.nodeid)
            print(str(report.longrepr), file=sys.stderr)

    def pytest_runtest_logreport(self, report):
        self.reports.append({"id": report.nodeid, "phase": report.when, "outcome": report.outcome, "xfail": hasattr(report, "wasxfail")})
        if report.failed:
            print(str(report.longrepr), file=sys.stderr)

    def pytest_sessionfinish(self, session, exitstatus):
        self.finished = True

plugin = Evidence()
files = [str(pathlib.Path(file).resolve()) for file in sys.argv[1:]]
with contextlib.redirect_stdout(sys.stderr):
    code = pytest.main(["-o", "addopts=", "-o", "xfail_strict=true", "--maxfail=0", "-p", "no:cacheprovider", "-p", "no:terminal", "--", *files], plugins=[plugin])
print(json.dumps({"format": "checktrail-pytest-1", "version": pytest.__version__, "exitCode": int(code), "finished": plugin.finished, "items": plugin.items, "reports": plugin.reports, "deselected": plugin.deselected, "collectionErrors": plugin.collection_errors}))
sys.exit(int(code))
`;
