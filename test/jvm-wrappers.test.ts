import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runProcess } from "../src/runner.js";
import { cp, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createPlan, validate } from "../src/engine.js";
import { verifyJvmFile, verifyJvmToolchain } from "../src/jvm-extensions.js";
import { jvmToolchainPins } from "../src/jvm-toolchain-pins.js";
import { jvmWrapperArchives } from "../src/jvm-wrapper-pins.js";
import {
  jvmAtomic,
  jvmDecision,
  jvmGenerator,
  jvmOriginal,
  jvmWrappersSkip as skip,
} from "./jvm-wrappers-fixture.js";
import { fixture } from "./helpers.js";
const options = { skip, timeout: 240000 };
test(
  "selected JVM artifacts reject both size changes and same-size digest changes",
  options,
  async (t) => {
    const root = await fixture(t, { keep: "retained" }),
      prefix = await verifyJvmToolchain();
    for (const pin of jvmToolchainPins) {
      const file = path.join(root, pin.path);
      await mkdir(path.dirname(file), { recursive: true });
      await cp(path.join(prefix, pin.path), file);
    }
    const before = process.env.PATH;
    process.env.PATH = path.join(root, "bin") + path.delimiter + (before ?? "");
    try {
      assert.equal(await verifyJvmToolchain(), root);
      for (const pin of jvmToolchainPins) {
        const file = path.join(root, pin.path);
        await verifyJvmFile(file, pin);
        const handle = await open(file, "r+"),
          byte = Buffer.alloc(1);
        await handle.read(byte, 0, 1, 16);
        const original = byte[0]!;
        try {
          await handle.write(Buffer.from([original ^ 1]), 0, 1, 16);
          await assert.rejects(verifyJvmToolchain(), /checksum/);
        } finally {
          await handle.write(Buffer.from([original]), 0, 1, 16);
          await handle.close();
        }
        await verifyJvmFile(file, pin);
        const append = await open(file, "a");
        await append.writeFile("x");
        await append.close();
        try {
          await assert.rejects(verifyJvmToolchain(), /size/);
        } finally {
          const restore = await open(file, "r+");
          try {
            await restore.truncate(pin.bytes);
          } finally {
            await restore.close();
          }
        }
        await verifyJvmFile(file, pin);
      }
    } finally {
      if (before === undefined) delete process.env.PATH;
      else process.env.PATH = before;
    }
    assert.equal(await readFile(path.join(root, "keep"), "utf8"), "retained");
  },
);
test(
  "native JVM wrappers recheck original excluded archives after successful tests",
  options,
  async (t) => {
    for (const kind of ["maven", "gradle"] as const) {
      const f = await jvmOriginal(t, kind, true),
        archive = path.join(f.root, f.config.extensions!.archive);
      await jvmAtomic(
        path.join(f.root, "checktrail.json"),
        JSON.stringify({
          schemaVersion: 1,
          projects: [
            {
              path: ".",
              checks: [kind === "maven" ? "jvm.maven-test" : "jvm.gradle-test"],
              environment: ["CHECKTRAIL_JVM_ARCHIVE"],
            },
          ],
        }),
      );
      await jvmAtomic(
        path.join(f.root, "generators/BuildJavaGenerator.java"),
        jvmGenerator(jvmDecision(true)).replace(
          "Path output=",
          'Path archive=Path.of(System.getenv("CHECKTRAIL_JVM_ARCHIVE"));try(var file=new java.io.RandomAccessFile(archive.toFile(),"rw")){int b=file.read();file.seek(0);file.write(b^1);}Path output=',
        ),
      );
      assert.equal(
        (await createPlan(f.root)).plan.checks[0]!.commands.length,
        1,
      );
      const result = await validate(f.root, {
          trusted: true,
          timeoutMs: 120000,
          environment: { CHECKTRAIL_JVM_ARCHIVE: archive },
        }),
        check = result.checks[0]!;
      assert.equal(check.status, "error", JSON.stringify(check));
      assert.equal(check.findingsComplete, false);
      assert.equal(result.sourceChanged, false);
      assert.match(
        check.processes[0]!.stderr,
        kind === "maven" ? /BUILD SUCCESS/ : /BUILD SUCCESSFUL/,
      );
      const handle = await open(archive, "r+"),
        byte = Buffer.alloc(1);
      try {
        await handle.read(byte, 0, 1, 0);
        await handle.write(Buffer.from([byte[0]! ^ 1]), 0, 1, 0);
      } finally {
        await handle.close();
      }
      await verifyJvmFile(archive, jvmWrapperArchives[kind]);
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
test(
  "native JVM wrappers recheck bootstrap-produced distributions after successful tests",
  options,
  async (t) => {
    for (const kind of ["maven", "gradle"] as const) {
      const f = await jvmOriginal(t, kind, true);
      const extension = kind === "maven" ? "mvn.cmd" : "gradle.bat";
      const altered = jvmGenerator(jvmDecision(true)).replace(
        "Path output=",
        'Path temporary=Path.of(args[0]).getParent().getParent();try(var files=Files.walk(temporary)){Path unused=files.filter(p->p.toString().endsWith("/bin/' +
          extension +
          '")).findFirst().orElseThrow();byte[] bytes=Files.readAllBytes(unused);bytes[bytes.length-1]^=1;Files.write(unused,bytes);}Path output=',
      );
      await jvmAtomic(
        path.join(f.root, "generators/BuildJavaGenerator.java"),
        altered,
      );
      const result = await validate(f.root, {
          trusted: true,
          timeoutMs: 120000,
        }),
        check = result.checks[0]!;
      assert.equal(check.status, "error", JSON.stringify(check));
      assert.equal(check.findingsComplete, false);
      assert.equal(result.sourceChanged, false);
      assert.match(
        check.processes[0]!.stderr,
        kind === "maven" ? /BUILD SUCCESS/ : /BUILD SUCCESSFUL/,
      );
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
test(
  "native JVM generated source bytes remain bound after successful class and test witnesses",
  options,
  async (t) => {
    for (const kind of ["maven", "gradle"] as const) {
      const f = await jvmOriginal(t, kind, true),
        file = path.join(
          f.root,
          "consumer/src/test/java/checks/ConsumerTest.java",
        );
      await jvmAtomic(
        file,
        (await readFile(file, "utf8")).replace(
          "void exact_and_delimited(){",
          'void exact_and_delimited() throws Exception {java.nio.file.Files.writeString(java.nio.file.Path.of("..","policy/src/main/java/policy/Rules.java"),"// changed generated source");',
        ),
      );
      const result = await validate(f.root, {
          trusted: true,
          timeoutMs: 120000,
        }),
        check = result.checks[0]!;
      assert.equal(check.status, "error", JSON.stringify(check));
      assert.equal(check.findingsComplete, false);
      assert.equal(result.sourceChanged, false);
      assert.match(
        check.processes[0]!.stderr,
        kind === "maven" ? /BUILD SUCCESS/ : /BUILD SUCCESSFUL/,
      );
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "actual JVM invoker mirrors live output before a native child terminates",
  options,
  async (t) => {
    const root = await fixture(t, {
      "LiveNative.java":
        'import java.nio.file.*;public class LiveNative {public static void main(String[] args)throws Exception{Files.writeString(Path.of(args[0]),Long.toString(ProcessHandle.current().pid()));System.err.print("x".repeat(65536));System.err.flush();Thread.sleep(60000);}}',
    });
    const compiled = spawnSync(
      "javac",
      ["-d", root, path.join(root, "LiveNative.java")],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const helper = pathToFileURL(
      fileURLToPath(new URL("../src/jvm-invoke.js", import.meta.url)),
    ).href;
    const worker =
      "import{jvmInvoker}from " +
      JSON.stringify(helper) +
      ';await jvmInvoker(process.env)("java",["-cp",process.argv[1],"LiveNative",process.argv[2]]);';
    const result = await runProcess(
      root,
      {
        executable: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          worker,
          root,
          path.join(root, "reached"),
        ],
        cwd: ".",
        temporaryDirectory: true,
      },
      { timeoutMs: 6000, maxOutputBytes: 8192 },
    );
    const pid = Number(await readFile(path.join(root, "reached"), "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    assert.equal(result.truncated, true);
    assert.equal(
      result.timedOut,
      false,
      "Live native output must exhaust the outer byte limit before wall timeout",
    );
    assert.equal(result.cancelled, false);
    assert.equal(result.errorCode, undefined);
    assert.ok(result.outputBytes > 8192);
    assert.ok(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <=
        8192,
    );
    assert.throws(
      () => process.kill(pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  },
);
