import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers/promises";
import { createGateway } from "./agent-evaluation-gateway.mjs";

const [image, runtime, output, ...extra] = process.argv.slice(2);
assert.ok(
  image && runtime && output && !extra.length,
  "Usage: verify-evaluation-isolation.mjs IMAGE_DIGEST PUBLIC_RUNTIME OUTPUT_JSON",
);
const temporary = await fs.realpath(
  await fs.mkdtemp(path.join(os.tmpdir(), "checktrail-isolation-canary-")),
);
const source = path.join(temporary, "source");
const secret = path.join(temporary, "withheld-answer.txt");
const results = [];
let gateway;
try {
  await fs.mkdir(source);
  await fs.writeFile(secret, "synthetic withheld answer");
  await fs.writeFile(
    path.join(source, "test_value.py"),
    "import unittest\nclass ValueTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(1 + 1, 2)\n",
  );
  await fs.writeFile(
    path.join(source, "pyproject.toml"),
    '[project]\nname = "synthetic-evaluation-boundary"\nversion = "0.0.0"\n',
  );
  await fs.writeFile(
    path.join(source, "checktrail.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [{ path: ".", checks: ["python.unittest"] }],
    }),
  );
  const config = {
    schemaVersion: 1,
    source,
    files: ["test_value.py", "pyproject.toml", "checktrail.json"],
    audit: path.join(temporary, "audit.jsonl"),
    image,
    runtime: await fs.realpath(runtime),
    dependencies: null,
    treatment: true,
    native: {
      executable: "python3",
      args: ["-B", "-m", "unittest", "discover", "-s", "."],
    },
    languages: ["python", "javascript"],
    timeoutMs: 10000,
    maxOutputBytes: 65536,
  };
  gateway = await createGateway(config);
  async function call(name, args = {}) {
    const result = await gateway.call(name, args);
    results.push({ tool: name, ...result });
    return result;
  }
  assert.equal(
    (await call("evaluation_read", { file: "../withheld-answer.txt" })).ok,
    false,
  );
  const probe = await call("evaluation_probe", {
    language: "python",
    code: `
import os, pathlib, socket, json
paths = ${JSON.stringify([secret, config.audit, "/runtime", "/worker.mjs", "/var/run/docker.sock", "/root/.codex/auth.json", "/Users"])}
def inaccessible(p):
    try:
        return not pathlib.Path(p).exists()
    except PermissionError:
        return True
assert all(inaccessible(p) for p in paths), "host/runtime mount exposed"
try:
    pathlib.Path('/source/test_value.py').write_text('changed')
    raise AssertionError('source is writable')
except OSError:
    pass
pathlib.Path('/tmp/scratch').write_text('allowed')
assert pathlib.Path('/tmp/scratch').read_text() == 'allowed'
sock = socket.socket(); sock.settimeout(1)
try:
    sock.connect(('1.1.1.1',443))
    raise AssertionError('external network available')
except OSError:
    pass
finally:
    sock.close()
assert os.getuid() == 65532
print(json.dumps({'sourceReadonly':True,'hostFilesInaccessible':True,'engineUnavailableToProbes':True,'networkDenied':True,'scratchWritable':True,'nonroot':True}))
`,
  });
  assert.equal(probe.value?.exitCode, 0, JSON.stringify(probe));
  const fresh = await call("evaluation_probe", {
    language: "javascript",
    code: "import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(fs.existsSync('/tmp/scratch'), false); assert.equal(fs.existsSync('/runtime'), false); console.log('fresh scratch and no treatment bypass');",
  });
  assert.equal(fresh.value?.exitCode, 0, JSON.stringify(fresh));
  assert.equal((await call("evaluation_native")).value?.exitCode, 0);
  const validation = await call("checktrail_validate");
  assert.equal(
    validation.value?.trace?.result?.outcome,
    "passed",
    JSON.stringify(validation),
  );
  assert.equal(validation.value.trace.retainedReportVerified, true);
  await gateway.close();
  gateway = undefined;
  gateway = await createGateway({
    ...config,
    audit: path.join(temporary, "cancel-audit.jsonl"),
  });
  const pending = call("evaluation_probe", {
    language: "python",
    code: "import time; time.sleep(60)",
  });
  await setTimeout(500);
  await gateway.close();
  assert.equal((await pending).value?.cancelled, true);
  gateway = undefined;
  await fs.writeFile(
    path.join(source, "test_value.py"),
    "import unittest\nclass ValueTest(unittest.TestCase):\n    def test_value(self):\n        self.assertEqual(1 + 1, 3)\n",
  );
  gateway = await createGateway({
    ...config,
    audit: path.join(temporary, "failed-audit.jsonl"),
  });
  assert.equal((await call("evaluation_native")).value?.exitCode, 1);
  assert.equal(
    (await call("checktrail_validate")).value?.trace?.result?.outcome,
    "failed",
  );
  await gateway.close();
  gateway = undefined;
  gateway = await createGateway({
    ...config,
    audit: path.join(temporary, "limits-audit.jsonl"),
    timeoutMs: 1000,
    maxOutputBytes: 1024,
  });
  const overflow = await call("evaluation_probe", {
    language: "python",
    code: "print('x' * 100000)",
  });
  assert.equal(overflow.value?.truncated, true);
  const timed = await call("evaluation_probe", {
    language: "python",
    code: "import time; time.sleep(60)",
  });
  assert.equal(timed.value?.timedOut, true);
  await gateway.close();
  gateway = undefined;
  for (const result of results) {
    if (!result.value || !("exitCode" in result.value)) continue;
    const { integrity, cancelled } = result.value;
    assert.equal(integrity.verified, !cancelled);
    assert.equal(integrity.scope, "mounted-trees-per-execution");
    assert.deepEqual(integrity.before, integrity.expected);
    if (!cancelled) assert.deepEqual(integrity.after, integrity.expected);
    else assert.equal(integrity.after, null);
  }
  const lifecycle = [];
  for (const file of [
    "audit.jsonl",
    "cancel-audit.jsonl",
    "failed-audit.jsonl",
    "limits-audit.jsonl",
  ]) {
    const records = (await fs.readFile(path.join(temporary, file), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    const end = records.at(-1);
    assert.equal(end.type, "end");
    assert.equal(end.cleanupCompleted, true);
    assert.equal(end.sourceSnapshotRemoved, true);
    assert.equal(end.integrityScope, "completed-execution-calls");
    assert.equal("runtimeUnchanged" in end, false);
    lifecycle.push(end);
  }
  await fs.writeFile(
    output,
    JSON.stringify(
      { schemaVersion: 1, image, results, lifecycle, verified: true },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  process.stdout.write(
    "Evaluation boundary, native/MCP controls and execution limits verified.\n",
  );
} finally {
  await gateway?.close();
  await fs.rm(temporary, { recursive: true, force: true });
}
