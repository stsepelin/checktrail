import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { compareRuntimeInventories } from "../src/runtime-inventory.js";
import { projectReport } from "../src/output.js";
import { fixture } from "./helpers.js";
const available =
  spawnSync(
    "python3",
    [
      "-c",
      "from importlib.metadata import version; assert version('Django') == '6.1.1'",
    ],
    { timeout: 10_000 },
  ).status === 0;
const profile = JSON.stringify({
  schemaVersion: 1,
  settings: "settings",
  assembly: "synthetic-django",
  environment: "isolated-test",
});
const policy = JSON.stringify({
  schemaVersion: 1,
  projects: [{ path: ".", checks: ["python.django-routes"] }],
});
const settings =
  "SECRET_KEY = 'synthetic-fixture-only'\nROOT_URLCONF = 'urls'\nINSTALLED_APPS = []\nUSE_I18N = False\n";
const urls = `from django.urls import path, include, re_path
from django.http import HttpResponse
def view(request, **kwargs): return HttpResponse('synthetic')
urlpatterns = [
    path('api/', include(([path('items/', view, name='items'), path('items-extra/', view, name='items-extra')], 'catalog'), namespace='catalog')),
    re_path(r'^numeric/(?P<item_id>[0-9]+)/$', view, name='numeric'),
]
`;
async function replace(file: string, text: string) {
  await writeFile(file + ".replacement", text, { flush: true });
  await rename(file + ".replacement", file);
}
const files = () => ({
  "pyproject.toml": "",
  "repo-verifier.json": policy,
  "repo-verifier.django.json": profile,
  "settings.py": settings,
  "urls.py": urls,
});

test("Django planning validates a local settings module without executing setup and protects the settings environment", async (t) => {
  const root = await fixture(t, {
    ...files(),
    "settings.py":
      "from pathlib import Path\nPath('imported').write_text('ran')\n",
  });
  assert.deepEqual((await createPlan(root)).plan.checks[0]!.scope, [
    "settings.py",
  ]);
  await assert.rejects(access(path.join(root, "imported")));
  await assert.rejects(validate(root, { trusted: false }), /operator trust/);
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: ".",
          checks: ["python.django-routes"],
          environment: ["DJANGO_SETTINGS_MODULE"],
        },
      ],
    }),
  );
  await assert.rejects(
    createPlan(root, { environment: { DJANGO_SETTINGS_MODULE: "other" } }),
    /protected adapter/,
  );
  await writeFile(path.join(root, "repo-verifier.json"), policy);
  for (const value of ["../outside", "settings;execute()", "settings.app()"]) {
    await writeFile(
      path.join(root, "repo-verifier.django.json"),
      JSON.stringify({ ...JSON.parse(profile), settings: value }),
    );
    await assert.rejects(createPlan(root));
  }
  await writeFile(
    path.join(root, "repo-verifier.django.json"),
    JSON.stringify({ ...JSON.parse(profile), settings: "missing" }),
  );
  assert.match(
    (await createPlan(root)).plan.checks[0]!.unavailableReason!,
    /local Python/,
  );
  await writeFile(path.join(root, "repo-verifier.django.json"), "invalid JSON");
  await writeFile(
    path.join(root, "repo-verifier.fastapi.json"),
    "invalid JSON",
  );
  await writeFile(
    path.join(root, "repo-verifier.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["python.pytest"] }],
    }),
  );
  assert.equal((await createPlan(root)).plan.checks[0]!.id, "python.pytest");
});

test(
  "native Django captures nested URL resolvers and exact duplicate pattern chains while preserving namespaces and matching mode",
  { skip: available ? false : "Pinned Django unavailable", timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, files());
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, "passed", JSON.stringify(report.checks));
    const runtime = report.checks[0]!.runtime!;
    assert.equal(runtime.collections[0]!.entries.length, 3);
    assert.deepEqual(
      runtime.collections[0]!.entries[0]!.attributes.namespaces,
      ["catalog"],
    );
    assert.ok(
      !JSON.stringify(projectReport(report, false)).includes("catalog"),
    );
    await replace(
      path.join(root, "urls.py"),
      urls + "urlpatterns.append(urlpatterns[0])\n",
    );
    const broken = await validate(root, { trusted: true });
    assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
    assert.equal(
      compareRuntimeInventories(runtime, broken.checks[0]!.runtime).counts
        .added,
      2,
    );
    await replace(path.join(root, "urls.py"), urls);
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await replace(
      path.join(root, "urls.py"),
      urls +
        "from django.urls.resolvers import RegexPattern, URLPattern\nurlpatterns += [URLPattern(RegexPattern('search/$', is_endpoint=True), view), URLPattern(RegexPattern('search/$', is_endpoint=False), view)]\n",
    );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
  },
);

test(
  "native Django captures setup-time URL wiring and keeps empty, custom or failing assembly incomplete",
  { skip: available ? false : "Pinned Django unavailable", timeout: 90_000 },
  async (t) => {
    const root = await fixture(t, {
      ...files(),
      "settings.py": settings.replace(
        "INSTALLED_APPS = []",
        "INSTALLED_APPS = ['wiring.WiringConfig']",
      ),
      "wiring.py":
        "from django.apps import AppConfig\nclass WiringConfig(AppConfig):\n    name = 'wiring'\n    def ready(self):\n        import urls\n        urls.urlpatterns.append(urls.urlpatterns[0])\n",
    });
    assert.equal((await validate(root, { trusted: true })).outcome, "failed");
    await replace(path.join(root, "settings.py"), settings);
    for (const source of [
      "urlpatterns = []\n",
      urls +
        "from django.urls.resolvers import URLPattern, RoutePattern\nclass CustomPattern(URLPattern): pass\nurlpatterns.append(CustomPattern(RoutePattern('custom/'), view))\n",
      urls +
        "from django.urls import register_converter\nclass CustomConverter:\n    regex = '[a-z]+'\n    def to_python(self, value): return value\n    def to_url(self, value): return value\nregister_converter(CustomConverter, 'custom')\nurlpatterns.append(path('<custom:value>/', view))\n",
      "raise RuntimeError('synthetic resolver failure')\n",
    ]) {
      await replace(path.join(root, "urls.py"), source);
      const result = await validate(root, { trusted: true });
      assert.equal(result.outcome, "incomplete", JSON.stringify(result.checks));
    }
  },
);
