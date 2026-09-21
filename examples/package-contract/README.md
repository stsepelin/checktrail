# Built package and consumer contract

This synthetic example validates the artifact a consumer actually installs. The
producer compiles TypeScript into JavaScript and declarations; its package allowlist
contains only `dist` and npm's required metadata. The consumer imports the public
package name in both TypeScript and a native Node test.

From a prepared Checktrail development checkout:

```sh
npm run build
node --test dist/test/package-contract.test.js
```

The test copies these files to a temporary workspace, invokes the already installed
TypeScript compiler, packs the producer with npm scripts disabled, installs that
tarball offline into the consumer, and runs the shared validation engine. No package
is published, no dependency is fetched and the example source is not modified.
The consumer manifest acquires its local tarball dependency during this preparation.
The validation engine itself does not build, pack or install projects automatically.

The cases establish distinct evidence:

- Numeric declarations and numeric runtime payloads pass both checks.
- A producer changing its public quantity to a string fails both checks.
- Declarations still promising a number with JavaScript returning a string pass
  type checking but fail the consumer's exact serialized-payload assertion.
- Rebuilding and installing the repaired producer restores both passes.

The test also derives a declared workspace dependency edge from the prepared
consumer manifest and checks `architecture.json`. A synthetic reverse edge violates
the layer rule and creates a cycle. This graph describes the two package manifests,
not all source imports or transitive external dependencies. Its producer fingerprint
hashes the packed tarball, and its consumer fingerprint comes from the validation
inventory; neither is a complete hermetic dependency/environment identity.
