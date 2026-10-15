import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const roots = ["/usr/include", "/usr/lib/llvm22/lib/clang/22/include"];
const runtime = [
  "/usr/lib/Scrt1.o",
  "/usr/lib/crt1.o",
  "/usr/lib/crti.o",
  "/usr/lib/crtn.o",
  "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/crtbeginS.o",
  "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/crtendS.o",
  "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/libgcc.a",
  "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/libgcc_eh.a",
  "/usr/lib/libstdc++.so",
  "/usr/lib/libstdc++.so.6",
  "/usr/lib/libgcc_s.so",
  "/usr/lib/libgcc_s.so.1",
  "/usr/lib/libc.so",
  "/usr/lib/libm.a",
  "/usr/lib/libssp_nonshared.a",
  "/lib/ld-musl-aarch64.so.1",
  "/lib/libc.musl-aarch64.so.1",
];
const selected = (file) =>
  roots.some((r) => file.startsWith(r + "/")) ||
  /^\/usr\/lib\/libstdc\+\+\.so\.6\.0\.34$/.test(file) ||
  runtime.includes(file);
const pins = new Map();
let entries = 0,
  total = 0;
const pin = async (file) => {
  if (pins.has(file)) return;
  const resolved = await realpath(file);
  assert.ok(
    selected(resolved),
    "SDK alias escapes selected roots: " + resolved,
  );
  const stat = await lstat(resolved);
  assert.ok(
    stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size >= 0 &&
      stat.size <= 128 * 1024 * 1024,
  );
  const bytes = await readFile(resolved);
  assert.equal(bytes.length, stat.size);
  total += bytes.length;
  assert.ok(
    total <= 512 * 1024 * 1024 && pins.size < 8192,
    "Selected C/C++ SDK bound",
  );
  pins.set(file, {
    path: file.slice(1),
    resolved: resolved.slice(1),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  if (resolved !== file) await pin(resolved);
};
for (const root of roots) {
  assert.equal(await realpath(root), root);
  const walk = async (directory, depth) => {
    assert.ok(depth <= 32);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 20000);
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file, depth + 1);
      else {
        assert.ok(
          entry.isFile() || entry.isSymbolicLink(),
          "SDK non-file entry",
        );
        await pin(file);
      }
    }
  };
  await walk(root, 0);
}
for (const file of runtime) await pin(file);
const result = [...pins.values()].sort((a, b) =>
  a.path.localeCompare(b.path, "en"),
);
assert.ok(result.length > 0);
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    pins: result,
    bytes: total,
    pinsSha256: createHash("sha256")
      .update(JSON.stringify(result))
      .digest("hex"),
    selection:
      "Pinned musl C/C++ and Clang resource headers, GCC CRT/static support and selected libstdc++/libgcc/musl runtime entries including physical aliases. This is not the complete OS/toolchain/publisher/license closure.",
    wholeRuntimeClosureVerified: false,
  }) + "\n",
);
