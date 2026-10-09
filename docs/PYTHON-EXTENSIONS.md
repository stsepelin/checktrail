# Declared Python extensions

`checktrail.python.json` selects explicit namespace source roots, optional local
virtualenv dependencies and project-enabled pytest/mypy plugins. Select
`python.pytest` and/or `python.mypy` in `checktrail.json`. Without this declaration,
the existing adapters keep their separate contracts.

```json
{
  "schemaVersion": 1,
  "moduleRoots": ["src", "src_extra", "tests"],
  "environment": {
    "directory": ".venv",
    "dependencies": [
      { "name": "original-synthetic-dependency", "version": "1.0.0" }
    ]
  },
  "pytestPlugins": [
    {
      "module": "case_plugin",
      "path": "plugins/case_plugin.py",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ],
  "mypyPlugins": [
    {
      "path": "plugins/type_rules.py",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ]
}
```

The hashes are placeholders: use the SHA-256 of each actual plugin file. Omit the
optional environment or unused plugin lists. Namespace roots can be `.` or
contained project-relative directories, without parent segments, redundant
separators, absolute paths or backslashes. The published schema is
`schemas/python-config.schema.json`.

Discovery and planning read data, source and package metadata. They never import
Python, `setup.py`, a plugin or a virtualenv interpreter, and never create an
environment or install a dependency. Execution requires operator trust in the
shared library, CLI or MCP engine. MCP arguments cannot grant execution trust or
detailed disclosure. Native tools and project code run under that trust; this
adapter is not a security sandbox.

## Selected native contract

The current extension profile requires Linux ARM64 Python 3.12.13, pytest 9.1.1,
mypy 2.3.1 and the selected pure-Python pytest/mypy/pluggy API bytes. A compiled API
shadowing a selected `.py` file is outside this profile. Other Python/platform
versions remain unavailable for this extension, without promoting the final Gate A
runtime matrix. Ruff retains its existing separate validation behavior.

Each module root contributes every inventoried `.py`/`.pyi` file under its exact
directory boundary to mypy. Pytest selects every `test_*.py` or `*_test.py` candidate
within those roots. Other source remains outside the declared validation scope;
this does not establish whole-project coverage or runtime reachability. Original
fixtures exercise one namespace across two roots without `__init__.py` files.

Mypy uses its native explicit package-base and namespace options with the declared
roots. Its configured plugin entries must match the declared file entries exactly;
custom entry functions and module-name plugin specifications are outside this
bounded profile. Each selected source must appear in native options and the fresh
build graph, reach native type checking and finish its passes. Semantic-only runs,
broad error suppression, skipped imports and incomplete graphs cannot pass even
when mypy prints a success summary. Disabled incremental caches, stub installation
and fresh native source accounting retain the legacy safeguards.

Pytest disables entry-point plugin autoload and explicitly loads declared module
names. Native registration must resolve each declaration to its pinned file.
Project conftest files and standard pytest configuration remain native inputs, with
bytes bound before and after execution. Imported plugin helpers and wider plugin
closures remain unverified. Native collected items and setup/call/teardown events
must reconcile with every selected file. Empty, all-skipped, deselected, omitted,
malformed or interrupted evidence cannot pass. Assertion, import, fixture and
teardown failures retain their native diagnostics.

## Virtualenv and source identity

The optional environment uses its existing `bin/python3`; normal virtualenv
interpreter symlinks are executed only after trust. Planning does not follow or
read an external interpreter target. Native `sys.prefix` must activate the declared
directory. Selected dependencies use canonical distribution names and exact
versions. Metadata must identify one matching distribution beneath
`lib/python3.12/site-packages`.

The bounded distribution profile accepts contained literal RECORD entries with
matching SHA-256/size fields and reconciles their top-level trees. Omitted or
additional files, ambiguous metadata, changed versions, links, parent paths,
unsupported RECORD syntax and changed inputs cannot qualify. Generated `.pyc`
files and `__pycache__` directories are excluded from that source collection.
Actual native pytest imports or mypy dependency paths must come from the declared,
bound virtualenv files. A plugin changing import paths cannot borrow the original
distribution's metadata for a different source. Unrelated environment packages,
interpreter startup customization and complete transitive/publisher/license
closures remain separate obligations.

`-B` prevents bytecode writes but still permits reading existing timestamp caches.
The runner therefore selects a fresh cache prefix inside its owned temporary
directory before importing native tools and project modules. CPython imports and
pytest assertion rewriting use that prefix, preserving existing caches and avoiding
stale code with the same source size/timestamp. Original controls retain an old
cache whose direct native import disagrees with the recorded source, then require
validation to catch the current defect.

Sources, plugins, active configuration, virtualenv configuration, selected package
records and native APIs are checked before project plugin imports and again after
execution. Receipts bind the planned fingerprint, kind, source collection, package
identities, loaded plugins, native module phases and dependency origins. This is
selected input/participation evidence; it does not certify arbitrary plugin
correctness or resist hostile trusted code.

## Bounds and acceptance

A manifest is at most 64 KiB, with at most 256 selected sources, 32 module roots,
16 plugins per runner, 64 selected distributions and 4,096 bound inputs. Each input
is at most 8 MiB and the combined bound input collection is at most 64 MiB.
Distribution metadata is at most 64 KiB, RECORD data at most 1 MiB and directory
walks at most 4,096 entries/32 levels. Unsupported layouts remain visible as
unavailable or incomplete evidence.

The shared runner owns temporary storage and process cancellation. Original native
controls reach waiting pytest/mypy plugin parents and detached workers before
cancellation, timeout and output exhaustion, then require both processes and the
reported owned directory to be removed. Broader hostile behavior, owner loss,
Windows execution and measured resource/release readiness remain separate Gate A
profiles. Summary output omits source paths, commands and native process details;
detailed output can expose them.

CI prepares exact public wheel URLs and SHA-256 values from
`scripts/python-extensions-wheels.json`, without dependency range re-resolution or
source builds. The native controller requires preserved Python callbacks, all
frozen extension categories, compiling guard removals, regressions and a fresh
offline production installation. These synthetic checks invoke no model inference
or field evaluation.
