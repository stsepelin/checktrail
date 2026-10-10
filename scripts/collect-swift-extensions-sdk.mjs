import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
const roots = {
  swift: "/usr/lib/swift",
  include: "/usr/include",
  clang: "/usr/lib/clang/17",
};
const pins = [],
  aliases = [];
let entries = 0,
  total = 0;
for (const [name, root] of Object.entries(roots)) {
  assert.equal(
    await realpath(root),
    root,
    "Selected SDK root must be canonical",
  );
  const walk = async (relative, depth) => {
    assert.ok(depth <= 32);
    for (const entry of await readdir(path.join(root, relative), {
      withFileTypes: true,
    })) {
      assert.ok(++entries <= 20000, "SDK traversal entry bound");
      const rel = path.posix.join(relative, entry.name),
        file = path.join(root, rel);
      if (entry.isDirectory()) {
        if (
          name === "swift" &&
          depth === 0 &&
          ![
            "linux",
            "shims",
            "_foundation_unicode",
            "_FoundationCShims",
            "dispatch",
            "os",
            "pm",
            "host",
          ].includes(entry.name)
        )
          continue;
        if (name === "swift" && relative === "host" && entry.name !== "plugins")
          continue;
        await walk(rel, depth + 1);
        continue;
      }

      if (
        !/\.(?:h|modulemap|swiftinterface|swiftmodule)$/.test(entry.name) &&
        !rel.startsWith("host/plugins/") &&
        rel !== "host/libSwiftInProcPluginServer.so"
      )
        continue;
      const resolved = await realpath(file);
      if (entry.isSymbolicLink()) {
        assert.ok(
          Object.values(roots).some((root) => resolved.startsWith(root + "/")),
          "SDK file alias escapes selected roots",
        );
        aliases.push({ path: file, resolved });
      } else assert.equal(resolved, file);
      const stat = await lstat(resolved);
      assert.ok(
        stat.isFile() && stat.size >= 0 && stat.size <= 128 * 1024 * 1024,
        file + " SDK size " + stat.size,
      );

      const bytes = await readFile(resolved);
      assert.equal(bytes.length, stat.size);
      total += bytes.length;
      assert.ok(
        total <= 512 * 1024 * 1024 && pins.length < 4096,
        `Selected SDK pin bound: ${pins.length} files / ${total} bytes`,
      );
      pins.push({
        root: name,
        path: rel,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  };
  await walk("", 0);
}
assert.ok(pins.length > 0);
pins.sort((a, b) =>
  (a.root + "/" + a.path).localeCompare(b.root + "/" + b.path, "en"),
);

for (const file of ["/usr/lib/swift/clang"]) {
  const physical = await realpath(file);
  assert.equal(
    physical,
    "/usr/lib/clang/17",
    "Pinned compiler header alias differs",
  );
  aliases.push({ path: file, resolved: physical });
}
process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    pins,
    bytes: total,
    aliases,
    pinsSha256: createHash("sha256").update(JSON.stringify(pins)).digest("hex"),
    selection:
      "Regular GNU Linux SDK modules/interfaces, manifest/plugin APIs, macros and C headers; aliases are resolved only within selected roots; the full toolchain/OS/license closure is not certified.",
    wholeRuntimeClosureVerified: false,
  }) + "\n",
);
