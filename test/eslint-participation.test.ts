import assert from "node:assert/strict";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { evaluate } from "../src/evidence.js";
import { fixture } from "./helpers.js";
import { copyESLint, eslintPolicy } from "./eslint-helpers.js";
import { copyInstalledPackages } from "./tool-fixture.js";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const config = (processed: boolean) =>
  `export default [{files:['**/*.js'],rules:{'no-debugger':'error'},${processed ? "processor:{preprocess(){return []},postprocess(messages){return messages.flat()}}," : "settings:{processor:'an inert label'},"}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];\n`;
test("legacy ESLint cannot pass a planned file when its processor emits zero code blocks", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"private":true,"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "eslint.config.mjs": config(true),
    "input.js": "debugger;\n",
  });
  await copyESLint(root);
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.checks[0]!.status, "inconclusive");
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  const input = raw.files.find((f: { path: string }) => f.path === "input.js");
  assert.equal(input.processorUsed, true);
  assert.equal(input.activeRules, 1);
  assert.equal(input.results.length, 1);
  assert.deepEqual(input.results[0].messages, []);
});
test("legacy ESLint processor-like settings and inert literals preserve native source checking", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"private":true,"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "eslint.config.mjs": config(false),
    "input.js": "export const label = 'processor debugger;';\n",
  });
  await copyESLint(root);
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "passed");
  assert.equal(report.checks[0]!.findingsComplete, true);
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  assert.ok(
    raw.files.every(
      (f: { processorUsed: boolean }) => f.processorUsed === false,
    ),
  );
  const planned = (await createPlan(root)).plan.checks[0]!;
  delete raw.files[0].processorUsed;
  assert.equal(
    evaluate(
      planned,
      [{ ...report.checks[0]!.processes[0]!, stdout: JSON.stringify(raw) }],
      root,
    ).status,
    "inconclusive",
  );
});

test("native ESLint participation reconciles identity and repeated blocks and refuses an empty processor", async (t) => {
  for (const count of [0, 1, 2]) {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": eslintPolicy(),
      "checktrail.javascript.json":
        '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
      "input.js": "export const label='debugger;';\n",
      "eslint.config.mjs": `export default [{files:['**/*.js'],rules:{'no-debugger':'error'},processor:{preprocess(text){return Array(${count}).fill(text)},postprocess(messages){return messages.flat()}}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];\n`,
    });
    await copyESLint(root);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, count === 0 ? "incomplete" : "passed");
    const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    const input = raw.files.find(
      (f: { path: string }) => f.path === "input.js",
    );
    assert.equal(
      input.participation.events.filter(
        (e: { kind: string }) => e.kind === "parse",
      ).length,
      count,
    );
    if (count === 2) {
      const planned = (await createPlan(root)).plan.checks[0]!;
      const removed = structuredClone(raw);
      const processed = removed.files.find(
        (f: { path: string }) => f.path === "input.js",
      );
      processed.participation.events.splice(1, 1);
      assert.equal(
        evaluate(
          planned,
          [
            {
              ...report.checks[0]!.processes[0]!,
              stdout: JSON.stringify(removed),
            },
          ],
          root,
        ).status,
        "inconclusive",
      );
      const early = structuredClone(raw);
      const events = early.files.find(
        (f: { path: string }) => f.path === "input.js",
      ).participation.events;
      events.splice(1, 0, events.pop());
      assert.equal(
        evaluate(
          planned,
          [
            {
              ...report.checks[0]!.processes[0]!,
              stdout: JSON.stringify(early),
            },
          ],
          root,
        ).status,
        "inconclusive",
      );
    }
  }
});

