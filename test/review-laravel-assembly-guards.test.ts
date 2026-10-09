import assert from "node:assert/strict";
import { test } from "node:test";
import { access, readFile, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { createPlan, validate } from "../src/engine.js";
import {
  available,
  source,
  profile,
  project,
  run,
} from "./review-laravel-assembly-fixture.js";
const skip = available
  ? false
  : "Prepared pinned PHP/Laravel assembly runtime unavailable";
const changed = (before: string, after: string) => {
  assert.equal(source["assembly.php"]!.split(before).length, 2);
  return {
    ...source,
    "assembly.php": source["assembly.php"]!.replace(before, after),
  };
};
const raw = (r: Awaited<ReturnType<typeof run>>) =>
  JSON.parse(r.checks[0]!.processes[0]!.stdout);
test(
  "assembly-laravel registration lifetime guard acceptance",
  { skip },
  async (t) => {
    const r = await run(
      t,
      changed(
        "$rows=AssemblyItem::query()->orderBy('id')->get();",
        "app('events')->listen('assembly.saved',AssemblyListener::class.'@handle');$rows=AssemblyItem::query()->orderBy('id')->get();",
      ),
    );
    assert.equal(r.outcome, "incomplete");
    assert.match(raw(r).reason, /registrations changed/);
    const schedule = await run(
      t,
      changed(
        "$rows=AssemblyItem::query()->orderBy('id')->get();",
        "app(Schedule::class)->call('assemblyRefresh')->name('assembly-added')->hourly();$rows=AssemblyItem::query()->orderBy('id')->get();",
      ),
    );
    assert.equal(schedule.outcome, "incomplete");
    assert.match(raw(schedule).reason, /registrations changed/);
  },
);
test(
  "assembly-laravel callback identity guard acceptance",
  { skip },
  async (t) => {
    const r = await run(
      t,
      changed(
        "$rows=AssemblyItem::query()->orderBy('id')->get();",
        "$original=app()->getBindings()['assembly.basic']['concrete'];app()->bind('assembly.basic',clone $original);$rows=AssemblyItem::query()->orderBy('id')->get();",
      ),
    );
    assert.equal(r.outcome, "incomplete");
    assert.match(raw(r).reason, /registrations changed|object lifetime/);
  },
);
test("assembly-laravel clock guard acceptance", { skip }, async (t) => {
  const r = await run(
    t,
    changed(
      "$rows=AssemblyItem::query()->orderBy('id')->get();",
      "Illuminate\\Support\\Facades\\Date::setTestNow(new DateTimeImmutable('2026-01-01T10:01:00Z'));$rows=AssemblyItem::query()->orderBy('id')->get();",
    ),
  );
  assert.equal(r.outcome, "incomplete");
  assert.match(raw(r).reason, /clock changed/);
  const factory = await run(
    t,
    changed(
      "$rows=AssemblyItem::query()->orderBy('id')->get();",
      "Illuminate\\Support\\DateFactory::useClass(Carbon\\CarbonImmutable::class);$rows=AssemblyItem::query()->orderBy('id')->get();",
    ),
  );
  assert.equal(factory.outcome, "incomplete");
  assert.match(raw(factory).reason, /creation is overridden/);
});
test(
  "assembly-laravel response byte budget guard acceptance",
  { skip },
  async (t) => {
    const prefix = "return response()->json(['body'=>$request->getContent(),";
    const r = await run(
      t,
      changed(
        prefix,
        "return new Illuminate\\Http\\Response(str_repeat('λ',32769));return response()->json(['body'=>$request->getContent(),",
      ),
    );
    assert.equal(r.outcome, "incomplete");
    assert.equal(raw(r).incomplete, "laravel-assembly");
    assert.match(raw(r).reason, /exceeds 64 KiB/);
    const next = structuredClone(profile);
    next.requests[4]!.expected.body = "λ".repeat(32768);
    const valid = await run(
      t,
      changed(
        prefix,
        "return new Illuminate\\Http\\Response(str_repeat('λ',32768));return response()->json(['body'=>$request->getContent(),",
      ),
      next,
    );
    assert.equal(valid.outcome, "passed");
    assert.equal(Buffer.byteLength(raw(valid).requests[4].responseBody), 65536);
  },
);
test(
  "assembly-laravel reserved path binding guard acceptance",
  { skip },
  async (t) => {
    const r = await run(
      t,
      changed(
        "Model::preventLazyLoading(true);",
        "Model::preventLazyLoading(true);$this->app->instance('path.config','original-unrelated-path');",
      ),
    );
    assert.equal(r.outcome, "incomplete");
    assert.match(raw(r).reason, /Reserved application path binding changed/);
  },
);
test("assembly-laravel native API guard acceptance", { skip }, async (t) => {
  const bootstrap =
    source["bootstrap/app.php"]!.replace(
      "return Application::configure",
      "class OriginalOpaqueKernel extends Illuminate\\Foundation\\Http\\Kernel {}\n$app=Application::configure",
    ) +
    "\n$app->bind(Illuminate\\Contracts\\Http\\Kernel::class,OriginalOpaqueKernel::class);return $app;\n";
  const r = await run(t, { ...source, "bootstrap/app.php": bootstrap });
  assert.equal(r.outcome, "incomplete");
  assert.match(raw(r).reason, /kernels are overridden/);
});
test(
  "assembly-laravel UTF-8 transport near miss acceptance",
  { skip },
  async (t) => {
    const next = structuredClone(profile);
    next.requests[4]!.body = "λ".repeat(8192);
    next.requests[4]!.expected.body =
      '{"body":"' +
      "\\u03bb".repeat(8192) +
      '","header":"original","terminatedBefore":4}';
    const r = await run(t, source, next);
    assert.equal(r.outcome, "passed");
    assert.equal(raw(r).requests[4].body, next.requests[4]!.body);
    const keys = structuredClone(profile);
    for (const row of keys.expectedCollections[0]!.entries)
      row.key = JSON.stringify(JSON.parse(row.key));
    keys.expectedCollections[4]!.entries.reverse();
    assert.equal((await run(t, source, keys)).outcome, "passed");
  },
);
test("assembly-laravel planning bounds guard acceptance", async (t) => {
  for (const configuration of [
    (() => {
      const x = structuredClone(profile);
      x.requests[0]!.body = "λ".repeat(20000);
      return x;
    })(),
    (() => {
      const x = structuredClone(profile);
      x.requests[0]!.headers.push({ name: "HOST", value: "foreign" });
      return x;
    })(),
    (() => {
      const x = structuredClone(profile);
      x.requests[0]!.headers.push({
        ...x.requests[0]!.headers[0]!,
        name: "ACCEPT",
      });
      return x;
    })(),
    (() => {
      const x = structuredClone(profile);
      x.models.push("AssemblyItem");
      return x;
    })(),
    (() => {
      const x = structuredClone(profile);
      x.expectedCollections[1]!.complete = false;
      return x;
    })(),
    (() => {
      const x = structuredClone(profile);
      x.expectedCollections[0]!.entries[0]!.key = "foreign";
      return x;
    })(),
  ]) {
    const root = await project(
      t,
      {
        ...source,
        "bootstrap/app.php":
          "<?php file_put_contents(__DIR__.'/../imported','ran');",
      },
      configuration,
      false,
    );
    await assert.rejects(createPlan(root));
    await assert.rejects(access(path.join(root, "imported")));
  }
});
test(
  "assembly-laravel missing prerequisite guard acceptance",
  { skip },
  async (t) => {
    const program = {
        ...source,
        "bootstrap/app.php":
          "<?php file_put_contents(__DIR__.'/../imported','ran');",
      },
      root = await project(t, program);
    const file = path.join(root, "vendor/composer/installed.json");
    const bytes = await readFile(file);
    await unlink(file);
    const missing = await validate(root, { trusted: true });
    assert.equal(missing.checks[0]!.status, "unavailable");
    assert.equal(raw(missing).reason, "missing-package");
    await assert.rejects(access(path.join(root, "imported")));
    await writeFile(file, "{}");
    const malformed = await validate(root, { trusted: true });
    assert.equal(malformed.outcome, "incomplete");
    await assert.rejects(access(path.join(root, "imported")));
    await writeFile(file, bytes);
  },
);

test(
  "assembly-laravel lazy-loading policy family acceptance",
  { skip },
  async (t) => {
    const program = changed(
      "Model::preventLazyLoading(true);",
      "Model::preventLazyLoading(true);Model::handleLazyLoadingViolationUsing(new AssemblyIgnoreLazyLoading());",
    );
    program["assembly.php"] +=
      "\nclass AssemblyIgnoreLazyLoading {public function __invoke($model,$relation){}}\n";
    const r = await run(t, program);
    assert.equal(r.outcome, "failed");
    assert.deepEqual(
      r.checks[0]!.findings!.map((f) => f.ruleId),
      ["laravel/assembly-bindings-mismatch"],
    );
    const entry = raw(r).runtime.collections[4].entries.find(
      (e: { attributes: { type: string } }) =>
        e.attributes.type === "model-defaults",
    );
    assert.equal(entry.attributes.lazyLoadingPrevented, true);
    assert.equal(
      entry.attributes.lazyLoadingHandler,
      "AssemblyIgnoreLazyLoading@__invoke",
    );
    assert.deepEqual(JSON.parse(raw(r).requests[0].responseBody).armed, [
      true,
      true,
    ]);
  },
);

test(
  "assembly-laravel model scope lifetime guard acceptance",
  { skip },
  async (t) => {
    const before = "$rows=AssemblyItem::query()->orderBy('id')->get();";
    const result = await run(
      t,
      changed(
        before,
        "AssemblyItem::addGlobalScope('assembly-late',fn($q)=>$q);" + before,
      ),
    );
    assert.equal(result.outcome, "incomplete");
    assert.match(raw(result).reason, /registrations changed/);
    // A differently named, unselected model has no selected-model scope contract.
    const adjacent = await run(
      t,
      changed(
        before,
        "AssemblyOwner::addGlobalScope('assembly-adjacent',fn($q)=>$q);" +
          before,
      ),
    );
    assert.equal(adjacent.outcome, "passed");
    assert.deepEqual(JSON.parse(raw(adjacent).requests[0].responseBody).armed, [
      true,
      true,
    ]);
  },
);
