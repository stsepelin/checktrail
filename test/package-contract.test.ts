import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { validate } from "../src/engine.js";
import {
  checkArchitecture,
  type DependencyGraph,
} from "../src/architecture.js";
import { fixture } from "./helpers.js";

const execute = promisify(execFile);
const compiler = fileURLToPath(
  new URL("../../node_modules/typescript", import.meta.url),
);
const example = fileURLToPath(
  new URL("../../examples/package-contract", import.meta.url),
);
test(
  "a real packed producer is validated by the installed consumer's type and runtime checks, including lying declarations",
  { timeout: 120_000 },
  async (t) => {
    const root = await fixture(t, {});
    await cp(example, root, { recursive: true });
    const producer = path.join(root, "producer");
    const consumer = path.join(root, "consumer");
    const artifacts = path.join(root, "artifacts");
    await mkdir(artifacts);
    const manifest = JSON.parse(
      await readFile(path.join(producer, "package.json"), "utf8"),
    );
    const original = await readFile(
      path.join(producer, "src/index.ts"),
      "utf8",
    );
    let revision = 0;
    async function install(source: string, postBuild?: () => Promise<void>) {
      manifest.version = `1.0.${revision++}`;
      await writeFile(
        path.join(producer, "package.json"),
        JSON.stringify(manifest),
      );
      await writeFile(path.join(producer, "src/index.ts"), source);
      await rm(path.join(producer, "dist"), { recursive: true, force: true });
      await execute(
        process.execPath,
        [path.join(compiler, "bin/tsc"), "--project", "tsconfig.json"],
        { cwd: producer, timeout: 30_000 },
      );
      await postBuild?.();
      const packed = await execute(
        "npm",
        [
          "pack",
          "--offline",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          artifacts,
        ],
        { cwd: producer, timeout: 30_000 },
      );
      const metadata = JSON.parse(packed.stdout)[0];
      assert.ok(
        metadata.files.some(
          (file: { path: string }) => file.path === "dist/index.js",
        ),
      );
      assert.ok(
        metadata.files.some(
          (file: { path: string }) => file.path === "dist/index.d.ts",
        ),
      );
      assert.ok(
        metadata.files.every(
          (file: { path: string }) =>
            file.path === "package.json" || file.path.startsWith("dist/"),
        ),
      );
      const tarball = path.join(artifacts, metadata.filename);
      await execute(
        "npm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          tarball,
        ],
        { cwd: consumer, timeout: 30_000 },
      );
      await cp(compiler, path.join(consumer, "node_modules/typescript"), {
        recursive: true,
      });
      const installed = JSON.parse(
        await readFile(
          path.join(
            consumer,
            "node_modules/@synthetic/catalog-domain/package.json",
          ),
          "utf8",
        ),
      );
      assert.equal(installed.version, manifest.version);
      return tarball;
    }
    const tarball = await install(original);
    const passed = await validate(consumer, { trusted: true });
    assert.equal(passed.outcome, "passed", JSON.stringify(passed.checks));
    assert.equal(
      passed.checks.find((check) => check.id === "javascript.node-test")!.tests!
        .passed,
      1,
    );
    const consumerManifest = JSON.parse(
      await readFile(path.join(consumer, "package.json"), "utf8"),
    );
    const producerHash = createHash("sha256")
      .update(await readFile(tarball))
      .digest("hex");
    const graph: DependencyGraph = {
      schemaVersion: 1,
      format: "dependency-graph",
      capturedAt: new Date().toISOString(),
      collector: {
        name: "synthetic-built-package-manifests",
        version: "1.0.0",
      },
      complete: true,
      projects: [
        {
          id: manifest.name,
          language: "typescript",
          sourceFingerprint: producerHash,
          complete: true,
        },
        {
          id: consumerManifest.name,
          language: "typescript",
          sourceFingerprint: passed.sourceFingerprint,
          complete: true,
        },
      ],
      dependencies: Object.keys(consumerManifest.dependencies)
        .filter((name) => name === manifest.name)
        .map((name) => ({ consumer: consumerManifest.name, producer: name })),
    };
    assert.equal(graph.dependencies.length, 1);
    const policy = JSON.parse(
      await readFile(path.join(root, "architecture.json"), "utf8"),
    );
    assert.equal(checkArchitecture(graph, policy).outcome, "passed");
    graph.dependencies.push({
      consumer: manifest.name,
      producer: consumerManifest.name,
    });
    assert.equal(checkArchitecture(graph, policy).counts.forbidden, 1);
    assert.equal(checkArchitecture(graph, policy).counts.cycles, 1);

    await install(
      original
        .replace("quantity: number;", "quantity: string;")
        .replace(
          "return { quantity };",
          "return { quantity: String(quantity) };",
        ),
    );
    const broken = await validate(consumer, { trusted: true });
    assert.equal(broken.outcome, "failed");
    assert.equal(
      broken.checks.find((check) => check.id === "javascript.typescript")!
        .status,
      "failed",
    );
    assert.equal(
      broken.checks.find((check) => check.id === "javascript.node-test")!.tests!
        .failed,
      1,
    );

    await install(original, () =>
      writeFile(
        path.join(producer, "dist/index.js"),
        "export function item(quantity) { return {quantity: String(quantity)}; }\n",
      ),
    );
    const misleading = await validate(consumer, { trusted: true });
    assert.equal(
      misleading.checks.find((check) => check.id === "javascript.typescript")!
        .status,
      "passed",
    );
    assert.equal(
      misleading.checks.find((check) => check.id === "javascript.node-test")!
        .status,
      "failed",
    );
    assert.equal(
      misleading.checks.find((check) => check.id === "javascript.node-test")!
        .tests!.failed,
      1,
    );

    await install(original);
    const fixed = await validate(consumer, { trusted: true });
    assert.equal(fixed.outcome, "passed", JSON.stringify(fixed.checks));
  },
);
