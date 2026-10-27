import assert from "node:assert/strict";
import {
  copyFile,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
import {
  resolveWindowsExecutable,
  windowsEnvironment,
} from "../src/windows-process.js";
const { createNativeResourceFixture } = await import(
  new URL("../../scripts/native-resource-workloads.mjs", import.meta.url).href
);
const { measureWindowsResourceSample } = await import(
  new URL("../../scripts/measure-windows-resources.mjs", import.meta.url).href
);
const native = { skip: process.platform !== "win32", timeout: 420000 };

test(
  "native Windows resource workloads bind small large and polyglot validation jobs to output archive and whole-worker counters",
  native,
  async (t) => {
    const rows = [];
    for (const id of ["small", "large", "polyglot"]) {
      const root = await realpath(await fixture(t, {})),
        directory = await realpath(await fixture(t, {})),
        expected = await createNativeResourceFixture(root, id);
      const originalPath = process.env.PATH;
      let value;
      try {
        if (id === "polyglot") {
          const shadow = await realpath(await fixture(t, {}));
          await copyFile(process.execPath, path.join(shadow, "go.exe"));
          process.env.PATH = originalPath + path.delimiter + shadow;
          await assert.rejects(
            resolveWindowsExecutable(
              "go",
              root,
              windowsEnvironment(process.env),
            ),
            { code: "AMBIGUOUS_WINDOWS_EXECUTABLE" },
          );
        }
        value = await measureWindowsResourceSample({
          root,
          directory,
          expected,
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      assert.equal(value.executedTests, id === "polyglot" ? 2 : 1);
      assert.ok(value.nativeJobs > 0);
      assert.equal(value.cpuUnit, "100ns");
      assert.ok(value.jobCpu.user100ns + value.jobCpu.kernel100ns > 0);
      assert.ok(value.directPeakWorkingSetBytes > 0);
      assert.equal(value.summedProcessTreeRss, false);
      assert.equal(value.observer.resources.state, "collected");
      assert.equal(value.observer.childPid, value.pid);
      assert.equal(value.workerTransport.completeForObservedStreams, true);
      assert.equal(
        value.storage.physicalStoreBytes,
        value.storage.physicalStoreFiles.reduce(
          (n: number, f: { bytes: number }) => n + f.bytes,
          0,
        ),
      );
      assert.ok(value.storage.physicalStoreBytes > 0);
      assert.equal(JSON.stringify(value).includes(root), false);
      assert.equal(JSON.stringify(value).includes(directory), false);
      if (id === "polyglot")
        assert.equal(
          value.go.version,
          "go version go1.27.1 windows/" +
            (process.arch === "x64" ? "amd64" : process.arch),
        );
      rows.push(value);
    }
    assert.equal(rows.length, 3);
    assert.equal(rows[2].executedTests, 2);
    assert.ok(rows[1].reportBytes > rows[0].reportBytes);
    assert.ok(rows[1].observedOutputBytes > rows[0].observedOutputBytes);
    assert.equal(rows[1].storage.archiveBytes, rows[1].reportBytes);
    assert.equal(rows[1].storage.reconstructedSha256, rows[1].reportSha256);
    assert.ok(rows[1].storage.archiveChunks > 1);
    assert.equal(rows[0].storage.archiveBytes, 0);
  },
);

test(
  "native Windows resource measurement refuses original broken and stale workloads before publishing task storage",
  native,
  async (t) => {
    for (const variant of ["broken", "stale"]) {
      const root = await realpath(await fixture(t, {})),
        directory = await realpath(await fixture(t, {})),
        expected = await createNativeResourceFixture(root, "small");
      if (variant === "broken")
        await writeFile(
          path.join(root, "value-0000.js"),
          "export const value=100;\n",
        );
      else {
        const file = path.join(root, "values.test.js"),
          original = await readFile(file, "utf8");
        await writeFile(
          file,
          "import{writeFileSync}from'node:fs';writeFileSync('value-0000.js','export const value=0; // changed during execution\\n');\n" +
            original,
        );
      }
      await assert.rejects(
        measureWindowsResourceSample({ root, directory, expected }),
        (error: unknown) => {
          assert.match(
            (error as Error).message,
            variant === "broken"
              ? /Resource workload validation did not pass/
              : /Resource workload source changed/,
          );
          return true;
        },
      );
      assert.deepEqual((await readdir(directory)).sort(), ["fixture.json"]);
    }
  },
);
