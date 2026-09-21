---
name: checktrail-review
description: Review a code change using Checktrail evidence and targeted review guidance. Use when assessing correctness, test adequacy, affected consumers, or gaps that a passing validation report cannot establish.
license: MIT
metadata:
  author: stsepelin
  version: "1"
  checktrail-version: "0.1.0-alpha.1"
---

# Review with Checktrail evidence

Requires Checktrail 0.1.0-alpha.1 through MCP or CLI for evidence retrieval; repository read access for source review.

Establish the requested diff/base and inspect the current files, relevant project
instructions and declarations. Confirm that any Checktrail report applies to the
intended repository and source. Reading a retained report does not refresh it.
Report unavailable evidence instead of treating missing validation as a pass.

## Retrieve relevant guidance

Use MCP `review_guidance` with `{}` for questions selected from the planned checks.
Add a supported `topics` array only when relevant: `test-lifecycle`,
`analysis-scope`, `package-consumers`, `python-imports`, `framework-assembly`, or
`execution-depth`. For example:

```json
{ "topics": ["framework-assembly", "execution-depth"] }
```

CLI equivalent for the configured root:

```sh
npx --yes --ignore-scripts @stsepelin/checktrail@0.1.0-alpha.1 guidance --root /absolute/project --topic framework-assembly
```

Guidance is advisory retrieval, not source analysis. Its `automatedCoverage: false`
must not become a passed check or a finding. An empty selection says nothing about
whether the change needs review. Use the installed version's commands and schemas;
do not guess unsupported checks from language names.

## Follow evidence into behavior

Apply the questions relevant to the changed behavior:

- Reconcile what the check selected with the changed files and affected consumers.
  Read ignores, defaults and inherited settings before claiming coverage is absent.
- For a runtime guard, find the condition that activates it and whether the fixture
  meets that condition. Exercise meaningful boundary cases when authorized; one
  passing example does not prove a batch, retry or pagination boundary.
- For extracted or moved logic, trace preserved behavior as well as new behavior.
  Identify the test that would fail if that behavior disappeared. Use a bounded,
  authorized reproduction or mutation when needed rather than assuming coverage.
- For registration or lifecycle changes, compare the assembled routes, listeners,
  middleware or bindings where capture is available. Distinguish measured assembly
  from an inferred inventory based only on source declarations.
- For authorization, allowlists and fallback decisions, trace reachable callers
  and normalized inputs. Check valid near misses and identifier boundaries. A test
  asserting a privileged outcome does not by itself make that outcome correct.
- Check assertions, cleanup and test doubles against actual application behavior.
  A fake that implements behavior the real component lacks can conceal a defect.

Keep synthetic examples generic. Do not copy another repository's source, paths,
incident narratives or reports into public fixtures. Use the languages and native
tools actually present; unavailable framework capture stays an explicit limitation.

## Deliver actionable findings

For each finding, cite the current definition or call site, its triggering input,
the resulting behavior, and supporting evidence. Distinguish a regression from a
pre-existing issue, and check that a suggested fix has the required inputs in scope.
If intent is unresolved, state the inconsistency instead of prescribing a guess.

Separate executed validation, source-review conclusions and unreviewed scope.
Neither guidance retrieval nor a green suite proves complete review quality.
Do not weaken tests or baselines just to match a broken behavior.

`review_context` can expose selected source and requires separate operator
disclosure settings. Ordinary review does not require exporting it. If the user
requests that workflow, use the installed schema and
[review exchange contract](https://github.com/stsepelin/checktrail/blob/main/docs/REVIEW-EXCHANGE.md);
receipt freshness and matching quotations do not establish finding correctness.
