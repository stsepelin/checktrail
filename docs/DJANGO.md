# Django URL inventory profile

Select `python.django-routes` and provide project-local
`repo-verifier.django.json`:

```json
{
  "schemaVersion": 1,
  "settings": "settings",
  "assembly": "catalog-api",
  "environment": "isolated-test"
}
```

The verified runtime is Django 6.1.1 on Python 3.12.13 in an isolated Linux
container. Other Django versions are unavailable until verified. Settings must
resolve to one inventoried local Python module or package. Planning does not
import settings, URLconfs or applications. Unselected framework profiles are not
loaded by other Python checks.

Trusted execution fixes `DJANGO_SETTINGS_MODULE` to the selected module, invokes
`django.setup()`, then recursively enumerates the actual root URL resolver. This
includes registrations made by application `ready()` hooks and nested included
URLconfs. No HTTP server, request, migration or package installation is started
by the adapter. Application setup can access services or files with the process
user's privileges; the declared environment label is not a sandbox. Supply isolated
settings and prepare any required services separately.

The supported profile handles native `URLPattern` and `URLResolver` with
`RoutePattern` and `RegexPattern`, plus Django's built-in integer, string, UUID,
slug and path converters. Custom route classes/converters, translated route
objects and locale-prefix patterns are incomplete evidence. Unsupported callable
identities, non-JSON default arguments, setup/resolver errors and empty URL tables
also cannot pass. Traversal is limited to depth 32 and 20,000 visited nodes, within
the shared execution time/output limits.

Each detailed check result includes a `runtime` route inventory compatible with
the runtime comparison tool. Entries retain ordered native pattern chains,
pattern class, regex text, regex flags and endpoint matching mode. The last field
matters because Django can use full matching or searching for identical regex
text. Namespace order, route name, handler identity and a hash of inherited/default
arguments are also captured. Defaults are hashed rather than emitted directly;
this is not a guarantee of secrecy for low-entropy values.

Exact duplicate pattern chains fail. Prefix/suffix names are compared exactly.
Equivalent URL matchers expressed through different nesting or regex syntax are
not normalized, and arbitrary pattern overlap is not analyzed. Request methods,
authorization, middleware effects, callback behavior and per-request URLconf
overrides are outside this projection. Regex matching is not executed against
sample request paths by this check.

The capture records native visited/unsupported counts, and the parser verifies
collection accounting, profile/source identity and canonical pattern signatures.
Known duplicates fail even if a different node is unsupported; incomplete
collection metadata remains available. Summary reports omit runtime entries and
application logs. The shared engine verifies source and policy after execution.
Check scope names the settings entry file, not every imported source file.

Native regression fixtures cover nested URLconfs, namespace capture, duplicated
resolver branches, fixed counterparts, regex endpoint-mode near misses, setup-time
registrations, empty tables, custom converters/routes and resolver failures. Tests
also verify non-executing planning, protected settings environment, malformed
evidence and skipped unused framework profiles. Reproduce prepared Linux tests
with `node scripts/verify-framework-container.mjs`; preparation dependencies are
pinned in `scripts/framework-tools.requirements.txt`. Hosted CI remains unexecuted.

References: [Django URL dispatcher](https://docs.djangoproject.com/en/6.0/topics/http/urls/),
[Django setup and settings](https://docs.djangoproject.com/en/4.2/topics/settings/).
Collector behavior is verified against installed Django 6.1.1 source and fixtures;
these references describe the underlying public concepts.
