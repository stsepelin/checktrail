import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";
import { build } from "vite";
import { fixture } from "./helpers.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const files = {
  "package.json": '{"type":"module"}',
  "src/entry.js":
    "import {scale} from './math.js';import {values} from './values.js';export const total=values.reduce((sum,value)=>sum+scale(value),0);export const count=values.length;",
  "src/math.js": "export const scale=value=>value*3;",
  "src/values.js": "export const values=[2,3,9];",
  "unused.js": "export const unused=;",
};

async function assertRootTool(name: "rolldown" | "vite") {
  const directory = await realpath(path.join(repository, "node_modules", name));
  const entry = await realpath(fileURLToPath(import.meta.resolve(name)));
  const relative = path.relative(directory, entry);
  assert.ok(
    relative &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative),
    "Development API must resolve from its direct root package",
  );
}

async function assertRunnableExports(
  output: { type: string; code?: string }[],
) {
  const chunks = output.filter((item) => item.type === "chunk");
  assert.equal(chunks.length, 1, "Synthetic static imports form one bundle");
  const code = chunks[0]!.code;
  assert.ok(typeof code === "string");
  const exported = await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  );
  assert.deepEqual(
    { total: exported.total, count: exported.count },
    { total: 42, count: 3 },
  );
}

function isSyntaxErrorAt(error: unknown, file: string): boolean {
  assert.ok(error instanceof Error);
  assert.ok("errors" in error && Array.isArray(error.errors));
  assert.ok(
    error.errors.some(
      (diagnostic: unknown) =>
        typeof diagnostic === "object" &&
        diagnostic !== null &&
        "code" in diagnostic &&
        diagnostic.code === "PARSE_ERROR" &&
        "id" in diagnostic &&
        typeof diagnostic.id === "string" &&
        path.normalize(diagnostic.id) === file,
    ),
    "Failure must contain a syntax diagnostic for the malformed imported module",
  );
  return true;
}

test(
  "live root Rolldown bundles imported source into runnable exports and rejects malformed reachable source",
  { timeout: 30_000 },
  async (t) => {
    await assertRootTool("rolldown");
    const root = await fixture(t, files);
    const closed = new Set<number>();
    let generation = 0;
    const generate = async () => {
      const invocation = ++generation;
      const bundle = await rolldown({
        input: path.join(root, "src/entry.js"),
        logLevel: "silent",
        plugins: [
          {
            name: "original-development-close-observer",
            closeBundle() {
              closed.add(invocation);
            },
          },
        ],
      });
      try {
        return await bundle.generate({ format: "es" });
      } finally {
        await bundle.close();
        assert.equal(bundle.closed, true);
      }
    };
    await assertRunnableExports((await generate()).output);
    assert.deepEqual(closed, new Set([1]));
    const malformed = path.normalize(
      await realpath(path.join(root, "src/math.js")),
    );
    await writeFile(malformed, "export const scale=;");
    await assert.rejects(generate(), (error: unknown) =>
      isSyntaxErrorAt(error, malformed),
    );
    assert.deepEqual(
      closed,
      new Set([1, 2]),
      "Failed generation also closes the original bundle",
    );
  },
);

test(
  "live root Vite bundles imported source into runnable exports and rejects malformed reachable source",
  { timeout: 30_000 },
  async (t) => {
    await assertRootTool("vite");
    const root = await fixture(t, files);
    const closed = new Set<number>();
    let generation = 0;
    const generate = () => {
      const invocation = ++generation;
      return build({
        root,
        configFile: false,
        envFile: false,
        publicDir: false,
        logLevel: "silent",
        plugins: [
          {
            name: "original-development-close-observer",
            closeBundle() {
              closed.add(invocation);
            },
          },
        ],
        build: {
          write: false,
          minify: false,
          emptyOutDir: false,
          watch: null,
          lib: { entry: path.join(root, "src/entry.js"), formats: ["es"] },
        },
      });
    };
    // Non-watch Vite builds close their internal bundles, including failed builds.
    const result = await generate();
    const outputs = Array.isArray(result) ? result : [result];
    try {
      assert.equal(outputs.length, 1);
      const output = outputs[0]!;
      assert.ok(
        "output" in output,
        "Non-watch build must return generated output",
      );
      await assertRunnableExports(output.output);
    } finally {
      for (const output of outputs) if ("close" in output) await output.close();
    }
    assert.deepEqual(closed, new Set([1]));
    const malformed = path.normalize(
      await realpath(path.join(root, "src/math.js")),
    );
    await writeFile(malformed, "export const scale=;");
    await assert.rejects(generate(), (error: unknown) =>
      isSyntaxErrorAt(error, malformed),
    );
    assert.deepEqual(
      closed,
      new Set([1, 2]),
      "Failed Vite generation also closes its internal bundle",
    );
  },
);
