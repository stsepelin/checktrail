import assert from "node:assert/strict";
import { type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const mirrors = await import(
  pathToFileURL(path.join(repository, "scripts/prepare-ubuntu-mirrors.mjs"))
    .href
);
const main = "/etc/apt/apt-mirrors.txt";
const security = "/etc/apt/apt-mirrors-security.txt";
const original =
  "# opaque synthetic mirror settings\nhttp://azure.archive.ubuntu.com/ubuntu/\nhttps://archive.ubuntu.com/ubuntu/\tpriority:10 arch:amd64\nhttps://security.ubuntu.com/ubuntu/";
const context = {
  platform: "linux",
  uid: 0,
  effectiveUid: 0,
  githubActions: "true",
  runnerEnvironment: "github-hosted",
};
const sourceFor = (targets = [main]) =>
  "Types: deb\nURIs: " +
  targets.map((value) => "mirror+file:" + value).join("\n ") +
  "\nSuites: synthetic synthetic-updates synthetic-security\nComponents: main universe\nSigned-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg\n";
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
type Faults = {
  owner?: string;
  beforeRead?: (target: string) => Promise<void>;
  beforeRename?: (count: number, from: string, to: string) => Promise<void>;
  afterRename?: (count: number, from: string, to: string) => Promise<void>;
};
async function fixture(
  targets = [main],
  source = sourceFor(targets),
  faults: Faults = {},
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "checktrail-mirrors-")),
  );
  const physical = (target: string) => {
    assert.ok(
      target === "/etc" || target.startsWith("/etc/"),
      "Synthetic IO must never access actual /etc",
    );
    return path.join(root, target.slice(1));
  };
  await fs.mkdir(physical("/etc/apt/sources.list.d"), {
    recursive: true,
    mode: 0o755,
  });
  for (const directory of ["/etc", "/etc/apt", "/etc/apt/sources.list.d"])
    await fs.chmod(physical(directory), 0o755);
  await fs.writeFile(physical(mirrors.ubuntuMirrorSource), source, {
    mode: 0o644,
  });
  for (const target of targets)
    await fs.writeFile(physical(target), original, { mode: 0o644 });
  const actions: { kind: string; target?: string; flags?: number }[] = [];
  let handles = 0,
    renames = 0;
  const rooted = (stat: BigIntStats, target: string) =>
    Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      uid: faults.owner === target ? 1001n : 0n,
      gid: 0n,
    });
  const io = {
    syntheticCatalog: targets,
    async lstat(target: string, options: { bigint: true }) {
      actions.push({ kind: "lstat", target });
      return rooted(await fs.lstat(physical(target), options), target);
    },
    async realpath(target: string) {
      const value = await fs.realpath(physical(target));
      return "/" + path.relative(root, value).split(path.sep).join("/");
    },
    async open(target: string, flags: number, mode?: number) {
      actions.push({ kind: "open", target, flags });
      const handle = await fs.open(physical(target), flags, mode);
      handles++;
      let closed = false;
      return new Proxy(handle, {
        get(value, key) {
          if (key === "stat")
            return async (options: { bigint: true }) =>
              rooted(await value.stat(options), target);
          // Synthetic files stay owned by the test process. Only ownership metadata
          // is modeled as root; all bytes, modes, links, descriptors and renames are real.
          if (key === "chown")
            return async (uid: number, gid: number) => {
              assert.equal(uid, 0);
              assert.equal(gid, 0);
            };
          if (key === "read")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              await faults.beforeRead?.(target);
              return value.read(buffer, offset, length, position);
            };
          if (key === "write")
            return async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              actions.push({ kind: "write", target });
              return value.write(buffer, offset, length, position);
            };
          if (key === "close")
            return async () => {
              if (!closed) {
                closed = true;
                handles--;
              }
              return value.close();
            };
          const member = Reflect.get(value, key, value);
          return typeof member === "function" ? member.bind(value) : member;
        },
      });
    },
    async rename(from: string, to: string) {
      const count = ++renames;
      actions.push({ kind: "rename", target: to });
      await faults.beforeRename?.(count, from, to);
      await fs.rename(physical(from), physical(to));
      await faults.afterRename?.(count, from, to);
    },
    async unlink(target: string) {
      actions.push({ kind: "unlink", target });
      return fs.unlink(physical(target));
    },
  };
  return {
    root,
    physical,
    io,
    actions,
    faults,
    get handles() {
      return handles;
    },
    read: (target: string) => fs.readFile(physical(target), "utf8"),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

const prepare = (
  io: Awaited<ReturnType<typeof fixture>>["io"],
  value: unknown,
) => mirrors.prepareUbuntuMirrorsWithIo(io, value, io.syntheticCatalog);

test("scoped mirror preparation retains every original byte and restores source, modes and original lists", async () => {
  const f = await fixture();
  let session;
  try {
    const before = await fs.stat(f.physical(main));
    session = await prepare(f.io, context);
    assert.equal(session.metadata.state, "prepared");
    assert.equal(session.metadata.changedCount, 1);
    const prepared = mirrors.ubuntuMirrorCandidate + "\n" + original;
    assert.equal(await f.read(main), prepared);
    assert.equal(await f.read(mirrors.ubuntuMirrorSource), sourceFor());
    assert.deepEqual(session.metadata.hashes, [
      { original: digest(original), prepared: digest(prepared) },
    ]);
    assert.ok(!JSON.stringify(session.metadata).includes("ubuntu.com"));
    assert.ok(!JSON.stringify(session.metadata).includes("opaque synthetic"));
    const restored = await session.restore();
    assert.equal(restored.state, "restored");
    assert.equal(restored.restoredCount, 1);
    assert.equal(await f.read(main), original);
    const after = await fs.stat(f.physical(main));
    assert.deepEqual(
      [after.mode, after.uid, after.gid],
      [before.mode, before.uid, before.gid],
    );
    assert.equal(await f.read(mirrors.ubuntuMirrorSource), sourceFor());
    assert.equal(f.handles, 0);
    assert.deepEqual(await fs.readdir(f.physical("/etc/apt")), [
      "apt-mirrors.txt",
      "sources.list.d",
    ]);
  } finally {
    await session?.restore();
    await f.cleanup();
  }
});

test("priority0 and idempotence retain existing canonical priorities and avoid duplicate candidate entries", async () => {
  const f = await fixture();
  let first, second;
  try {
    first = await prepare(f.io, context);
    const prepared = await f.read(main),
      writes = f.actions.filter((a) => a.kind === "write").length;
    second = await prepare(f.io, context);
    assert.equal(second.metadata.state, "unchanged");
    assert.equal(second.metadata.changedCount, 0);
    assert.equal(f.actions.filter((a) => a.kind === "write").length, writes);
    assert.equal(prepared.split(mirrors.ubuntuMirrorCandidate).length, 2);
    assert.ok(prepared.includes("priority:10 arch:amd64"));
    assert.equal((await second.restore()).state, "unchanged");
    assert.equal((await first.restore()).state, "restored");
    assert.equal(await f.read(main), original);
  } finally {
    await second?.restore();
    await first?.restore();
    await f.cleanup();
  }
});

test("Deb822 selection modifies only exact referenced mirror files and leaves unrelated present files untouched", async () => {
  const f = await fixture();
  let session;
  try {
    await fs.writeFile(f.physical(security), "unrelated file", { mode: 0o666 });
    session = await prepare(f.io, context);
    assert.equal(session.metadata.state, "prepared");
    assert.equal(session.metadata.targetCount, 1);
    assert.equal(await f.read(security), "unrelated file");
    assert.ok(!f.actions.some((a) => a.target === security));
    await session.restore();
    assert.equal(await f.read(security), "unrelated file");
  } finally {
    await session?.restore();
    await f.cleanup();
  }
});

for (const edit of [
  { platform: "darwin" },
  { platform: "linux-other" },
  { githubActions: "false" },
  { githubActions: true },
  { runnerEnvironment: "self-hosted" },
  { runnerEnvironment: "github-hosted-other" },
  { uid: 1001 },
  { effectiveUid: 1001 },
  { uid: undefined },
])
  test(
    "mirror admission refuses context before filesystem access: " +
      JSON.stringify(edit),
    async () => {
      const f = await fixture();
      try {
        const session = await prepare(f.io, {
          ...context,
          ...edit,
        });
        assert.ok(
          ["failed", "not-applicable"].includes(session.metadata.state),
        );
        assert.equal(f.actions.length, 0);
        await session.restore();
        assert.equal(f.actions.length, 0);
      } finally {
        await f.cleanup();
      }
    },
  );

for (const layout of [
  sourceFor(["/etc/apt/other-mirrors.txt"]),
  sourceFor().replace("mirror+file:", "mirror+filex:"),
  sourceFor().replace(
    "Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg",
    "Trusted: yes",
  ),
  sourceFor() + "Trusted: yes\n",
  sourceFor().replace(
    "URIs:",
    "URIs: https://archive.ubuntu.com/ubuntu/\nOther:",
  ),
])
  test(
    "source-layout or authentication rejection leaves every config byte intact: " +
      digest(layout).slice(0, 8),
    async () => {
      const f = await fixture([main], layout);
      try {
        const session = await prepare(f.io, context);
        assert.equal(
          session.metadata.state,
          layout.includes("Trusted: yes") ? "failed" : "unsupported",
        );
        assert.equal(session.metadata.changedCount, 0);
        assert.equal(await f.read(main), original);
        assert.equal(await f.read(mirrors.ubuntuMirrorSource), layout);
        assert.ok(
          !f.actions.some((a) => a.kind === "write" || a.kind === "rename"),
        );
        assert.equal(f.handles, 0);
      } finally {
        await f.cleanup();
      }
    },
  );

for (const change of [
  "linked",
  "hardlinked",
  "writable",
  "foreign-owner",
  "oversized",
  "malformed",
  "priority-conflict",
  "absent",
])
  test("mirror validation refuses " + change + " before staging", async () => {
    const f = await fixture();
    try {
      if (change === "linked") {
        await fs.rename(f.physical(main), f.physical(main + "-original"));
        await fs.symlink(f.physical(main + "-original"), f.physical(main));
      }
      if (change === "hardlinked")
        await fs.link(f.physical(main), f.physical(main + "-alias"));
      if (change === "writable") await fs.chmod(f.physical(main), 0o666);
      if (change === "foreign-owner") f.faults.owner = main;
      if (change === "oversized")
        await fs.writeFile(f.physical(main), "x".repeat(65537));
      if (change === "malformed")
        await fs.writeFile(
          f.physical(main),
          "https://archive.ubuntu.com/ubuntu.evil/\n",
        );
      if (change === "priority-conflict")
        await fs.writeFile(
          f.physical(main),
          original + "\nhttps://archive.ubuntu.com/ubuntu/\tpriority:0\n",
        );
      if (change === "absent") await fs.unlink(f.physical(main));
      const session = await prepare(f.io, context);
      assert.ok(["failed", "unsupported"].includes(session.metadata.state));
      assert.equal(session.metadata.changedCount, 0);
      assert.ok(
        !f.actions.some((a) => a.kind === "write" || a.kind === "rename"),
      );
      assert.equal(f.handles, 0);
    } finally {
      await f.cleanup();
    }
  });

test("all referenced targets are validated before any target or staging write", async () => {
  const f = await fixture([main, security]);
  try {
    await fs.chmod(f.physical(main), 0o666);
    const session = await prepare(f.io, context);
    assert.equal(session.metadata.state, "failed");
    assert.ok(
      !f.actions.some((a) => a.kind === "write" || a.kind === "rename"),
    );
    assert.equal(await f.read(main), original);
    assert.equal(await f.read(security), original);
    assert.equal(f.handles, 0);
  } finally {
    await f.cleanup();
  }
});

test("target changes during bounded reading cannot publish a failover list", async () => {
  const f = await fixture();
  let changed = false;
  try {
    f.faults.beforeRead = async (target) => {
      if (target === main && !changed) {
        changed = true;
        await fs.writeFile(
          f.physical(main),
          original + "\n# external update\n",
        );
      }
    };
    const session = await prepare(f.io, context);
    assert.equal(session.metadata.state, "failed");
    assert.equal(session.metadata.changedCount, 0);
    assert.ok(!f.actions.some((a) => a.kind === "rename"));
    assert.ok((await f.read(main)).endsWith("# external update\n"));
    assert.equal(f.handles, 0);
  } finally {
    await f.cleanup();
  }
});

for (const after of [false, true])
  test(
    "multi-target publication failure rolls back every owned change, including ambiguous rename completion: " +
      after,
    async () => {
      const f = await fixture([main, security]);
      try {
        const fault = async (count: number) => {
          if (count === 2)
            throw Error("synthetic private diagnostic must not escape");
        };
        if (after) f.faults.afterRename = fault;
        else f.faults.beforeRename = fault;
        const session = await prepare(f.io, context);
        assert.equal(session.metadata.state, "failed");
        assert.equal(session.metadata.reason, "io-failure");
        assert.equal(await f.read(main), original);
        assert.equal(await f.read(security), original);
        assert.equal(
          await f.read(mirrors.ubuntuMirrorSource),
          sourceFor([main, security]),
        );
        assert.ok(
          !JSON.stringify(session.metadata).includes("private diagnostic"),
        );
        assert.equal(f.handles, 0);
        assert.ok(
          !(await fs.readdir(f.physical("/etc/apt"))).some((name) =>
            name.startsWith(".checktrail-mirrors-"),
          ),
        );
      } finally {
        await f.cleanup();
      }
    },
  );

test("restoration never overwrites an unexpected external edit or reports it clean", async () => {
  const f = await fixture();
  let session;
  try {
    session = await prepare(f.io, context);
    await fs.writeFile(
      f.physical(main),
      "# external operator owns this update\n",
    );
    const result = await session.restore();
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "restoration-incomplete");
    assert.equal(result.restoredCount, 0);
    assert.equal(await f.read(main), "# external operator owns this update\n");
    assert.equal(f.handles, 0);
  } finally {
    await session?.restore();
    await f.cleanup();
  }
});

