import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const source = path.join(root, "scripts/producer-qualification");
const cohortEnvironment = { ...process.env };
// A real independent Node test process must not inherit the parent runner context.
delete cohortEnvironment.NODE_TEST_CONTEXT;
for (const [file, count, maximumSkips] of [
  ["web-runtime-controller.test.mjs", 25, process.platform === "win32" ? 4 : 0],
  ["web-runtime-inputs.test.mjs", 11, 2],
] as const) {
  test(
    `public runtime producer synthetic cohort: ${file}`,
    { timeout: 45000 },
    (t) => {
      const result = spawnSync(
        process.execPath,
        ["--test", "--test-reporter=tap", path.join(source, file)],
        {
          cwd: root,
          env: cohortEnvironment,
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 4 * 1024 ** 2,
        },
      );
      const diagnostic = [
        result.error?.message,
        `status=${String(result.status)} signal=${String(result.signal)}`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join("\n");
      assert.equal(result.error, undefined, diagnostic);
      assert.equal(result.signal, null, diagnostic);
      assert.equal(result.status, 0, diagnostic);
      assert.match(
        result.stdout,
        new RegExp(`^# tests ${count}$`, "mu"),
        diagnostic,
      );
      assert.match(result.stdout, /^# fail 0$/mu, diagnostic);
      assert.match(result.stdout, /^# cancelled 0$/mu, diagnostic);
      // Native-only cancellation and actual unavailable Python controls remain visible.
      const skipped = Number(/^# skipped (\d+)$/mu.exec(result.stdout)?.[1]);
      assert.ok(
        Number.isSafeInteger(skipped) &&
          skipped >= 0 &&
          skipped <= maximumSkips,
        diagnostic,
      );
      if (skipped > 0) {
        assert.match(
          result.stdout,
          /SKIP (?:POSIX group cancellation|POSIX source directory control|Verified Python 3 unavailable)/u,
          diagnostic,
        );
        const reason = /# SKIP ([^\n]+)/u.exec(result.stdout)?.[1];
        t.diagnostic(
          `Synthetic child controls: ${count - skipped} passed; ${skipped} explicitly skipped: ${reason ?? "unavailable native primitive"}`,
        );
        t.skip(
          `Synthetic cohort includes ${skipped} unavailable controls: ${reason ?? "unavailable native primitive"}`,
        );
      }
    },
  );
}
test("runtime native workflow stays in its exclusive push namespace and preserves execution admission", () => {
  const text = readFileSync(
    path.join(root, ".github/workflows/upstream-web-runtime.yml"),
    "utf8",
  );
  assert.match(text, /"pr\/upstream-runtime\/web-tree-sitter-\*"/u);
  assert.doesNotMatch(text, /pr\/upstream-producer\/binutils/u);
  assert.match(text, /runs-on: ubuntu-24\.04/u);
  assert.match(text, /workflow_dispatch:/u);
  assert.ok(
    text.includes(
      "startsWith(github.ref_name, 'pr/upstream-runtime/web-tree-sitter-npm-') && 'npm'",
    ),
  );

  assert.match(text, /--operator-trust-execution --coordinated-heavy-slot/u);
  assert.match(text, /permissions:\n {2}contents: read/u);
  const binutils = readFileSync(
    path.join(root, ".github/workflows/upstream-binutils.yml"),
    "utf8",
  );
  assert.doesNotMatch(binutils, /upstream-runtime/u);
});
