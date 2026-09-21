# Captured producer/consumer contracts

Contract validation checks actual JSON samples against a consumer's schema using
Ajv 8.20.0 and ajv-formats 3.0.1. It does not infer general schema compatibility or
run a service. Each contract names both sides, their recorded source fingerprints,
the consumer schema and named captured samples. The artifact format is versioned
by `contract-bundle.schema.json`.

```sh
checktrail check-contracts --root /path/to/project --input contract.json
```

The library exports async `validateContracts(bundle, {timeoutMs?, signal?})`.
MCP `contract_validation` accepts a local relative `input` and optional `timeoutMs`.
No project execution permission is needed to read and validate artifacts. MCP
allows one contract worker at a time, remains responsive to other tools, and
supports cancellation and connection/signal shutdown. Root, output mode and
execution permission remain operator settings.

The supported schema dialect is JSON Schema 2020-12. A root `type` is required;
empty or catch-all schemas cannot establish a meaningful contract here. Strict
schema/type/required checking and format assertions are enabled. Unknown keywords,
unknown formats and unsupported dialects are incomplete evidence. Local references
within the document are supported; external references, asynchronous schemas and
`$data` and OpenAPI-only `nullable`/`discriminator` extensions are rejected. Literal `$ref` names inside `const` or `enum`
values are data. No schema loader or network fetch is configured.

Validation does not coerce types, insert defaults or remove fields. For example,
`"2"` fails an integer requirement instead of being changed to `2`. Required fields,
numeric limits, extra properties, formats and nested array elements are checked
according to the schema. A valid payload says nothing about unexpressed business
rules. Missing samples and incomplete captures cannot pass.

Each contract is passed, failed or incomplete. Known payload failures take
precedence over other contracts' incompleteness; all counts remain visible.
`passed + failed + unverified = contracts`, and `accepted + rejected = samples`
for evaluated samples. Detailed results include contract/sample names and schema
keyword/instance/schema paths, without echoing payload values. Summaries omit those
identifiers. Exit codes are 0 passed, 1 failed, and 2 incomplete or malformed input.

Schema compilation and matching run in a worker with a default 10-second budget
(CLI default 30 seconds), configurable up to 30 seconds, a 64 MiB old-generation
heap limit, a 16 MiB young-generation limit and a 4 MiB stack limit. Timeout,
cancellation or worker failure returns incomplete evidence. Worker limits are not
a sandbox or a promise about total process memory. Inputs are limited to 8 MiB,
depth 32, 100,000 JSON values, 100 contracts and 1,000 samples per contract. Duplicate
contract IDs, duplicate sample names, missing payloads and non-JSON values are
rejected. The worker never loads producer or consumer application code.

Results carry `imported-contract-samples` provenance. A capture timestamp and source
fingerprints are declared evidence, not proof of origin, freshness, transport,
authorization, or complete behavior coverage. Use native isolated integration
tests to capture the producer output and consumer schema when those claims matter.

The synthetic `examples/contracts/` pair can be exercised from this checkout:

```sh
node examples/contracts/capture.mjs > .checktrail/contracts.json
node dist/src/cli.js check-contracts --root . --input .checktrail/contracts.json
node examples/contracts/capture.mjs --broken > .checktrail/contracts.json
node dist/src/cli.js check-contracts --root . --input .checktrail/contracts.json
```

Create `.checktrail/` first if it does not exist. The first capture serializes
numeric quantities; the second simulates a legacy string quantity and fails the
consumer schema. This example fingerprints its producer module and consumer schema
only. Tests cover native producer serialization, valid/invalid boundary payloads,
non-mutating validation, local references, formats, unsupported definitions, input
limits, pathological regex deadlines, cancellation and CLI/MCP privacy.

References: [JSON Schema 2020-12](https://json-schema.org/draft/2020-12),
[Ajv strict mode](https://ajv.js.org/strict-mode),
[Ajv validation options](https://ajv.js.org/options).
