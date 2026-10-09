# Selected Nuxt assembly contract

`javascript.nuxt-runtime` accepts opt-in `checktrail.nuxt.json` schema version 2.
Version 1 keeps the existing SSR route inventory. Planning checks strict data and
inventoried configuration/consumer entry files without importing project code.
Execution requires operator trust at CLI invocation or MCP startup.

Version 2 declares `assembly`, testing `environment`, `expectedPages`,
`expectedHandlers`, `expectedMiddleware`, `expectedRuntimeConfig`, `consumers`,
`expectedApis`, and controlled `requests` with literal response/event expectations.
The original public contract is in `test/review-nuxt-assembly-fixture.ts`.
Expectations are explicit declarations; native observations informed this synthetic
fixture, so it is development evidence rather than an independent accuracy benchmark.
Configuration is bounded to 64 KiB, consumers to sixteen inventoried TypeScript
files of at most 512 KiB each, selected APIs to 64 and requests to 32.

Bootstrap checks selected package versions and framework source bytes before project
configuration imports. The profile uses Nuxt 4.5.2, Nitro 2.13.4, H3 1.15.11,
Vue 3.5.43, Vue Router 5.3.1, Vite 8.3.0 and engine TypeScript 6.0.3. Missing,
incompatible or changed selected bytes are unavailable. Selected byte pins do not
verify the whole dependency, artifact, publisher or license closure.

Native Nuxt preparation, type generation and production SSR compilation run in a
fresh engine-owned testing directory. Protected testing/build settings are checked
again after native setup, type generation and build. The observer reads the actual
generated Nitro handler and app middleware modules, then compares their descriptors
with actual native handler objects and H3 layers. It includes implicit native
handlers instead of inferring the served table from the project's route files.
Unsupported module shapes, source identities or setup changes remain incomplete.

Actual H3, global and named middleware invocation events retain phase and native
position. App middleware events use native navigation paths and `NAVIGATE`; these
are distinct from HTTP method events. Wrappers preserve arguments, receiver, return
values, names and arity; repeated global callbacks retain their shared identity.
Registration is distinct from invocation. Native router registration changes,
handler/layer replacements, page getter/record drift, static loader changes and
dynamic app middleware remain incomplete. Event observation is bounded to 2048,
with native event/completion references bounded to 128 per request. Inventories
are bounded to 2048 entries and generated modules to 512 KiB.

Controlled in-process native requests require actual H3 participation, body EOF,
and one native completion. Nitro error responses use the actual native error event
because that path can bypass H3's ordinary `afterResponse` hook. A blocked selected
API reports a reached failure with incomplete broader participation. Page coverage
and selected producer/method participation are required before a clean pass.
Responses are bounded to 64 KiB and 64 chunks; no listening server is started.
Trusted setup and handlers retain the process's privileges; this adapter does not
sandbox executed project code.

The type program uses native generated server configuration/declarations and each
explicit consumer. Symbol identity binds `InternalApi` references to the native
interface. Each consumer must reference a selected route/method, and all selected
APIs must participate. Resolved structural types, rather than alias display names,
are compared with the declared canonical JSON shape. The virtual query reserves
`.__checktrail_native_api_query.ts`; an existing file, directory or symlink at that
project path remains incomplete, so the query cannot replace selected source. Native diagnostics report a
separate consumer finding. Shape limits are depth eight, 1024 visited nodes,
64 union/object members and two indexes. Opaque, recursive, tuple, callable and
unsupported types remain incomplete. This does not establish full client/Vue typing.

Private/public values and reserved `app`/`nitro` namespaces carry typed hashes.
SSR's actual serialized `public` and `app` values must agree with the server
boundary. Unknown reserved keys remain incomplete. Hashes and detailed response
projections are not a secrecy guarantee. Ordered `routes`, `middleware` and
`bindings` evidence binds source, producer, versions, collection content/counts,
request identities and participation. Summary output omits detailed inventories
and logs; detailed CLI/MCP output requires operator detail selection.

Exact duplicate compiled server route/method pairs produce findings. Arbitrary
route overlap, cache internals, live serving, authorization correctness, databases,
full artifact/license closure and independent host/model sessions remain unverified.

The required `nuxt-assembly-arm64` CI matrix prepares public locked tools. Its
`acceptance` phase verifies source originals, legacy route cases, supplemental
adversarial cases and the same originals against an offline production installation.
Three `guards-*` phases partition all compiling guard controls by manifest position;
the controller checks that the partitions are disjoint and cover the complete
manifest. All four jobs must pass. Running
`node scripts/verify-nuxt-assembly-container.mjs` without a phase still verifies the
complete combined profile locally. Stage timings are written to stderr. The full
native suite uses a bounded ten-minute file budget because its timeout covers all
callbacks in a file, including repeated native builds. The acceptance
container has read-only source/root, no network, two CPUs, 2 GiB memory, 256 PIDs
and 1 GiB temporary storage. Temporary storage permits executable native compiler
bindings copied into fresh fixture projects. Its process isolation does not prove
host/model session isolation. Use the shared foreground task runner on this machine.
Gate A remains open until all selected profiles, freezes and final matrix pass.
