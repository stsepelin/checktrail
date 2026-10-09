import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validate, createPlan } from "../src/engine.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-django-assembly-fixture.js";
const skip = available
  ? false
  : "Selected native Django assembly runtime unavailable";
test(
  "assembly-django native defaults guard acceptance",
  { skip },
  async (t) => {
    for (const program of [
      {
        ...source,
        "settings.py":
          source["settings.py"]! +
          "\nDEFAULT_AUTO_FIELD='django.db.models.AutoField'\n",
      },
      {
        ...source,
        "urls.py": source["urls.py"]!.replace(
          "{'mode':'leaf'}",
          "{'mode':'different'}",
        ),
      },
      {
        ...source,
        "urls.py": source["urls.py"]!.replace(
          "namespace='mobile'",
          "namespace='other'",
        ),
      },
    ])
      assert.equal((await run(t, program)).outcome, "failed");
    const next = structuredClone(profile);
    next.expectedMiddleware.reverse();
    assert.equal((await run(t, source, next)).outcome, "failed");
    const signal = structuredClone(profile);
    signal.expectedSignals = [];
    assert.equal((await run(t, source, signal)).outcome, "failed");
  },
);
test("assembly-django UID semantics guard acceptance", { skip }, async (t) => {
  const ignored = {
    ...source,
    "extras/apps.py":
      source["extras/apps.py"]! +
      "\n        def unwanted(sender,**kwargs):raise RuntimeError('Ignored UID callback ran')\n        changed.connect(unwanted,weak=True,dispatch_uid='catalog.notice')\n",
  };
  assert.equal((await run(t, ignored)).outcome, "passed");
  const duplicate = {
    ...source,
    "views.py": source["views.py"]!.replace(
      "    before=len(notifications)",
      "    from project_signals import notice\n    changed.connect(notice,weak=True,dispatch_uid='catalog.notice')\n    assert changed.disconnect(dispatch_uid='missing') is False\n    before=len(notifications)",
    ),
  };
  assert.equal((await run(t, duplicate)).outcome, "passed");
  const zero = {
    ...source,
    "catalog/apps.py": source["catalog/apps.py"]!.replace(
      "dispatch_uid='catalog.notice'",
      "dispatch_uid=0",
    ),
    "extras/apps.py": source["extras/apps.py"]!.replace(
      "dispatch_uid='catalog.notice'",
      "dispatch_uid=False",
    ),
  };
  const next = structuredClone(profile);
  next.expectedSignals[0]!.dispatchUid = null;
  assert.equal((await run(t, zero, next)).outcome, "passed");
});
test(
  "assembly-django weak bound receiver guard acceptance",
  { skip },
  async (t) => {
    const program = {
      ...source,
      "project_signals.py":
        source["project_signals.py"]! +
        "\nclass Listener:\n    def callback(self,sender,**kwargs):notifications.append(kwargs['row'])\nlistener=Listener()\nchanged.connect(listener.callback)\nimport gc\ndef ephemeral():\n    gone=Listener()\n    changed.connect(gone.callback)\nephemeral()\ngc.collect()\n",
    };
    const next = structuredClone(profile);
    next.expectedSignals.unshift({
      ...next.expectedSignals[0]!,
      receiver: "project_signals.Listener.callback",
      dispatchUid: null,
      weak: true,
    });
    next.expectedSignals[1]!.position = 1;
    for (const r of next.requests.slice(0, 2)) {
      r.expected.body = r.expected.body.replace(
        '"notifications": 2',
        '"notifications": 4',
      );
      for (const e of r.expected.events) {
        e.receivers.unshift("project_signals.Listener.callback");
        e.errors.unshift(false);
      }
    }
    assert.equal((await run(t, program, next)).outcome, "passed");
  },
);
test(
  "assembly-django native asynchronous dispatch guard acceptance",
  { skip },
  async (t) => {
    for (const method of [
      "send",
      "send_robust",
      "asend",
      "asend_robust",
    ] as const) {
      const robust = method.endsWith("robust");
      const program = {
        ...source,
        "project_signals.py":
          source["project_signals.py"]! +
          "\nasync def asynchronous(sender,**kwargs):\n    " +
          (robust
            ? "raise ValueError('Synthetic receiver result must not be exported')"
            : "notifications.append(kwargs['row'])") +
          "\nchanged.connect(asynchronous,weak=False,dispatch_uid='async.original')\n",
        "views.py": source["views.py"]!.replace(
          "changed.send(sender=OriginalSender,row=row['id'])",
          method.startsWith("a")
            ? "__import__('asyncio').run(changed." +
                method +
                "(sender=OriginalSender,row=row['id']))"
            : "changed." + method + "(sender=OriginalSender,row=row['id'])",
        ),
      };
      const next = structuredClone(profile);
      next.expectedSignals.unshift({
        ...next.expectedSignals[0]!,
        receiver: "project_signals.asynchronous",
        dispatchUid: '["string","async.original"]',
        async: true,
      });
      next.expectedSignals[1]!.position = 1;
      for (const r of next.requests.slice(0, 2)) {
        if (!robust)
          r.expected.body = r.expected.body.replace(
            '"notifications": 2',
            '"notifications": 4',
          );
        for (const e of r.expected.events) {
          e.method = method;
          e.receivers.push("project_signals.asynchronous");
          e.errors.push(robust);
        }
      }
      const report = await run(t, program, next);
      assert.equal(report.outcome, "passed");
      assert.equal(
        report.checks[0]!.processes[0]!.stdout.includes(
          "Synthetic receiver result",
        ),
        false,
      );
    }
  },
);
test(
  "assembly-django isolated bootstrap guard acceptance",
  { skip },
  async (t) => {
    const root = await project(t);
    for (const name of ["json", "importlib", "django", "asgiref"])
      await writeFile(
        path.join(root, name + ".py"),
        "from pathlib import Path\nPath('shadow.executed').write_text('bad')\nraise RuntimeError('Shadow executed')\n",
      );
    assert.equal((await validate(root, { trusted: true })).outcome, "passed");
    await assert.rejects(access(path.join(root, "shadow.executed")));
    const cached = await project(t);
    await mkdir(path.join(cached, "__pycache__"));
    const original = await readFile(path.join(cached, "settings.py"), "utf8");
    try {
      await writeFile(
        path.join(cached, "settings.py"),
        "raise RuntimeError('Unchecked cached settings ran')\n",
      );
      const compiled = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          "import py_compile;py_compile.compile('settings.py',cfile='__pycache__/settings.cpython-312.pyc',doraise=True,invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)",
        ],
        { cwd: cached, encoding: "utf8" },
      );
      assert.equal(compiled.status, 0, compiled.stderr);
    } finally {
      await writeFile(path.join(cached, "settings.py"), original);
    }
    assert.equal((await validate(cached, { trusted: true })).outcome, "passed");
  },
);
test(
  "assembly-django registration drift guard acceptance",
  { skip },
  async (t) => {
    for (const code of [
      "    import urls\n    original=urls.leaf[0].callback\n    def replacement(*args,**kwargs):return original(*args,**kwargs)\n    replacement.__module__=original.__module__;replacement.__qualname__=original.__qualname__\n    urls.leaf[0].callback=replacement\n",
      "    from project_signals import notice\n    changed.disconnect(dispatch_uid='catalog.notice')\n    changed.connect(notice,weak=False,dispatch_uid='catalog.notice')\n",
      "    import middleware\n    original=middleware.Initialize\n    class Replacement(original):pass\n    Replacement.__module__=original.__module__;Replacement.__qualname__=original.__qualname__\n    middleware.Initialize=Replacement\n",
    ]) {
      const report = await run(t, {
        ...source,
        "views.py": source["views.py"]!.replace(
          "    before=len(notifications)",
          code + "    before=len(notifications)",
        ),
      });
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.processes[0]!.exitCode, 4);
    }
  },
);
test(
  "assembly-django native observer replacement guard acceptance",
  { skip },
  async (t) => {
    for (const code of [
      "        from django.dispatch import Signal\n        Signal._live_receivers=lambda self,sender:([],[])\n",
      "        from django.dispatch import Signal\n        Signal.send=lambda self,sender,**kw:[]\n",
      "        changed.send=lambda sender,**kw:[]\n",
      "        from django.core.handlers import base\n        base.import_string=lambda name:object\n",
    ]) {
      const report = await run(t, {
        ...source,
        "extras/apps.py": source["extras/apps.py"]! + "\n" + code,
      });
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.processes[0]!.exitCode, 4);
    }
  },
);
test(
  "assembly-django limits and opaque metadata guard acceptance",
  { skip },
  async (t) => {
    for (const program of [
      {
        ...source,
        "urls.py": source["urls.py"]! + "\nurlpatterns.extend(leaf*2048)\n",
      },
      {
        ...source,
        "extras/apps.py":
          source["extras/apps.py"]! +
          "\n        for index in range(4097):changed.disconnect(dispatch_uid='absent')\n",
      },
      {
        ...source,
        "extras/apps.py":
          source["extras/apps.py"]! +
          "\n        changed.connect(notice,weak=False,dispatch_uid=object())\n",
      },
      {
        ...source,
        "project_signals.py": source["project_signals.py"]!.replace(
          "changed=Signal(use_caching=True)",
          "class Custom(Signal):pass\nchanged=Custom(use_caching=True)",
        ),
      },
    ]) {
      const report = await run(t, program);
      assert.equal(report.outcome, "incomplete");
      assert.equal(report.checks[0]!.processes[0]!.exitCode, 4);
      const reason = JSON.parse(report.checks[0]!.processes[0]!.stdout).reason;
      const expected = (program as Record<string, string>)["urls.py"]!.includes(
        "leaf*2048",
      )
        ? "Total URL hierarchy inventory limit"
        : (program as Record<string, string>)["extras/apps.py"]!.includes(
              "range(4097)",
            )
          ? "Signal operation limit"
          : (program as Record<string, string>)["extras/apps.py"]!.includes(
                "dispatch_uid=object()",
              )
            ? "Opaque dispatch UID"
            : "Unsupported or aliased selected signal";
      assert.equal(reason, expected);
    }
  },
);
test(
  "assembly-django WSGI request boundary guard acceptance",
  { skip },
  async (t) => {
    for (const headers of [
      [["Host", "bad"]],
      [["Content-Length", "1"]],
      [
        ["X-Test", "a"],
        ["x_test", "b"],
      ],
    ] as [string, string][][]) {
      const next = structuredClone(profile);
      next.requests[0]!.headers = headers;
      await assert.rejects(createPlan(await project(t, source, next)));
    }
    for (const host of ["root.example.test:0", "root.example.test:65536"]) {
      const next = structuredClone(profile);
      next.requests[0]!.host = host;
      await assert.rejects(createPlan(await project(t, source, next)));
    }
    const next = structuredClone(profile);
    next.requests[0]!.host = "root.example.test:8042";
    next.requests[0]!.expected.body = JSON.stringify({
      host: "root.example.test:8042",
      port: "8042",
    })
      .replaceAll(":", ": ")
      .replaceAll(",", ", ");
    // Literal native response avoids changing colons within the Host value.
    next.requests[0]!.expected.body =
      '{"host": "root.example.test:8042", "port": "8042"}';
    next.requests[0]!.expected.events = [];
    const program = {
      ...source,
      "views.py": source["views.py"]!.replace(
        "    before=len(notifications)",
        "    if request.META['HTTP_HOST'].endswith(':8042'):return JsonResponse({'host':request.get_host(),'port':request.META['SERVER_PORT']})\n    before=len(notifications)",
      ),
    };
    assert.equal((await run(t, program, next)).outcome, "passed");
  },
);

