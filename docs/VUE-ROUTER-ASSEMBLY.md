# Vue Router navigation assembly

The opt-in `schemaVersion: 2` configuration for `javascript.vue-router` extends
[the resolution profile](VUE-ROUTER.md). It constructs a native memory router,
observes global hook registration before importing the selected trusted startup,
awaits that startup, then navigates the declared paths in order. The first
navigation must succeed; the collector awaits native `isReady()` before retaining
its result. Final route attributes, active global hooks and navigation results
must equal the operator's declared contracts. Every native route must also
participate in the existing resolution probes, and every active observed hook
must have been reached. Empty or incomplete evidence cannot pass.

This is a selected testing assembly. Reuse application registration code. It
establishes behavior for declared paths and projected attributes; it does not
establish production assembly equivalence or general authorization correctness.

## Configuration and projections

Retain every version 1 configuration field and add:

- `expectedRecords`: the complete ordered route attribute array, including
  path/name, alias path/name, named view keys, canonical JSON metadata and static
  redirect data, per-record guard names, child count, and global strict/sensitive
  settings. Native alias records and default children have separate entries.
- `expectedHooks`: the ordered active registrations, each with a `phase` of
  `beforeEach`, `beforeResolve` or `afterEach`, and its registration function
  `name`. Duplicate registrations remain separate entries.
- `navigation`: ordered native navigation expectations. Each contains `path`,
  final `fullPath`, complete ordered `matched` path/name identities, canonical JSON
  `meta`, ordered global `hooks` events, and `failure`. Each event includes
  `phase`, `name`, `to` and `from`; failure is `null` or native type `4`, `8` or `16`.

Expected metadata is a canonical JSON string, with object keys sorted. For
example, navigation to a child can inherit both parent and child metadata. A
redirect's final path can differ from its requested path. Duplicate navigation
can return failure `16` and invoke after hooks without invoking before hooks;
the contract must describe the native behavior. Resolution probes remain
separate: `resolve()` itself neither follows redirects nor runs navigation guards.

The generated [configuration schema](../schemas/vue-router-config.schema.json)
describes both versions. Version 1 retains its existing result shape and native
resolution behavior. Framework fixture dependencies remain separately locked and
are not Checktrail production dependencies.

## Hook behavior and limits

The observer preserves native callback identity, arity, name, `this`, arguments
and return values. Three-argument before hooks retain native `next` behavior;
shorter and async before hooks retain the native Promise path. Registering the
same function twice uses the same native wrapper. The native remover removes the
first matching registration, including on repeated remover calls; the observer
tracks that behavior rather than assigning removal to the returned handle's
registration. The active registration identities and native route identities
must remain stable during controlled navigation, including replacement by a hook
with the same displayed name.

Native methods and the current-route reference are captured before trusted
startup, so replacing public method properties cannot substitute fabricated
navigation or resolution. Replacing the registration observers is unsupported.
Native after hooks do not await returned Promises. Promise-like, proxy, computed
or otherwise unresolved after-hook returns therefore fail capture; inert data
with a non-callable `then` property remains supported. Return-property getters
are not evaluated to make that classification.

There are at most 256 hook registrations over the whole startup, including
removed registrations, and 2,048 observed events per startup or controlled
navigation phase. The next registration/event is rejected before invoking its
callback. Configurations retain the shared 64 KiB encoded limit and at most 64
navigation steps, 256 active expected hooks, 2,048 expected route records and 32
matched records per step. Metadata retains the existing bounded finite JSON
projection. Shared time/output limits and process-tree cleanup apply to trusted
framework startup and navigation.

Component rendering, browser behavior, component guard inventories, closure
values and function bodies are outside the projection. Native navigation can
execute route/component guards or async loaders; their effect is observed only
for these paths. Dynamic redirect functions and unsupported route metadata make
route capture incomplete. Unawaited project work outside observed hooks is not
proven complete by a successful selected navigation.

## Trust, identity and acceptance

Discovery and planning read configuration without importing project/framework
code. Execution still requires operator trust, and an MCP argument cannot grant
it. Summary CLI/MCP output omits route paths, metadata and hook details; operator
startup must enable detailed output to disclose them.

Version 2 requires Vue Router 5.3.1 and Vue 3.5.43 and checks the five selected Node
router bundles against pinned byte counts and SHA-256 before importing the
framework or project startup. This selected bundle identity is not a complete
Vue/dependency, publisher, archive or license closure. Those obligations remain
open separately.

Original synthetic acceptance covers misordered guards that actually redirect
a protected catalog navigation, the repair, nested/default/alias/redirect records,
named views, metadata, native readiness, duplicate callbacks/removers, async and
`next` near misses, prerequisites, stale/empty receipts, CLI/MCP privacy and
operator trust, and reached native-hook cancellation/time/output exhaustion with
owned descendant cleanup. Fresh offline production installation runs the same
nine required callbacks. Supplemental field, budget, runtime-byte, facade and
registration-identity assertions defend adjacent cases. Compiling mutations keep
the original assertion bytes unchanged and restore the implementation afterward.

No model inference or real-project field evaluation is invoked by these checks.
Gate A remains open for the remaining profiles, freezes and final acceptance.