test("source changes remain untouched while owned mirror changes are restored and cleanup stays failed", async () => {
  const f = await fixture();
  let session;
  try {
    session = await prepare(f.io, context);
    const external = sourceFor() + "# external operator source update\n";
    await fs.writeFile(f.physical(mirrors.ubuntuMirrorSource), external);
    const result = await session.restore();
    assert.equal(result.state, "failed");
    assert.equal(result.restoredCount, 1);
    assert.equal(await f.read(main), original);
    assert.equal(await f.read(mirrors.ubuntuMirrorSource), external);
    assert.equal(f.handles, 0);
  } finally {
    await session?.restore();
    await f.cleanup();
  }
});

test("production catalog admits only the observed stock mirror-list path", async () => {
  const f = await fixture([main, security]);
  try {
    assert.deepEqual(mirrors.ubuntuMirrorTargets, [main]);
    const session = await mirrors.prepareUbuntuMirrorsWithIo(f.io, context);
    assert.equal(session.metadata.state, "unsupported");
    assert.equal(await f.read(main), original);
    assert.equal(await f.read(security), original);
    assert.ok(
      !f.actions.some((a) => a.kind === "write" || a.kind === "rename"),
    );
  } finally {
    await f.cleanup();
  }
});

for (const operation of ["same-byte-rewrite", "timestamp-only"])
  test(
    "restoration refuses an externally changed post-publication identity: " +
      operation,
    async () => {
      const f = await fixture();
      let session;
      try {
        session = await prepare(f.io, context);
        const prepared = await f.read(main);
        if (operation === "same-byte-rewrite")
          await fs.writeFile(f.physical(main), prepared);
        else await fs.utimes(f.physical(main), new Date(1), new Date(2));
        const result = await session.restore();
        assert.equal(result.state, "failed");
        assert.equal(result.restoredCount, 0);
        assert.equal(await f.read(main), prepared);
        assert.equal(f.handles, 0);
      } finally {
        await session?.restore();
        await f.cleanup();
      }
    },
  );

test("abandon releases private staging state without racing a potentially active APT reader", async () => {
  const f = await fixture();
  let session;
  try {
    session = await prepare(f.io, context);
    const prepared = await f.read(main);
    const result = await session.abandon();
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "quiescence-unverified");
    assert.equal(result.restoredCount, 0);
    assert.equal(await f.read(main), prepared);
    assert.equal(f.handles, 0);
    assert.deepEqual(await session.restore(), result);
    assert.ok(
      !(await fs.readdir(f.physical("/etc/apt"))).some((name) =>
        name.startsWith(".checktrail-mirrors-"),
      ),
    );
  } finally {
    await session?.abandon();
    await f.cleanup();
  }
});