test("native ESLint participation reaches the TypeScript parser for named blocks and binds every planned source", async (t) => {
  for (const broken of [false, true]) {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": eslintPolicy(),
      "checktrail.javascript.json":
        '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
      "input.js": `export const value: number = 7;${broken ? "debugger;" : ""}\n`,
      "eslint.config.mjs": `import parser from '@typescript-eslint/parser';export default [{files:['**/*.js'],rules:{'no-debugger':'error'},processor:{preprocess(text){return [{text,filename:'leaf.ts'}]},postprocess(messages){return messages.flat()}}},{files:['**/*.ts'],languageOptions:{parser},rules:{'no-debugger':'error'}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];\n`,
    });
    await copyInstalledPackages(root, [
      "eslint",
      "@typescript-eslint/parser",
      "typescript",
    ]);
    const report = await validate(root, { trusted: true });
    assert.equal(report.outcome, broken ? "failed" : "passed");
    const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    const input = raw.files.find(
      (f: { path: string }) => f.path === "input.js",
    );
    assert.equal(input.participation.events[1].kind, "parse");
    assert.match(input.participation.events[1].input.path, /0_leaf\.ts$/);
    assert.equal(input.participation.events[1].successful, true);
    assert.deepEqual(
      input.results[0].messages.map((m: { ruleId: string }) => m.ruleId),
      broken ? ["no-debugger"] : [],
    );
    if (!broken) {
      const planned = (await createPlan(root)).plan.checks[0]!;
      for (const change of [
        "fingerprint",
        "configuration",
        "source",
        "version",
        "legacy",
      ]) {
        const stale = structuredClone(raw);
        if (change === "fingerprint") stale.sourceFingerprint = "0".repeat(64);
        if (change === "configuration")
          stale.configuration.sha256 = "0".repeat(64);
        if (change === "source")
          stale.files.find(
            (f: { path: string }) => f.path === "input.js",
          ).source.sha256 = "0".repeat(64);
        if (change === "version") stale.toolVersion = "0.0.0";
        if (change === "legacy") stale.schemaVersion = 1;
        assert.equal(
          evaluate(
            planned,
            [
              {
                ...report.checks[0]!.processes[0]!,
                stdout: JSON.stringify(stale),
              },
            ],
            root,
          ).status,
          "inconclusive",
        );
      }
    }
  }
});
test("native ESLint participation checks selected runtime bytes before importing configuration", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "checktrail.javascript.json":
      '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
    "input.js": "export const value=7;\n",
    "eslint.config.mjs":
      "import fs from 'node:fs';fs.writeFileSync('imported','ran');export default [{rules:{'no-debugger':'error'}}];\n",
  });
  await copyESLint(root);
  await createPlan(root);
  await assert.rejects(access(path.join(root, "imported")));
  const native = path.join(root, "node_modules/eslint/lib/api.js");
  await writeFile(
    native,
    Buffer.concat([await readFile(native), Buffer.from("\n")]),
  );
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "incomplete");
  assert.equal(report.checks[0]!.status, "unavailable");
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  assert.equal(raw.reason, "runtime-byte-mismatch");
  await assert.rejects(access(path.join(root, "imported")));
});

test("native ESLint participation does not evaluate opaque generated-block getters while describing source", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "checktrail.javascript.json":
      '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
    "input.js": "export const value=7;\n",
    "eslint.config.mjs":
      "import fs from 'node:fs';export default [{files:['**/*.js'],rules:{'no-debugger':'error'},processor:{preprocess(text){return [{filename:'leaf.js',get text(){fs.writeFileSync('getter-ran','ran');return text}}]},postprocess(messages){return messages.flat()}}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];\n",
  });
  await copyESLint(root);
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "incomplete");
  const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
  assert.equal(
    raw.files.find((f: { path: string }) => f.path === "input.js").participation
      .complete,
    false,
  );
  await assert.rejects(access(path.join(root, "getter-ran")));
});

test("native ESLint participation preserves private language receiver state and native rule callbacks", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "checktrail.javascript.json":
      '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
    "input.js": "export const value=7;\n",
    "eslint.config.mjs": `import {createRequire} from 'node:module';import path from 'node:path';const require=createRequire(import.meta.url);const native=require(path.join(path.dirname(require.resolve('eslint')),'languages/js/index.js'));class OriginalLanguage{#parsed=0;parse(file,options){this.#parsed++;return native.parse.call(native,file,options)}createSourceCode(file,result,options){if(this.#parsed<1)throw Error('Native parse must precede source creation');return native.createSourceCode.call(native,file,result,options)}}Object.setPrototypeOf(OriginalLanguage.prototype,native);const language=new OriginalLanguage();export default [{files:['**/*.js'],plugins:{original:{languages:{js:language},rules:{'forbid-debugger':{meta:{schema:[],languages:['original/js']},create(context){return {DebuggerStatement(node){context.report({node,message:'Original debugger statement'})}}}}}}},language:'original/js',rules:{'original/forbid-debugger':'error'}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];\n`,
  });
  await copyESLint(root);
  const fixed = await validate(root, { trusted: true });
  assert.equal(fixed.outcome, "passed", JSON.stringify(fixed.checks));
  await writeFile(path.join(root, "input.js"), "debugger;\n");
  const broken = await validate(root, { trusted: true });
  assert.equal(broken.outcome, "failed");
  assert.deepEqual(
    broken.checks[0]!.findings!.map((f) => f.ruleId),
    ["original/forbid-debugger"],
  );
});

