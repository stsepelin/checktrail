import type { Check, Project } from "./types.js";

const runner = String.raw`
import contextlib
import io
import json
import os
import pathlib
import sys

def unavailable(reason):
    print(json.dumps({"format": "repo-verifier-mypy-1", "unavailable": reason}))
    sys.exit(3)

try:
    from mypy import api
    from mypy.version import __version__
except ModuleNotFoundError as error:
    if error.name != "mypy":
        raise
    unavailable("mypy is not installed")
if __version__ != "2.3.1":
    unavailable("mypy version is outside the verified options API contract: " + __version__)

from mypy.main import process_options

files = [str(pathlib.Path(file).resolve()) for file in sys.argv[1:]]
config = next((name for name in ["mypy.ini", ".mypy.ini", "pyproject.toml", "setup.cfg"] if pathlib.Path(name).is_file()), os.devnull)
args = ["--config-file", config, "--no-incremental", "--cache-dir", os.devnull, "--no-install-types", "--check-untyped-defs", "--warn-unused-ignores", "--no-pretty", "--no-color-output", "--error-summary", "--", *files]
capture = io.StringIO()
with contextlib.redirect_stdout(sys.stderr):
    sources, options = process_options(args, stdout=capture, stderr=capture)
    suppressed = [str(pathlib.Path(source.path).resolve()) for source in sources if source.path and options.clone_for_module(source.module).ignore_errors]
    stdout, stderr, code = api.run(args)
print(json.dumps({"format": "repo-verifier-mypy-1", "version": __version__, "files": [str(pathlib.Path(source.path).resolve()) for source in sources if source.path], "suppressedFiles": suppressed, "stdout": stdout, "stderr": capture.getvalue() + stderr, "exitCode": code}))
sys.exit(code)
`;

export function mypyCheck(project: Project): Check {
  const files = project.files.filter((file) => /\.pyi?$/.test(file));
  const check: Check = {
    id: "python.mypy",
    adapter: project.adapter,
    project: project.path,
    scope: files,
    kind: "analysis",
    parser: "mypy-json",
    commands: [
      {
        executable: "python3",
        args: ["-c", runner, ...files],
        cwd: project.path,
        env: { PYTHONDONTWRITEBYTECODE: "1" },
      },
    ],
    reason:
      "Run installed mypy with explicit source accounting, disabled stub installation/cache writes and broad error-suppression detection.",
  };
  if (!files.length)
    check.unavailableReason =
      "No Python source or stub files were inventoried.";
  return check;
}
