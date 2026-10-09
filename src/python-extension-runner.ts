import { pythonExtensionPins } from "./python-extension-pins.js";
export const pythonExtensionRunner = String.raw`
import contextlib
import hashlib
import importlib.metadata as metadata
import io
import json
import os
import pathlib
import platform
import sys

manifest = json.loads(sys.argv[1])
expected_pins = json.loads(${JSON.stringify(JSON.stringify(pythonExtensionPins))})
root = pathlib.Path.cwd().resolve()
temporary = os.environ.get("CHECKTRAIL_TEMP")
if not temporary or not pathlib.Path(temporary).is_dir():
    print(json.dumps({"format":"checktrail-python-extensions-1","unavailable":"Owned Python temporary directory is missing"}))
    sys.exit(3)
# -B prevents writes but still reads timestamp-valid bytecode. Use the new owned prefix for reads too.
sys.pycache_prefix = str(pathlib.Path(temporary)/"bytecode")
def unavailable(reason):
    print(json.dumps({"format":"checktrail-python-extensions-1","unavailable":reason}))
    sys.exit(3)
def contained(relative):
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError("Python input escapes project")
    return path
def verify_file(item):
    path=contained(item["path"])
    with path.open("rb") as stream:
        data=stream.read(8*1048576+1)
    if len(data)!=item["bytes"] or hashlib.sha256(data).hexdigest()!=item["sha256"]:
        raise ValueError("Python input bytes changed")
def tool_gate():
    if manifest["toolPins"]!=expected_pins:
        raise ValueError("Python native API selection changed")
    for pin in expected_pins:
        distribution=metadata.distribution(pin["distribution"])
        if distribution.version!=pin["version"]:
            raise ValueError("Python native tool version is unavailable")
        file=pathlib.Path(distribution.locate_file(pin["file"]))
        # This selected contract observes pure-Python APIs, never a shadowing compiled API.
        stem=file.name.removesuffix(".py")
        if list(file.parent.glob(stem+".*.so")) or list(file.parent.glob(stem+".*.pyd")):
            raise ValueError("Compiled Python API is outside the selected contract")
        data=file.read_bytes()
        if len(data)!=pin["bytes"] or hashlib.sha256(data).hexdigest()!=pin["sha256"]:
            raise ValueError("Python native API bytes changed")
def input_gate():
    environment=manifest["config"].get("environment")
    if environment:
        site_prefix=environment["directory"]+"/lib/python3.12/site-packages/"
        expected={item["path"][len(site_prefix):] for item in manifest["bindings"] if item["path"].startswith(site_prefix)}
        observed=set()
        examined=0
        def walk(relative,depth=0):
            nonlocal examined
            examined+=1
            if examined>4096 or depth>32:raise ValueError("Python distribution tree exceeds its bound")
            path=contained(site_prefix+relative)
            lexical=root/(site_prefix+relative)
            if lexical.is_symlink():raise ValueError("Python distribution tree gained a link")
            if path.is_dir():
                for entry in path.iterdir():
                    if entry.name!="__pycache__":walk(relative+"/"+entry.name,depth+1)
            elif path.is_file() and not path.name.endswith(".pyc"):
                observed.add(relative)
            elif not path.is_file():raise ValueError("Python distribution tree has an unsupported entry")
        for top in sorted({name.split("/")[0] for name in expected}):walk(top)
        if observed!=expected:raise ValueError("Python distribution tree inputs changed")
    for item in manifest["bindings"]:
        verify_file(item)
    for item in manifest["sources"]:
        verify_file(item)
try:
    if sys.version_info[:3]!=(3,12,13) or sys.platform!="linux" or platform.machine()!="aarch64":
        raise ValueError("Python extension runtime is outside the selected native profile")
    input_gate()
    tool_gate()
    config=manifest["config"]
    environment=config.get("environment")
    if environment and pathlib.Path(sys.prefix).resolve()!=contained(environment["directory"]):
        raise ValueError("Python did not activate the declared virtualenv")
    packages=[]
    for dependency in manifest["environmentPackages"]:
        selected=metadata.distribution(dependency["name"])
        file=pathlib.Path(selected._path)/"METADATA"
        if selected.version!=dependency["version"] or file.resolve()!=contained(dependency["metadata"]):
            raise ValueError("Python selected a different virtualenv distribution")
        packages.append(dependency)
except (OSError, ValueError, metadata.PackageNotFoundError) as error:
    unavailable(str(error))

roots=[str(contained(path)) for path in config["moduleRoots"]]
files=[str(contained(item["path"])) for item in manifest["sources"]]
for directory in reversed(roots):
    sys.path.insert(0,directory)
plugins=[]
modules=[]
dependency_participation=[]
native_graph=None
complete=False
inputs_stable=False
native=None
code=2
captured=io.StringIO()
try:
    with contextlib.redirect_stdout(sys.stderr):
        if manifest["kind"]=="pytest":
            import pytest
            declared=config["pytestPlugins"]
            for directory in reversed(list(dict.fromkeys(str(contained(p["path"]).parent) for p in declared))):
                sys.path.insert(0,directory)
            class Evidence:
                def __init__(self):
                    self.items=[]; self.reports=[]; self.deselected=[]; self.collection_errors=[]; self.finished=False
                def pytest_configure(self, config):
                    for declaration in declared:
                        unit=config.pluginmanager.get_plugin(declaration["module"])
                        actual=getattr(unit,"__file__",None)
                        plugins.append({"path":declaration["path"],"sha256":declaration["sha256"],"loaded":bool(actual and pathlib.Path(actual).resolve()==contained(declaration["path"]))})
                def pytest_collection_finish(self,session):
                    self.items=[{"id":item.nodeid,"file":str(item.path.resolve())} for item in session.items]
                def pytest_deselected(self,items):
                    self.deselected.extend(item.nodeid for item in items)
                def pytest_collectreport(self,report):
                    if report.failed:
                        self.collection_errors.append(report.nodeid)
                        print(str(report.longrepr),file=sys.stderr)
                def pytest_runtest_logreport(self,report):
                    self.reports.append({"id":report.nodeid,"phase":report.when,"outcome":report.outcome,"xfail":hasattr(report,"wasxfail")})
                    if report.failed:print(str(report.longrepr),file=sys.stderr)
                def pytest_sessionfinish(self,session,exitstatus):
                    self.finished=True
            evidence=Evidence()
            temporary=os.environ.get("CHECKTRAIL_TEMP")
            if not temporary:raise ValueError("Owned Python test temporary directory is missing")
            args=["--disable-plugin-autoload","-o","addopts=","-o","xfail_strict=true","--maxfail=0","-p","no:cacheprovider","-p","no:terminal","--basetemp",str(pathlib.Path(temporary)/"pytest")]
            for declaration in declared:args.extend(["-p",declaration["module"]])
            code=int(pytest.main([*args,"--",*files],plugins=[evidence]))
            native={"format":"checktrail-pytest-1","version":pytest.__version__,"exitCode":code,"finished":evidence.finished,"items":evidence.items,"reports":evidence.reports,"deselected":evidence.deselected,"collectionErrors":evidence.collection_errors}
            complete=evidence.finished and len(plugins)==len(declared) and all(p["loaded"] for p in plugins)
        else:
            from mypy import api
            import mypy.build as build
            from mypy.main import process_options
            os.environ["MYPYPATH"]=os.pathsep.join(roots)
            native_config=next((name for name in ["mypy.ini",".mypy.ini","pyproject.toml","setup.cfg"] if pathlib.Path(name).is_file()),os.devnull)
            args=["--config-file",native_config,"--no-incremental","--cache-dir",os.devnull,"--no-install-types","--check-untyped-defs","--warn-unused-ignores","--no-pretty","--no-color-output","--error-summary","--namespace-packages","--explicit-package-bases","--python-executable",sys.executable,"--",*files]
            sources,options=process_options(args,stdout=captured,stderr=captured)
            declared=config["mypyPlugins"]
            if [str(contained(p)) for p in options.plugins]!=[str(contained(p["path"])) for p in declared]:
                raise ValueError("Mypy configured plugins differ from declared plugin entries")
            if options.mypy_path and [str(pathlib.Path(p).resolve()) for p in options.mypy_path]!=roots:
                raise ValueError("Mypy package bases differ from declared roots")
            source_files=[str(pathlib.Path(s.path).resolve()) for s in sources if s.path]
            selected=set(files)
            checked={}; finished={}; built=[]; plugin_calls=[]
            original_build=build.build
            original_plugins=build.load_plugins
            original_first=build.State.type_check_first_pass
            original_finish=build.State.finish_passes
            def observe_plugins(*args,**kwargs):
                result,snapshot=original_plugins(*args,**kwargs)
                plugin_calls.append(True)
                for declaration in declared:
                    matching=[]
                    for name in snapshot:
                        unit=sys.modules.get(name)
                        actual=getattr(unit,"__file__",None)
                        if actual and pathlib.Path(actual).resolve()==contained(declaration["path"]):matching.append(name)
                    plugins.append({"path":declaration["path"],"sha256":declaration["sha256"],"loaded":len(matching)==1})
                return result,snapshot
            def observe_first(state,*args,**kwargs):
                value=original_first(state,*args,**kwargs)
                file=str(pathlib.Path(state.path).resolve()) if state.path else None
                if file in selected and not state.options.semantic_analysis_only:
                    checked[file]=checked.get(file,0)+1
                return value
            def observe_finish(state,*args,**kwargs):
                value=original_finish(state,*args,**kwargs)
                file=str(pathlib.Path(state.path).resolve()) if state.path else None
                if file in selected and not state.options.semantic_analysis_only:
                    finished[file]=finished.get(file,0)+1
                return value
            def observe_build(*args,**kwargs):
                result=original_build(*args,**kwargs)
                built.append(result)
                return result
            build.build=observe_build
            build.load_plugins=observe_plugins
            build.State.type_check_first_pass=observe_first
            build.State.finish_passes=observe_finish
            try:
                stdout,stderr,code=api.run(args)
            finally:
                build.build=original_build
                build.load_plugins=original_plugins
                build.State.type_check_first_pass=original_first
                build.State.finish_passes=original_finish
            suppressed=[str(pathlib.Path(s.path).resolve()) for s in sources if s.path and options.clone_for_module(s.module).ignore_errors]
            if len(built)==1:
                result=built[0]
                native_graph=result.graph
                for source in sources:
                    if not source.path:continue
                    file=str(pathlib.Path(source.path).resolve())
                    state=result.graph.get(source.module)
                    if state is None or state.tree is None:continue
                    unruled=bool(state.ignore_all or state.options.ignore_errors or state.options.ignore_missing_imports or state.options.semantic_analysis_only or state.options.follow_imports in ["skip","silent"] or state.options.disable_error_code)
                    modules.append({"file":file,"module":source.module,"parsed":str(pathlib.Path(state.tree.path).resolve())==file,"typeChecked":checked.get(file,0)>0,"finished":finished.get(file,0)>0,"suppressed":unruled})
                complete=(set(source_files)==selected and len(source_files)==len(files) and len(modules)==len(files) and all(m["parsed"] and m["typeChecked"] and m["finished"] and not m["suppressed"] for m in modules) and len(plugin_calls)==1 and len(plugins)==len(declared) and all(p["loaded"] for p in plugins))
            native={"format":"checktrail-mypy-1","version":"2.3.1","files":source_files,"suppressedFiles":suppressed,"stdout":stdout,"stderr":captured.getvalue()+stderr,"exitCode":code}
except Exception as error:
    complete=False
    print(type(error).__name__+": "+str(error),file=sys.stderr)
    if native is None:code=2
try:
    for dependency in manifest["environmentPackages"]:
        selected_files=set()
        for name,unit in (sys.modules.items() if manifest["kind"]=="pytest" else (native_graph or {}).items()):
            if not any(name==prefix or name.startswith(prefix+".") for prefix in dependency["imports"]):continue
            actual=getattr(unit,"__file__",None) if manifest["kind"]=="pytest" else getattr(unit,"path",None)
            if actual:selected_files.add(str(pathlib.Path(actual).resolve()))
        expected={str(contained(item["path"])) for item in manifest["bindings"]}
        site=contained(config["environment"]["directory"]+"/lib/python3.12/site-packages")
        accounted=bool(selected_files) and all(file in expected and pathlib.Path(file).is_relative_to(site) for file in selected_files)
        dependency_participation.append({"metadata":dependency["metadata"],"files":sorted(selected_files),"complete":accounted})
        complete=complete and accounted
    input_gate()
    tool_gate()
    inputs_stable=True
except (OSError, ValueError, metadata.PackageNotFoundError) as error:
    complete=False
    print(str(error),file=sys.stderr)
print(json.dumps({"format":"checktrail-python-extensions-1","manifest":manifest,"python":".".join(map(str,sys.version_info[:3])),"environmentPackages":packages,"plugins":plugins,"modules":modules,"dependencyParticipation":dependency_participation,"complete":complete,"inputsStable":inputs_stable,"native":native,"exitCode":code}))
sys.exit(code)
`;
