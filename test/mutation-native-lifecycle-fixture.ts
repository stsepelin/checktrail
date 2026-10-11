import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, readlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { inventory } from "../src/inventory.js";
import { runMutations } from "../src/mutation.js";
import { nativeMutationReportSchema } from "../src/mutation-native-schema.js";
import { mutationHash } from "../src/mutation-native-copy.js";
import {
  mutationFixture,
  type MutationFamily,
} from "./mutation-native-fixture.js";
export type MutationInterruption =
  "cancel" | "timeout" | "output" | "source" | "dependency";
export async function mutationInterruption(
  t: TestContext,
  family: MutationFamily,
  kind: MutationInterruption,
) {
  const fixture = await mutationFixture(t, family),
    { root, file, recipe } = fixture;
  const folder = path.join(root, ".checktrail/original-native-body-witness");
  await mkdir(folder, { recursive: true });
  const parentMarker = path.join(folder, "parent.json"),
    childMarker = path.join(folder, "child.json"),
    releaseMarker = path.join(folder, "release");
  let source = fixture.source;
  const nodeChild = `const fs=require('node:fs');const end=Date.now()+30;while(Date.now()<end){};fs.writeFileSync(${JSON.stringify(childMarker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));setInterval(()=>{if(fs.existsSync(${JSON.stringify(releaseMarker)}))process.stderr.write(Buffer.alloc(8192,120));},1);`;
  const pythonChild = `import os,json,time\nend=time.monotonic()+0.03\nwhile time.monotonic()<end: pass\nwith open(${JSON.stringify(childMarker)},'w') as f: json.dump(dict(pid=os.getpid(),cwd=os.getcwd()),f)\nwhile True:\n    if os.path.exists(${JSON.stringify(releaseMarker)}):\n        try: os.write(2,b"x"*8192)\n        except BlockingIOError: pass\n    time.sleep(0.001)\n`;
  const phpLiteral = (value: string) =>
    "'" + value.replaceAll("\\", "\\\\").replaceAll("'", "\\'") + "'";
  const phpChild = `$end=microtime(true)+0.03;while(microtime(true)<$end){};file_put_contents(${JSON.stringify(childMarker)},json_encode(['pid'=>getmypid(),'cwd'=>getcwd()]));while(true){if(is_file(${JSON.stringify(releaseMarker)})){fwrite(STDERR,str_repeat("x",8192));}usleep(1000);}`;
  let anchor: string, instrument: string, modeAnchor: string;
  if (family === "vitest" || family === "jest") {
    source =
      (family === "vitest"
        ? "import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';\n"
        : "const{writeFileSync}=require('node:fs');const{spawn}=require('node:child_process');\n") +
      source;
    anchor = "{return left + right;}";
    modeAnchor = family === "vitest" ? "mode=0" : "exports.mode=0";
    instrument = `{if(${family === "vitest" ? "mode" : "exports.mode"}===4){spawn(process.execPath,['-e',${JSON.stringify(nodeChild)}],{stdio:['ignore','ignore','inherit']});const end=Date.now()+30;while(Date.now()<end){};writeFileSync(${JSON.stringify(parentMarker)},JSON.stringify({pid:process.pid,cwd:process.cwd()}));while(true){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);}}return left + right;}`;
  } else if (family === "pytest") {
    source = "import os,json,time,subprocess,sys\n" + source;
    anchor = "    return left + right\n";
    modeAnchor = "mode=0";
    instrument = `    if mode==4:\n        subprocess.Popen([sys.executable,'-I','-S','-c',${JSON.stringify(pythonChild)}],stdout=subprocess.DEVNULL,stderr=None)\n        end=time.monotonic()+0.03\n        while time.monotonic()<end: pass\n        with open(${JSON.stringify(parentMarker)},'w') as f: json.dump(dict(pid=os.getpid(),cwd=os.getcwd()),f)\n        while True: time.sleep(1)\n    return left + right\n`;
  } else {
    anchor = "{return $left + $right;}";
    modeAnchor = "MODE=0";
    instrument = `{if(self::MODE===4){$child=proc_open([PHP_BINARY,'-r',${phpLiteral(phpChild)}],[0=>['file','/dev/null','r'],1=>['file','/dev/null','w'],2=>STDERR],$pipes);$end=microtime(true)+0.03;while(microtime(true)<$end){};file_put_contents(${JSON.stringify(parentMarker)},json_encode(['pid'=>getmypid(),'cwd'=>getcwd()]));while(true){usleep(1000000);}}return $left + $right;}`;
  }
  assert.equal(source.split(anchor).length, 2);
  source = source.replace(anchor, instrument);
  await writeFile(path.join(root, file), source);
  recipe.mutations = [
    {
      id: "original-native-body-wait",
      file,
      expected: modeAnchor,
      replacement: modeAnchor.slice(0, -1) + "4",
    },
  ];
  const originalFingerprint = (await inventory(root)).fingerprint;
  const executable =
    family === "vitest" || family === "jest"
      ? process.execPath
      : spawnSync(
          family === "pytest" ? "python3" : "php",
          family === "pytest"
            ? ["-I", "-S", "-c", "import sys;print(sys.executable)"]
            : ["-r", "echo PHP_BINARY;"],
          { encoding: "utf8", timeout: 5000 },
        );
  if (typeof executable !== "string")
    assert.equal(executable.status, 0, executable.stderr);
  const expectedExecutableSha256 = mutationHash(
    await readFile(
      typeof executable === "string" ? executable : executable.stdout.trim(),
    ),
  );
  const controller = new AbortController();
  const running = runMutations(root, recipe, {
    trusted: true,
    timeoutMs: kind === "timeout" ? 60000 : 120000,
    signal: controller.signal,
  });
  const witnesses: {
    pid: number;
    start: string;
    cpuNanoseconds: string;
    cwd: string;
  }[] = [];
  let changedFile: string | undefined, changedBytes: Buffer | undefined;
  try {
    const end = Date.now() + 50000;
    for (const marker of [parentMarker, childMarker]) {
      let record: { pid: number; cwd: string } | undefined;
      while (Date.now() < end) {
        try {
          record = JSON.parse(await readFile(marker, "utf8"));
          break;
        } catch (e) {
          if (
            !["ENOENT"].includes((e as NodeJS.ErrnoException).code ?? "") &&
            !(e instanceof SyntaxError)
          )
            throw e;
        }
        await delay(5);
      }
      assert.ok(
        record,
        "Actual selected native test body/descendant did not report entry",
      );
      assert.ok(Number.isSafeInteger(record.pid) && record.pid > 1);
      assert.match(record.cwd, /\/checktrail-native-mutations-[^/]+\/trial-0$/);
      assert.equal(await readlink(`/proc/${record.pid}/cwd`), record.cwd);
      const stat = (await readFile(`/proc/${record.pid}/stat`, "utf8"))
        .split(") ")[1]!
        .split(" ");
      const cpuNanoseconds = (
        await readFile(`/proc/${record.pid}/schedstat`, "utf8")
      )
        .trim()
        .split(/\s+/)[0]!;
      assert.ok(
        BigInt(cpuNanoseconds) > 0n,
        "Marker alone does not prove native CPU execution",
      );
      process.kill(record.pid, "SIGSTOP");
      assert.equal(
        mutationHash(await readFile(`/proc/${record.pid}/exe`)),
        expectedExecutableSha256,
      );
      assert.equal(
        (await readFile(`/proc/${record.pid}/stat`, "utf8"))
          .split(") ")[1]!
          .split(" ")[19],
        stat[19],
      );
      witnesses.push({ ...record, start: stat[19]!, cpuNanoseconds });
    }
    assert.notEqual(witnesses[0]!.pid, witnesses[1]!.pid);
    assert.equal(witnesses[0]!.cwd, witnesses[1]!.cwd);
    if (kind === "source" || kind === "dependency") {
      changedFile = path.join(
        root,
        kind === "source"
          ? file
          : family === "pytest"
            ? ".checktrail/mutation-python-tools/pytest/__init__.py"
            : family === "phpunit"
              ? "vendor/phpunit/phpunit/phpunit"
              : `node_modules/${family}/package.json`,
      );
      changedBytes = await readFile(changedFile);
      await writeFile(
        changedFile,
        Buffer.concat([changedBytes, Buffer.from("\n")]),
      );
    }
    if (kind === "output") {
      await writeFile(releaseMarker, "original release");
      for (const witness of witnesses) process.kill(witness.pid, "SIGCONT");
    } else if (kind !== "timeout") controller.abort();
    const report = nativeMutationReportSchema.parse(await running);
    assert.equal(report.complete, false);
    assert.equal(report.baseline?.outcome, "passed");
    assert.equal(report.baseline?.tests?.total, 2);
    assert.equal(report.counts.killed + report.counts.survived, 0);
    assert.equal(
      report.trials[0]?.status,
      "inconclusive",
      JSON.stringify({
        kind,
        status: report.trials[0]?.status,
        observation: report.trials[0]?.observation?.outcome,
      }),
    );
    assert.equal(
      report.trials[0]?.observation?.[
        kind === "timeout"
          ? "timedOut"
          : kind === "output"
            ? "truncated"
            : "cancelled"
      ],
      true,
      JSON.stringify({
        kind,
        timedOut: report.trials[0]?.observation?.timedOut,
        cancelled: report.trials[0]?.observation?.cancelled,
        truncated: report.trials[0]?.observation?.truncated,
        bytes: report.trials[0]?.observation?.outputBytes,
      }),
    );
    if (kind === "source")
      assert.notEqual(report.finalSourceFingerprint, report.sourceFingerprint);
    else assert.equal(report.finalSourceFingerprint, report.sourceFingerprint);
    if (kind === "dependency")
      assert.notEqual(
        report.finalDependencyFingerprint,
        report.dependencyFingerprint,
      );
    else
      assert.equal(
        report.finalDependencyFingerprint,
        report.dependencyFingerprint,
      );
    for (const witness of witnesses) {
      try {
        assert.notEqual(
          (await readFile(`/proc/${witness.pid}/stat`, "utf8"))
            .split(") ")[1]!
            .split(" ")[19],
          witness.start,
          "Observed selected native process survived cleanup",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await assert.rejects(access(witness.cwd), { code: "ENOENT" });
      await assert.rejects(access(path.dirname(witness.cwd)), {
        code: "ENOENT",
      });
    }
    return {
      kind,
      nativeBodies: witnesses.length,
      nativeExecutableSha256: expectedExecutableSha256,
      cpuNanoseconds: witnesses.map((w) => w.cpuNanoseconds),
    };
  } finally {
    controller.abort();
    await running;
    if (changedFile && changedBytes) await writeFile(changedFile, changedBytes);
    assert.equal((await inventory(root)).fingerprint, originalFingerprint);
    assert.equal(await readFile(path.join(root, file), "utf8"), source);
  }
}