test("native ESLint participation preserves Unicode, BOM, warnings and parser errors and refuses filtered leaves", async (t) => {
  for (const mode of ["unicode", "warning", "syntax", "filtered"]) {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": eslintPolicy(),
      "checktrail.javascript.json":
        '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
      "input.js":
        mode === "syntax"
          ? "export const = ;"
          : "\uFEFFexport const label='λ debugger;';" +
            (mode === "warning" ? "debugger;" : ""),
      "eslint.config.mjs": `export default [{files:['**/*.js'],rules:{'no-debugger':'${mode === "warning" ? "warn" : "error"}'},processor:{preprocess(text){return [{text,filename:'${mode === "filtered" ? "leaf.unsupported" : "leaf.js"}'}]},postprocess(messages){return messages.flat()}}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];`,
    });
    await copyESLint(root);
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      mode === "filtered"
        ? "incomplete"
        : mode === "unicode"
          ? "passed"
          : "failed",
      mode,
    );
    const raw = JSON.parse(report.checks[0]!.processes[0]!.stdout);
    const input = raw.files.find(
      (f: { path: string }) => f.path === "input.js",
    );
    if (mode === "unicode") {
      assert.equal(
        input.participation.events[0].input.sha256,
        input.source.sha256,
      );
      assert.equal(
        input.participation.events[1].input.bytes,
        input.source.bytes,
      );
    }
    if (mode === "warning") {
      assert.equal(input.results[0].warningCount, 1);
      assert.equal(report.checks[0]!.findings![0]!.level, "warning");
    }
    if (mode === "syntax") {
      assert.equal(input.participation.events[1].successful, false);
      assert.equal(input.results[0].fatalErrorCount, 1);
    }
    if (mode === "filtered")
      assert.equal(
        input.participation.events.filter(
          (e: { kind: string }) => e.kind === "parse",
        ).length,
        0,
      );
  }
});
test("native ESLint participation rejects every opaque processor output member without invoking accessors", async (t) => {
  for (const expression of [
    "[{text,get filename(){mark();return 'leaf.js'}}]",
    "Object.defineProperty([text],0,{get(){mark();return text}})",
    "new Proxy([text],{})",
    "[,text]",
    "[{filename:'leaf.js',text:'\\ud800'}]",
  ]) {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": eslintPolicy(),
      "checktrail.javascript.json":
        '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
      "input.js": "export const value=7;",
      "eslint.config.mjs": `import fs from 'node:fs';const mark=()=>fs.writeFileSync('getter-ran','yes');export default [{files:['**/*.js'],rules:{'no-debugger':'error'},processor:{preprocess(text){return ${expression}},postprocess(messages){return messages.flat()}}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];`,
    });
    await copyESLint(root);
    assert.equal(
      (await validate(root, { trusted: true })).outcome,
      "incomplete",
      expression,
    );
    await assert.rejects(access(path.join(root, "getter-ran")));
  }
});

test("native ESLint virtual leaves require their effective rules and permit an unruled processor container", async (t) => {
  for (const mode of ["unruled-leaf", "unruled-container", "broken-leaf"]) {
    const root = await fixture(t, {
      "package.json": '{"type":"module"}',
      "checktrail.json": eslintPolicy(),
      "checktrail.javascript.json":
        '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
      "input.js":
        "export const value: number=7;" +
        (mode !== "unruled-container" ? "debugger;" : ""),
      "eslint.config.mjs": `import parser from '@typescript-eslint/parser';export default [{files:['**/*.js'],rules:{'no-debugger':'${mode === "unruled-leaf" ? "error" : "off"}'},processor:{preprocess(text){return [{text,filename:'leaf.ts'}]},postprocess(messages){return messages.flat()}}},{files:['**/*.ts'],languageOptions:{parser},rules:{'no-debugger':'${mode === "unruled-leaf" ? "off" : "error"}'}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];`,
    });
    await copyInstalledPackages(root, [
      "eslint",
      "@typescript-eslint/parser",
      "typescript",
    ]);
    const report = await validate(root, { trusted: true });
    assert.equal(
      report.outcome,
      mode === "unruled-leaf"
        ? "incomplete"
        : mode === "broken-leaf"
          ? "failed"
          : "passed",
    );
    const input = JSON.parse(report.checks[0]!.processes[0]!.stdout).files.find(
      (f: { path: string }) => f.path === "input.js",
    );
    assert.equal(
      input.participation.events[1].activeRules,
      mode === "unruled-leaf" ? 0 : 1,
    );
    if (mode === "unruled-leaf") {
      assert.equal(input.activeRules, 1);
      assert.equal(input.results[0].errorCount, 0);
    } else assert.equal(input.activeRules, 0);
    if (mode === "broken-leaf")
      assert.equal(input.results[0].messages[0].ruleId, "no-debugger");
  }
});

test("native processor diagnostics preserve messages without inventing physical source coordinates", async (t) => {
  const root = await fixture(t, {
    "package.json": '{"type":"module"}',
    "checktrail.json": eslintPolicy(),
    "checktrail.javascript.json":
      '{"schemaVersion":1,"eslint":{"sourceParticipation":true}}',
    "input.js": "export const value=7;",
    "eslint.config.mjs": `export default [{files:['**/*.js'],rules:{'no-debugger':'error'},processor:{preprocess(){return ['\\n'.repeat(6)+'debugger;']},postprocess(messages){return messages.flat()}}},{files:['**/*.mjs'],rules:{'no-debugger':'error'}}];`,
  });
  await copyESLint(root);
  const report = await validate(root, { trusted: true });
  assert.equal(report.outcome, "failed");
  assert.equal(report.checks[0]!.findingsComplete, false);
  assert.equal(report.checks[0]!.findings![0]!.ruleId, "no-debugger");
  assert.equal(report.checks[0]!.findings![0]!.file, "input.js");
  assert.equal(report.checks[0]!.findings![0]!.line, undefined);
  const input = JSON.parse(report.checks[0]!.processes[0]!.stdout).files.find(
    (f: { path: string }) => f.path === "input.js",
  );
  assert.equal(input.results[0].messages[0].line, 7);
  assert.notEqual(
    input.participation.events[1].input.sha256,
    input.source.sha256,
  );
});
