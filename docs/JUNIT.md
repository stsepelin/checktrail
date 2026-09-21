# JUnit report import

Import an existing report through the public `importJUnit(xml)` library function
or the CLI:

```sh
node dist/src/cli.js import-junit --root /path/to/project --input results.xml
```

The result is versioned JSON with `provenance: "imported-report"`. Its outcome
describes the supplied report, not the current repository. Importing cannot
establish source identity, execution time, freshness, scope coverage or whether
the producer ran at all. Imported evidence does not change a validation result.
Default CLI output omits case names and file paths; `--detailed` includes them.
The input path must be relative and remain within the configured root.

The supported XML shape is `testsuite` or nested `testsuites`/`testsuite` elements
with concrete `testcase` entries. Suite test counts are required and aggregate
failure/error/skip counters are reconciled when present. Counts are derived from
leaf cases without double-counting parent suites. Duplicate case identities,
conflicting states, unknown result elements, malformed XML, empty/all-skipped
reports and inconsistent counters cannot pass. Failure/error entries fail.

DOCTYPE/entity declarations are rejected. No external entities or resources are
loaded. Input is limited to 8 MiB, nesting to 32 suites and cases to 100,000.
Built-in XML escapes are decoded. Unrecognized dialects such as custom flaky-test
elements remain incomplete until independently supported and tested.

The [PHPUnit adapter](PHPUNIT.md) uses the same parser with additional requirements:
the report must come from the bounded live process, account for every planned
file and contain positive native assertion evidence.