test("assembly-django namespace guard acceptance", { skip }, async (t) => {
  const program = {
    ...source,
    "urls.py": source["urls.py"]!.replace(
      "path('web/'",
      "path('shared/'",
    ).replace("path('mobile/'", "path('shared/'"),
  };
  const next = structuredClone(profile);
  for (const route of next.expectedRoutes.slice(0, 2))
    route.patterns[0] = '["RoutePattern","^shared/",32,false]';
  for (const request of next.requests.slice(0, 2)) {
    request.path = request.path
      .replace("/web/", "/shared/")
      .replace("/mobile/", "/shared/");
    request.expected.body = request.expected.body
      .replace("mobile:items", "web:items")
      .replace('"locale": "mobile"', '"locale": "web"');
  }
  const report = await run(t, program, next);
  assert.equal(report.outcome, "passed");
  assert.deepEqual(
    report.checks[0]!.runtime!.collections[0]!.entries.slice(0, 2).map(
      (e) => e.attributes.namespaces,
    ),
    [["web"], ["mobile"]],
  );
});

test(
  "assembly-django native model signal guard acceptance",
  { skip },
  async (t) => {
    const program = {
      ...source,
      "catalog/models.py":
        "from django.db import models\nclass OriginalObject(models.Model):\n    class Meta:app_label='catalog'\n",
      "project_signals.py": source["project_signals.py"]!.replace(
        "from django.dispatch import Signal",
        "from django.db.models.signals import ModelSignal",
      ).replace("changed=Signal(", "changed=ModelSignal("),
      "catalog/apps.py": source["catalog/apps.py"]!.replace(
        "changed.connect(notice,weak=False,dispatch_uid='catalog.notice')",
        "changed.connect(notice,sender='catalog.OriginalObject',weak=False,dispatch_uid='catalog.notice')",
      ),
      "extras/apps.py": source["extras/apps.py"]!.replace(
        "changed.connect(notice,weak=False,dispatch_uid='catalog.notice')",
        "changed.connect(notice,sender='catalog.OriginalObject',weak=False,dispatch_uid='catalog.notice')",
      ),
      "views.py": source["views.py"]!.replace(
        "    before=len(notifications)",
        "    from catalog.models import OriginalObject\n    before=len(notifications)",
      ).replace("sender=OriginalSender", "sender=OriginalObject"),
    };
    const next = structuredClone(profile);
    next.expectedApps[0]!.models = true;
    next.expectedSignals[0]!.sender = "catalog.models.OriginalObject";
    for (const request of next.requests.slice(0, 2))
      for (const event of request.expected.events)
        event.sender = "catalog.models.OriginalObject";
    const report = await run(t, program, next);
    assert.equal(report.outcome, "passed");
    assert.deepEqual(
      report.checks[0]!.runtime!.collections[2]!.entries.map(
        (e) => e.attributes.sender,
      ),
      ["catalog.models.OriginalObject"],
    );
  },
);
test(
  "assembly-django native response limits guard acceptance",
  { skip },
  async (t) => {
    for (const body of [
      "return __import__('django.http',fromlist=['StreamingHttpResponse']).StreamingHttpResponse([b'x']*65)",
      "return __import__('django.http',fromlist=['HttpResponse']).HttpResponse(b'x'*65537)",
    ]) {
      const report = await run(t, {
        ...source,
        "views.py": source["views.py"]!.replace(
          "    before=len(notifications)",
          "    " + body + "\n    before=len(notifications)",
        ),
      });
      assert.equal(report.outcome, "incomplete");
      const execution = report.checks[0]!.processes[0]!;
      assert.equal(execution.exitCode, 4);
      assert.equal(
        JSON.parse(execution.stdout).reason,
        "WSGI response byte or chunk limit",
      );
    }
  },
);
