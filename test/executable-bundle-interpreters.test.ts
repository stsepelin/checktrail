import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { loadExternalAdapter } from "../src/external-adapter.js";
import { fixture } from "./helpers.js";
import {
  executableFixture,
  bundleHash,
  bundleEndpoint,
  fetchBundleChild,
} from "./executable-bundle-fixture.js";
const programs = {
  python3: `import json,sys,platform,os,re
request=json.load(open(sys.argv[1]))
findings=[]
files=[]
for file in request['scope']:
    with open(os.path.join(request['root'], request['project'], file)) as source:
        for index,line in enumerate(source):
            if re.search(r'[ \t]+$', line.rstrip('\\r\\n')):
                findings.append(dict(ruleId='trailing-whitespace',level='error',message='Remove trailing spaces or tabs',file=file,line=index+1))
    files.append(dict(path=file,status='checked'))
print(json.dumps(dict(protocolVersion=1,identity=request['identity'],checkId=request['checkId'],sourceFingerprint=request['sourceFingerprint'],files=files,findings=findings,findingsComplete=True,tools=[dict(name='python',version=platform.python_version())])))
sys.exit(1 if findings else 0)
`,
  php: `<?php
declare(strict_types=1);
$request = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
$files = [];
$findings = [];
foreach ($request['scope'] as $file) {
    $text = file_get_contents($request['root'].'/'.$request['project'].'/'.$file);
    if ($text === false) { throw new RuntimeException('Could not read scoped input'); }
    foreach (explode("\\n", $text) as $index => $line) {
        if (preg_match('/[ \\t]+$/', rtrim($line, "\\r"))) {
            $findings[] = ['ruleId' => 'trailing-whitespace', 'level' => 'error', 'message' => 'Remove trailing spaces or tabs', 'file' => $file, 'line' => $index + 1];
        }
    }
    $files[] = ['path' => $file, 'status' => 'checked'];
}
echo json_encode(['protocolVersion' => 1, 'identity' => $request['identity'], 'checkId' => $request['checkId'], 'sourceFingerprint' => $request['sourceFingerprint'], 'files' => $files, 'findings' => $findings, 'findingsComplete' => true, 'tools' => [['name' => 'php', 'version' => PHP_VERSION]]], JSON_THROW_ON_ERROR);
exit(count($findings) ? 1 : 0);
`,
};
for (const runtime of ["python3", "php"] as const) {
  test(
    `packed ${runtime} adapters install without project imports and preserve native broken fixed and near-miss outcomes after explicit trusted registration`,
    {
      skip:
        spawnSync(
          runtime,
          runtime === "php" ? ["-n", "--version"] : ["--version"],
        ).status !== 0,
    },
    async (t) => {
      const program = programs[runtime];
      const packed = executableFixture(program);
      packed.manifest.runtime = runtime;
      const bytes = Buffer.from(
        JSON.stringify({
          ...packed.value,
          manifestBase64: Buffer.from(JSON.stringify(packed.manifest)).toString(
            "base64",
          ),
        }),
      );
      const endpoint = await bundleEndpoint(t, bytes);
      const store = await fixture(t, {});
      const fetched = await fetchBundleChild(
        store,
        endpoint.url + "/ok",
        bundleHash(bytes),
        endpoint.certificate,
      );
      assert.equal(fetched.exitCode, 0, fetched.stderr);
      const installed = JSON.parse(fetched.stdout);
      assert.equal(installed.activated, false);
      assert.equal(installed.codeExecuted, false);
      assert.deepEqual(await readdir(store), ["adapter.bundle.json"]);
      const reference = installed.reference;
      const loaded = await loadExternalAdapter(reference, true);
      assert.equal(loaded.contents.get("adapter.mjs")!.toString(), program);
      const root = await fixture(t, {
        "lines.project": "original synthetic",
        "value with spaces.txt": "bad  \n",
        "json.py": "raise RuntimeError('project shadow must not load')",
        "target/preserve": "retained",
      });
      assert.equal((await createPlan(root)).plan.checks.length, 0);
      await assert.rejects(
        validate(root, { trusted: false, externalAdapters: [reference] }),
        /trust/,
      );
      const options = { trusted: true, externalAdapters: [reference] };
      const broken = await validate(root, options);
      assert.equal(broken.outcome, "failed", JSON.stringify(broken.checks));
      assert.equal(
        broken.checks[0]!.findings?.[0]?.file,
        "value with spaces.txt",
      );
      assert.equal(broken.checks[0]!.findingsComplete, true);
      assert.equal(broken.sourceChanged, false);
      await writeFile(path.join(root, "value with spaces.txt"), "fixed\n");
      assert.equal((await validate(root, options)).outcome, "passed");
      await writeFile(
        path.join(root, "value with spaces.txt"),
        "near\tmiss\r\n",
      );
      const near = await validate(root, options);
      assert.equal(near.outcome, "passed");
      assert.equal(near.sourceChanged, false);
      assert.equal(
        await readFile(path.join(root, "target/preserve"), "utf8"),
        "retained",
      );
    },
  );
}
