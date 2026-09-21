# Choose and understand setup coverage

A repository can contain a runnable library, a documentation project and CI
workflows. Each can need different tools. `init` proposes checks; `doctor` reports
static setup gaps; only a trusted `run` produces validation evidence.

Use the [installation guide](INSTALLATION.md) and inspect before writing:

```sh
checktrail init --root "$PWD"
checktrail plan --root "$PWD" --detailed
checktrail doctor --root "$PWD" --detailed
```

A `needs-selection` or `attention-required` result exits `2`. Read its JSON before
choosing checks. These inspection commands do not run project scripts or install
dependencies. Detailed output includes paths and may include absolute diagnostic paths.

## A library with documentation and workflows

Consider this original, generic repository:

```text
package.json                    scripts.test is "node --test"
sum.test.js                     one passing Node test
.github/workflows/verify.yml    a GitHub Actions workflow
docs/requirements.txt           documentation dependencies
docs/conf.py                    documentation configuration, no tests
```

Discovery identifies JavaScript and infrastructure at `.`, and Python at `docs`.
The directory name does not prove that it is documentation, nor that it can be
ignored: the operator knows its purpose. Checktrail does not infer a documentation
build command from a Python manifest.

`init` returns `needs-selection` for the Python project and writes nothing, even
though the Node test command is recognized. Supplying a check for `.` does not
select it for nested projects. For example, this explicit preview covers all three
discovered ecosystems:

```sh
checktrail init --root "$PWD" \
  --check '.#javascript.node-test' \
  --check '.#infrastructure.actionlint' \
  --check 'docs#python.unittest'
```

It produces a policy preview, but the choice of `unittest` is not evidence of tests
in `docs`. If that policy is created with `--write`, `doctor --detailed` reports
`unavailable-check` for `python.unittest`: no candidate test files were discovered.
Choosing a runner merely to resolve setup selection does not validate documentation.
Use a separately supported check or the project's own documentation build; keep
that work outside Checktrail's coverage claim when no applicable adapter exists.

## Prepare workflow validation separately

`infrastructure.actionlint` is static workflow analysis. It does not execute CI
jobs or validate their shell bodies. It needs both the prepared native executable
and `checktrail.actionlint.json` beside the workflow repository root:

```json
{
  "schemaVersion": 1,
  "runnerLabels": [],
  "variables": []
}
```

The empty arrays declare no extra runner labels or configuration variables. Review
actual workflow requirements before adopting those values. See [ACTIONLINT.md](ACTIONLINT.md)
for the supported tool version, configuration, dependency checks and limitations.
Without this configuration, diagnosis reports `unavailable-check`; without an
executable on the effective PATH it also reports `missing-executable`. Prepare the
tool explicitly, then repeat diagnosis. A successful Node test cannot supply this
workflow evidence.

## Interpret an intentionally narrowed policy

After reviewing the desired scope, an operator may explicitly maintain a
language-only policy. For the example above, it is:

```json
{
  "schemaVersion": 1,
  "projects": [{ "path": ".", "checks": ["javascript.node-test"] }]
}
```

Edit an existing policy deliberately; `init --write` preserves it and cannot
replace it or narrow its checks through `--check` arguments. Do not discard
existing overlays, packs, environment requirements or workspace dependencies.

With the language-only policy, the commands have different meanings:

| Command                                                   | Result for this example                                                                             | Coverage                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `checktrail doctor --root "$PWD" --detailed`              | `attention-required`, exit `2`; `unselected-project` for infrastructure at `.` and Python at `docs` | Workflow and documentation-project checks are omitted. |
| `checktrail run --root "$PWD" --trust-project --detailed` | `passed`, exit `0`, if the Node test passes                                                         | The selected Node test only.                           |

These results are consistent: validation passed its selected check while diagnosis
reported broader discovered scope left unselected. `doctor` does not assess every
possible check within a selected ecosystem either; selecting Node tests does not
claim linting, typing, browser behavior or documentation coverage.

Keep omitted work visible in your review and CI requirements. The
[public adoption report](PUBLIC-ADOPTION.md) records these distinctions on pinned
public projects; its historical results are not a claim about your repository.
