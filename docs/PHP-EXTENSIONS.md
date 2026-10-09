# Declared PHP extension and proxy evidence

Select `php.extensions` with an explicit `checktrail.php.json` to verify the
selected native PHP extension environment and initialized Laravel model/proxy
behavior. `php.phpstan` and `php.php-cs-fixer` remain separate checks: select them
for native analysis and dry-run formatting. Their existing file scopes remain
visible. Reflection/accessor evidence does not establish whole-file type coverage.

The declaration contains `schemaVersion: 1`, `nativeExtensions`, `classes` and
`models`. `nativeExtensions` must enumerate the complete selected extension list in
canonical order. Each class declares its exact PHP `class`, contained relative
`path`, SHA-256 `sha256` and `generated` flag. At least one generated proxy is
required. Models select `class`, `expectedClass`, the complete `defaults` projection
and nonempty `probes`. Each probe declares `attribute`, raw input `attributes` and
typed `expected` output. Use `schemas/php-config.schema.json` and the original
public fixture in `test/php-extensions-fixture.ts` as the concrete declaration
reference; compute hashes from actual class files.

Planning reads declarations, source and Composer metadata without running PHP,
Composer autoloading, bootstrap files, model constructors or getters. It creates
no dependencies, proxies or services. Execution requires operator trust through
the shared library/CLI/MCP engine. MCP arguments cannot grant execution trust or
detailed disclosure. Trusted native tools and project code execute without a
security sandbox.

## Selected native scope

The measured extension profile uses Linux ARM64 PHP 8.5.6 and Laravel 13.32.0,
with PHPStan 2.2.14, Larastan 3.12.3 and PHP-CS-Fixer 3.95.27. Exact selected
interpreter, mapped extension-directory artifacts and native API bytes are bound
in `src/php-extension-pins.ts`. Built-in extensions are carried by the measured
interpreter binary. Native extension names, versions and declared dependency edges
must agree with the selected runtime before project autoloading and after probes.
Other native versions/layouts remain unavailable. System shared libraries, complete
Composer/transitive dependencies, publisher authentication and license closure are
separate obligations; this profile does not certify those closures.

Composer versions come from one exact matching package entry. Prefix/suffix
neighbors and duplicate package identities cannot supply its version. Metadata
identification imports no project code. The native runner independently checks
selected package versions and API bytes before bootstrapping.

CLI OPcache, preloading, prepend/append files and dynamic extension loading are
disabled for this runner. Laravel's testing environment and all five framework
cache destinations use the owned command directory. The runner initializes the
native console and HTTP kernels without dispatching a request, schedule, event or
database query of its own. Project initialization and getters remain trusted code
and may perform their own work.

## Reflection, defaults and witnesses

Class reflection must resolve every declared name to its exact bound file and
hash. Every declared model/proxy must participate in a resolved model ancestry.
Class ancestry and selected getter reflection retain their actual source origins.
The initialized container resolution is compared with `expectedClass`; selected
native Laravel model APIs are byte-bound, while declared project implementations
remain source-bound. Opaque or unselected ancestors and accessor origins cannot
qualify.

Defaults include table/connection, key name/type/incrementing, timestamps,
pagination, eager-load/eager-count declarations, casts, raw default attributes,
appends, fillable and guarded fields. Getter probes run on clones with explicitly
supplied raw attributes and capture the actual native getter type/value and
reflection origin. Repeated probes for one accessor are supported when their
complete declarations differ. Original controls hold the first input constant
and vary the second, catching a getter that drops the second value.

Values use `{ "type": "string", "value": "example" }` or the corresponding
`null`, `bool`, `int`, `float` or `array` tag. Integers must fit the exact JSON
integer range. Arrays retain ordered typed keys and recursively typed values:

```json
{
  "type": "array",
  "value": [
    {
      "key": { "type": "string", "value": "n" },
      "value": { "type": "int", "value": 1 }
    }
  ]
}
```

This keeps an integer distinct from a float even when JSON represents both with
the same numeric value. Native defaults and probes must reconcile completely;
empty, missing, duplicated, malformed, opaque, interrupted or stale evidence
cannot pass. Source diagnostics from analysis/formatting remain separate from
initialization and evidence errors.

These getters are evaluated on explicitly initialized models, not query-hydrated
collections. The recorded eager-load declarations do not prove relation loading,
query count or activation of a scale-dependent lazy-loading guard. The separate
Laravel assembly profile retains its two-row hydration/request controls.

## Source boundaries and acceptance

Contained generated files can live outside the normal project inventory, such as
an excluded `.checktrail` directory. Their exact bytes are still captured by this
extension manifest. Inputs are checked before and after native execution: a getter
that changes an excluded proxy cannot pass despite successful return values and
an unchanged ordinary inventory fingerprint. Other checks do not inherit this
extra source scope automatically.

The declaration data is bounded to 32 KiB/depth 16 and a fixed item budget. Each
bound file is at most 8 MiB, the input collection at most 256 files/64 MiB and the
command manifest at most 128 KiB. Selectors and paths must be unique, contained
and canonical. Accessor arrays have bounded depth, item and encoded-byte sizes;
unsupported values remain incomplete evidence. Native output and execution use
the shared runner's limits and cancellation.

Original lifecycle cases reach a waiting bootstrap parent and detached PHP worker
before cancellation, timeout and output exhaustion, then require both processes
and the reported owned directory to be removed. Hostile trusted code, owner loss,
Windows transport and resource/release readiness remain separate Gate A profiles.

The native controller preserves existing PHP tool callbacks, requires all frozen
extension categories, compiling JavaScript/PHP guard removals, regression cases
and a fresh offline production installation. CI uses the existing exact Composer
lockfiles with plugins and lifecycle scripts disabled. Synthetic acceptance
invokes no model inference or field review, and Gate A remains open until the
remaining profiles and final runtime matrix are accepted.
