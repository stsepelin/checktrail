import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse } from "yaml";
import ts from "typescript";
import { fixture } from "./helpers.js";
const exec = promisify(execFile),
  root = fileURLToPath(new URL("../../", import.meta.url));
const profileModule = await import(
  new URL(
    "../../scripts/producer-qualification/go-bootstrap-profile.mjs",
    import.meta.url,
  ).href
);
const {
  loadGoBootstrapCatalog,
  validateGoBootstrapCatalog,
  goProfile,
  originalGoStageIds,
  inspectGoPhysicalTree,
  compareGoPaths,
  completeGoChain,
  requireCurrentGoPredecessor,
  requireGoPredecessorUnchanged,
  requireOriginalGoPhase,
  inspectGoImageTools,
} = profileModule;
const {
  originalGoArguments,
  goObserverArguments,
  captureGoSourceFrame,
  goBootstrapSourceFiles,
} = await import(
  new URL("../../scripts/qualify-go-bootstrap-producer.mjs", import.meta.url)
    .href
);
const { downloadGoArchive, acquireGoBootstrapInputs } = await import(
  new URL("../../scripts/acquire-go-bootstrap-inputs.mjs", import.meta.url).href
);
const { observeForeground } = await import(
  new URL("../../scripts/qualify-binutils-producer.mjs", import.meta.url).href
);
const catalog = await loadGoBootstrapCatalog();
const hash = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
interface Row {
  file: string;
  kind: "file" | "directory" | "symlink";
  mode: number;
  uid: number;
  gid: number;
  bytes?: number;
  sha256?: string;
  target?: string;
}
interface Tree {
  schemaVersion: number;
  root: { mode: number; uid: number; gid: number };
  entries: Row[];
}
function tree(files: Record<string, string>): Tree {
  const rows = new Map<string, Row>();
  for (const [file, text] of Object.entries(files)) {
    for (
      let parent = path.posix.dirname(file);
      parent !== ".";
      parent = path.posix.dirname(parent)
    )
      rows.set(parent, {
        file: parent,
        kind: "directory",
        mode: 0o755,
        uid: 1001,
        gid: 1001,
      });
    rows.set(file, {
      file,
      kind: "file",
      mode:
        file.startsWith("bin/") || file.startsWith("pkg/tool/") ? 0o755 : 0o644,
      uid: 1001,
      gid: 1001,
      bytes: Buffer.byteLength(text),
      sha256: hash(text),
    });
  }
  return {
    schemaVersion: 1,
    root: { mode: 0o755, uid: 1001, gid: 1001 },
    entries: [...rows.values()].sort((a, b) => compareGoPaths(a.file, b.file)),
  };
}
function syntheticStageTrees(id: string) {
  const files: Record<string, string> = {
    VERSION: "Original synthetic VERSION " + id,
    "src/policy.go": "Original synthetic source bytes",
  };
  const before = tree(files);
  const tools =
    id === "supported-c-bootstrap"
      ? [
          "bin/go",
          "bin/gofmt",
          "pkg/tool/linux_amd64/6g",
          "pkg/tool/linux_amd64/6c",
          "pkg/tool/linux_amd64/6l",
          "pkg/tool/linux_amd64/6a",
        ]
      : [
          "bin/go",
          "bin/gofmt",
          "pkg/tool/linux_amd64/compile",
          "pkg/tool/linux_amd64/link",
          "pkg/tool/linux_amd64/asm",
        ];
  for (const file of tools)
    files[file] = "Original synthetic artifact " + id + " " + file;
  return { before, sdk: tree(files) };
}
function syntheticChain(api = profileModule, fixtureCatalog = catalog) {
  const { goProfile, requireCurrentGoPredecessor, completeGoStage } = api;
  const completed = new Map();
  const source = "a".repeat(64),
    chainAttempt = randomUUID(),
    rows = [];
  for (const id of originalGoStageIds) {
    const profile = goProfile(fixtureCatalog, id),
      { before, sdk } = syntheticStageTrees(id),
      parent = requireCurrentGoPredecessor(
        profile,
        completed,
        source,
        chainAttempt,
      );
    const phases = profile.originalCommands.map(
      (command: { phase: string }) => ({
        phase: command.phase,
        attempt: randomUUID(),
        command,
        originalAssertionsSatisfied: true,
        ownedContainerAbsent: true,
        terminal: { exitCode: 0, signal: null, reason: null, stopError: null },
        raw: { bytes: 17, sha256: "b".repeat(64) },
      }),
    );
    const row = completeGoStage({
      profile,
      attempt: randomUUID(),
      sourceFrameSha256: source,
      chainAttempt,
      phases,
      before,
      sdkTree: sdk,
      predecessor: parent,
    });
    completed.set(id, row);
    rows.push(row);
  }
  return { rows, source, completed, chainAttempt };
}
test("Go source catalog freezes eight original stages thirty commands and exact per-call policies without release distpack substitution", () => {
  assert.equal(catalog.profiles.length, 8);
  assert.equal(
    catalog.profiles.reduce(
      (n: number, p: { originalCommands: unknown[] }) =>
        n + p.originalCommands.length,
      0,
    ),
    30,
  );
  const first = goProfile(catalog, "supported-c-bootstrap");
  assert.deepEqual(
    first.originalCommands.map(
      (row: { timeoutSeconds: number }) => row.timeoutSeconds,
    ),
    [3600, 60],
  );
  assert.equal(first.environment.GOMAXPROCS, "2");
  assert.equal(first.limits.memoryBytes, 6 * 1024 ** 3);
  for (const id of originalGoStageIds.slice(1)) {
    const p = goProfile(catalog, id);
    assert.deepEqual(
      p.originalCommands.map(
        (row: { timeoutSeconds: number }) => row.timeoutSeconds,
      ),
      [7200, 7200, 7200, 7200],
    );
    assert.equal(p.environment.GOMAXPROCS, "4");
    assert.equal(p.environment.CGO_ENABLED, "0");
    assert.equal(p.environment.GOSUMDB, "sum.golang.org");
    assert.equal(p.limits.cpus, 4);
    assert.equal(p.limits.memoryBytes, 8 * 1024 ** 3);
    assert.equal(p.limits.pidsLimit, 512);
  }
  assert.equal(catalog.observationLimits.workBytes, 16 * 1024 ** 3);
  assert.equal(catalog.theoreticalSumOriginalCommandTimeoutSeconds, 205260);
  assert.equal(catalog.observationLimits.observationSeconds, 270 * 60);
  assert.equal(catalog.observationLimits.hostedJobMinutes, 360);
  for (const change of [
    "stage",
    "argv",
    "env",
    "ram",
    "cpu",
    "pid",
    "timeout",
    "predecessor",
    "closure",
  ]) {
    const c = structuredClone(catalog),
      p = c.profiles[1];
    if (change === "stage") c.profiles.pop();
    else if (change === "argv") p.originalCommands[1].argv.push("-distpack");
    else if (change === "env") p.environment.CGO_ENABLED = "";
    else if (change === "ram") p.limits.memoryBytes++;
    else if (change === "cpu") p.limits.cpus++;
    else if (change === "pid") p.limits.pidsLimit++;
    else if (change === "timeout") p.originalCommands[2].timeoutSeconds = 60;
    else if (change === "predecessor") p.predecessor.stage = "go1.17.2";
    else c.gateAComplete = true;
    assert.throws(
      () => validateGoBootstrapCatalog(c),
      /closed original/,
      change,
    );
  }
  assert.ok(
    !JSON.stringify(catalog).includes("/private/") &&
      !JSON.stringify(catalog).includes("/Users/"),
  );
});
test("Go original vectors preserve fixed bash argv environment resource limits and readonly current predecessors while rejecting modified profiles", () => {
  for (const id of originalGoStageIds) {
    const p = goProfile(catalog, id);
    for (const phase of p.originalCommands) {
      const ctx = {
        attempt: randomUUID(),
        cid: "/synthetic/owned/cid",
        stageWork: "/synthetic/owned/work",
        predecessorRoot: p.predecessor ? "/synthetic/current-parent/go" : null,
        image: p.image,
      };
      const args = originalGoArguments(p, phase, ctx);
      assert.deepEqual(args.slice(args.indexOf(p.image) + 1), phase.argv);
      assert.equal(args[args.indexOf("--workdir") + 1], phase.cwd);
      assert.equal(args[args.indexOf("--cpus") + 1], "4");
      assert.equal(
        args[args.indexOf("--memory") + 1],
        String(p.limits.memoryBytes),
      );
      assert.equal(args[args.indexOf("--pids-limit") + 1], "512");
      assert.equal(args[args.indexOf("--network") + 1], "none");
      for (const [key, value] of Object.entries(p.environment))
        assert.ok(args.includes(key + "=" + value));
      assert.equal(
        args.some((value: string) =>
          value.endsWith("target=/bootstrap,readonly"),
        ),
        Boolean(p.predecessor),
      );
      const changed = structuredClone(p);
      changed.originalCommands[0].argv.push("synthetic-extra");
      assert.throws(
        () => originalGoArguments(changed, changed.originalCommands[0], ctx),
        /closed original profile/,
      );
    }
  }
  const p = goProfile(catalog, "go1.24.13"),
    args = goObserverArguments(p, "observe", {
      attempt: randomUUID(),
      cid: "/synthetic/cid",
      stageWork: "/synthetic/work",
      predecessorRoot: "/synthetic/current/go",
      destination: "/synthetic/destination",
    });
  assert.ok(
    args.includes("--read-only") && args.includes("--cap-add=DAC_READ_SEARCH"),
  );
  assert.ok(
    args.some((value: string) =>
      value.endsWith("target=/observed/bootstrap,readonly"),
    ),
  );
  assert.throws(() => goObserverArguments(p, "execute-model-command", {}));
});
test("Go original output assertions keep VERSION timestamp metadata separate and refuse failed terminal stderr contamination and altered SDK configuration", () => {
  for (const id of originalGoStageIds) {
    const p = goProfile(catalog, id),
      version = p.id === "supported-c-bootstrap" ? p.internalVersionFile : p.id;
    for (const command of p.originalCommands) {
      const good =
        command.phase === "bootstrap-preflight"
          ? "go version " + p.predecessor.version + " linux/amd64\n"
          : command.phase === "built-version"
            ? "go version " + version + " linux/amd64\n"
            : command.phase === "built-sdk-config"
              ? JSON.stringify({
                  GOROOT: "/work/go",
                  GOHOSTARCH: "amd64",
                  GOARCH: "amd64",
                  GOHOSTOS: "linux",
                  GOOS: "linux",
                  CGO_ENABLED: "0",
                  GOVERSION: version,
                })
              : "Original synthetic build output";
      const result = {
        exitCode: 0,
        signal: null,
        reason: null,
        stopError: null,
      };
      requireOriginalGoPhase(p, command, result, good);
      assert.throws(
        () =>
          requireOriginalGoPhase(p, command, { ...result, exitCode: 7 }, good),
        /did not complete/,
      );
      if (command.phase === "built-version")
        assert.throws(
          () =>
            requireOriginalGoPhase(
              p,
              command,
              result,
              good + "Original synthetic stderr",
            ),
          /built-version/,
        );
      if (command.phase === "built-sdk-config")
        assert.throws(
          () =>
            requireOriginalGoPhase(
              p,
              command,
              result,
              good.replace('"amd64"', '"arm64"'),
            ),
          /configuration/,
        );
    }
  }
});
test("Go physical SDK seals bind all files modes ownership links and Python lexical legacy bytes with strict source preservation", () => {
  const { before, sdk } = syntheticStageTrees("go1.24.13"),
    base = inspectGoPhysicalTree(sdk);
  const mode = structuredClone(sdk);
  mode.entries.find((row) => row.file === "bin/go")!.mode = 0o700;
  assert.notEqual(
    inspectGoPhysicalTree(mode).fullManifestSha256,
    base.fullManifestSha256,
  );
  assert.equal(
    inspectGoPhysicalTree(mode).regularManifestSha256,
    base.regularManifestSha256,
  );
  const link: Row = {
    file: "alias",
    kind: "symlink",
    mode: 0o777,
    uid: 1001,
    gid: 1001,
    target: "VERSION",
    bytes: 7,
    sha256: hash("VERSION"),
  };
  const linked = structuredClone(sdk);
  linked.entries.push(link);
  linked.entries.sort((a, b) => compareGoPaths(a.file, b.file));
  assert.equal(inspectGoPhysicalTree(linked).symlinks, 1);
  for (const change of [
    "duplicate",
    "order",
    "path",
    "parent",
    "link",
    "size",
    "owner",
  ]) {
    const altered = structuredClone(sdk);
    if (change === "duplicate")
      altered.entries.push({ ...altered.entries[0]! });
    else if (change === "order") altered.entries.reverse();
    else if (change === "path") altered.entries[0]!.file = "../outside";
    else if (change === "parent")
      altered.entries = altered.entries.filter((row) => row.file !== "bin");
    else if (change === "link") {
      altered.entries.push({
        ...link,
        target: "../outside",
        bytes: 10,
        sha256: hash("../outside"),
      });
      altered.entries.sort((a, b) => compareGoPaths(a.file, b.file));
    } else if (change === "size")
      altered.entries.find((row) => row.kind === "file")!.bytes =
        512 * 1024 ** 2 + 1;
    else altered.root.uid = -1;
    assert.throws(
      () => inspectGoPhysicalTree(altered),
      { name: "AssertionError" },
      change,
    );
  }
  profileModule.requireGoSourceUnchanged(before, sdk);
  const changed = structuredClone(sdk);
  changed.entries.find((row) => row.file === "src/policy.go")!.sha256 =
    "f".repeat(64);
  assert.throws(
    () => profileModule.requireGoSourceUnchanged(before, changed),
    /source bytes changed/,
  );
});
test("Go current ancestry accepts separately recorded historical mismatches and shared current parents while requiring every original leaf and command", () => {
  const { rows, source, chainAttempt } = syntheticChain(),
    summary = completeGoChain(rows, source, chainAttempt);
  assert.equal(summary.freshNativeUpstreamSourceAncestryComplete, true);
  assert.equal(summary.exactHistoricalPrivateInputReplay, false);
  assert.equal(summary.originalStages, 8);
  assert.equal(summary.originalCommands, 30);
  assert.equal(summary.gateAComplete, false);
  assert.equal(summary.fullCompilerSdkBootstrapClosureVerified, false);
  assert.equal(rows[1].predecessor.stage, rows[2].predecessor.stage);
  assert.equal(rows[6].predecessor.stage, rows[7].predecessor.stage);
  assert.equal(
    rows[1].predecessor.historicalRegularManifestComparison,
    "differs",
  );
  for (const change of [
    "leaf",
    "phase",
    "duplicate-attempt",
    "foreign-frame",
    "claim",
    "source",
    "historical-replay-claim",
  ]) {
    const bad = structuredClone(rows);
    if (change === "leaf") bad.splice(1, 1);
    else if (change === "phase") bad[4].phases.pop();
    else if (change === "duplicate-attempt")
      bad[2].phases[0].attempt = bad[1].phases[0].attempt;
    else if (change === "foreign-frame")
      bad[3].sourceFrameSha256 = "e".repeat(64);
    else if (change === "claim") bad[7].gateAComplete = true;
    else if (change === "historical-replay-claim")
      bad[0].exactHistoricalPrivateInputReplay = true;
    else
      bad[5].sdkTree.entries.find((row: Row) => row.file === "VERSION").sha256 =
        "e".repeat(64);
    assert.throws(
      () => completeGoChain(bad, source, chainAttempt),
      { name: "AssertionError" },
      change,
    );
  }
});
test("Go child authority refuses absent failed foreign or changed current SDK seals without falling back to a historical or prebuilt SDK", () => {
  const { rows, source, completed, chainAttempt } = syntheticChain(),
    p = goProfile(catalog, "go1.20.14"),
    binding = requireCurrentGoPredecessor(p, completed, source, chainAttempt);
  assert.equal(binding.attempt, rows[2].attempt);
  assert.throws(
    () => requireCurrentGoPredecessor(p, new Map(), source, chainAttempt),
    /did not complete/,
  );
  for (const change of ["failed", "frame", "mode", "bytes"]) {
    const parent = structuredClone(rows[2]);
    if (change === "failed")
      parent.freshNativeUpstreamSourceAncestryComplete = false;
    else if (change === "frame") parent.sourceFrameSha256 = "d".repeat(64);
    else if (change === "mode")
      parent.sdkTree.entries.find((row: Row) => row.file === "bin/go").mode =
        0o700;
    else
      parent.sdkTree.entries.find((row: Row) => row.file === "bin/go").sha256 =
        "d".repeat(64);
    assert.throws(
      () =>
        requireCurrentGoPredecessor(
          p,
          new Map([[p.predecessor.stage, parent]]),
          source,
          chainAttempt,
        ),
      { name: "AssertionError" },
      change,
    );
  }
  assert.throws(
    () => requireCurrentGoPredecessor(p, completed, source, randomUUID()),
    /previous source-chain attempt/,
  );
  const modified = structuredClone(rows[2].sdkTree);
  modified.entries.find((row: Row) => row.file === "bin/go").mode = 0o700;
  assert.throws(
    () => requireGoPredecessorUnchanged(binding, modified),
    /changed before or after/,
  );
  requireGoPredecessorUnchanged(binding, rows[2].sdkTree);
});
test("Go SDK Python observation independently matches complete and historical byte serializers including Unicode path and contained-link metadata", async (t) => {
  const directory = await realpath(
    await fixture(t, {
      "sdk/VERSION": "Original synthetic VERSION",
      "sdk/a.z": "Original synthetic root file",
      "sdk/a/run": "Original synthetic executable",
      "sdk/z/é": "Original synthetic unicode",
      "sdk/z/😀": "Original synthetic astral",
    }),
  );
  const program = `import sys,json,hashlib,importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)\ntree=w.physical_tree(Path(sys.argv[2]));regular=[{'file':r['file'],'bytes':r['bytes'],'sha256':r['sha256']}for r in tree['entries']if r['kind']=='file']\nprint(json.dumps({'tree':tree,'legacy':hashlib.sha256((json.dumps(regular,indent=2)+'\\n').encode()).hexdigest(),'full':hashlib.sha256((json.dumps(tree,separators=(',',':'))+'\\n').encode()).hexdigest()}))`;
  const { stdout } = await exec(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      path.join(root, "scripts/producer-qualification/go-bootstrap-worker.py"),
      path.join(directory, "sdk"),
    ],
    { timeout: 20000, maxBuffer: 1024 ** 2 },
  );
  const value = JSON.parse(stdout),
    observed = inspectGoPhysicalTree(value.tree);
  assert.equal(observed.regularManifestSha256, value.legacy);
  assert.equal(observed.fullManifestSha256, value.full);
  assert.equal(observed.regularFiles, 5);
});
test("Go cold extraction validates all archive targets before writes and refuses traversal duplicates hardlinks linked parents and actual byte-bound changes", async (t) => {
  const directory = await realpath(await fixture(t, {}));
  const program = `import sys,json,io,tarfile,importlib.util\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('worker',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w);base=Path(sys.argv[2])\ndef archive(name,rows):\n file=base/(name+'.tar.gz')\n with tarfile.open(file,'w:gz')as out:\n  for path,kind,text in rows:\n   info=tarfile.TarInfo(path);info.mtime=1700000000;info.mode=0o750 if path.endswith('run')else 0o640\n   if kind=='link':info.type=tarfile.SYMTYPE;info.linkname=text;out.addfile(info)\n   elif kind=='hard':info.type=tarfile.LNKTYPE;info.linkname=text;out.addfile(info)\n   else:raw=text.encode();info.size=len(raw);out.addfile(info,io.BytesIO(raw))\n return file\nvalid=archive('valid',[('go/VERSION','file','Original synthetic version'),('go/src/run','file','Original synthetic bytes'),('go/alias','link','VERSION')]);tree=w.extract_source(valid,base/'valid');assert any(r['kind']=='symlink'and r['target']=='VERSION'for r in tree['entries']);assert (base/'valid/src/run').stat().st_mode&0o777==0o755;assert (base/'valid/src/run').stat().st_mtime==1700000000\ncases=[('escape',[('go/../escape','file','x')]),('absolute',[('/go/escape','file','x')]),('duplicate',[('go/a','file','x'),('go/a','file','y')]),('parent-file',[('go/a','file','x'),('go/a/b','file','y')]),('parent-link',[('go/a','link','b'),('go/a/b','file','x')]),('outside-link',[('go/a','link','../escape')]),('hardlink',[('go/a','hard','go/VERSION')])]\nrefused=[]\nfor name,rows in cases:\n target=base/name\n try:w.extract_source(archive(name,rows),target)\n except ValueError:refused.append(name)\n else:raise AssertionError('archive guard admitted '+name)\n assert not target.exists()\nprobe=base/'bounded';probe.write_bytes(b'123456789')\ntry:w.file_identity(probe,8)\nexcept ValueError:pass\nelse:raise AssertionError('actual file byte bound did not fire')\ntry:w.physical_tree(base/'valid')\nexcept Exception:raise\nprint(json.dumps({'refused':refused,'containedLinkRecordedWithoutFollowing':True,'coldNamespaceRequired':True,'nativeExecuted':False}))`;
  const { stdout } = await exec(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      path.join(root, "scripts/producer-qualification/go-bootstrap-worker.py"),
      directory,
    ],
    { timeout: 20000, maxBuffer: 1024 ** 2 },
  );
  const value = JSON.parse(stdout);
  assert.deepEqual(value.refused, [
    "escape",
    "absolute",
    "duplicate",
    "parent-file",
    "parent-link",
    "outside-link",
    "hardlink",
  ]);
  assert.equal(value.containedLinkRecordedWithoutFollowing, true);
  assert.equal(value.nativeExecuted, false);
});
test("Go original assertions follow actual failed bounded physical output capture and storage refusal prevents child admission", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    file = path.join(directory, "failed.log"),
    signal = new AbortController();
  let stops = 0;
  const stdout = "Original synthetic failed stdout\n",
    stderr = "Original synthetic failed stderr\n";
  const result = await observeForeground(
    () =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=7`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    file,
    {
      timeoutMs: 10000,
      maxBytes: 4096,
      signal: signal.signal,
      stop: async () => {
        stops++;
      },
    },
  );
  assert.equal(result.exitCode, 7);
  assert.equal(result.reason, null);
  assert.equal(stops, 0);
  const raw = await readFile(file);
  assert.equal(raw.length, Buffer.byteLength(stdout + stderr));
  assert.ok(raw.toString().includes(stdout) && raw.toString().includes(stderr));
  const p = goProfile(catalog, "supported-c-bootstrap"),
    phase = p.originalCommands[0];
  assert.throws(
    () => requireOriginalGoPhase(p, phase, result, raw.toString()),
    /did not complete/,
  );
  assert.deepEqual(await readFile(file), raw);
  let started = 0;
  await assert.rejects(
    observeForeground(
      () => {
        started++;
        throw Error("must not start");
      },
      file,
      {
        timeoutMs: 100,
        maxBytes: 8,
        signal: signal.signal,
        stop: async () => {},
      },
    ),
    /EEXIST/,
  );
  assert.equal(started, 0);
  const limited = await observeForeground(
    () =>
      spawn(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(4096))"],
        { stdio: ["ignore", "pipe", "pipe"] },
      ),
    path.join(directory, "limited.log"),
    {
      timeoutMs: 10000,
      maxBytes: 8,
      signal: signal.signal,
      stop: async () => {
        stops++;
      },
    },
  );
  assert.equal(limited.reason, "output-limit");
  assert.equal((await readFile(path.join(directory, "limited.log"))).length, 8);
  assert.throws(
    () => requireOriginalGoPhase(p, phase, limited, ""),
    /did not complete/,
  );
});
test("Go archive acquisition is data-only bounded and exact with closed redirects and no finalized artifact on mismatched bytes", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    payload = Buffer.from("Original synthetic archive bytes"),
    row = {
      file: "go1.17.2.src.tar.gz",
      url: "https://go.dev/dl/go1.17.2.src.tar.gz",
      bytes: payload.length,
      sha256: hash(payload),
    },
    calls: string[] = [];
  const good = await downloadGoArchive(row, directory, async (url: string) => {
    calls.push(url);
    return calls.length === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://dl.google.com/go/" + row.file },
        })
      : new Response(payload, {
          status: 200,
          headers: { "content-length": String(payload.length) },
        });
  });
  assert.equal(good.sha256, row.sha256);
  assert.deepEqual(calls, [row.url, "https://dl.google.com/go/" + row.file]);
  assert.deepEqual(await readFile(path.join(directory, row.file)), payload);
  await assert.rejects(
    lstat(path.join(directory, row.file + ".partial")),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  for (const mode of [
    "hash",
    "large",
    "truncated",
    "foreign-redirect",
    "encoding",
  ]) {
    const target = path.join(directory, mode);
    await mkdir(target);
    const altered = {
      ...row,
      sha256: mode === "hash" ? "f".repeat(64) : row.sha256,
    };
    let fetched = 0;
    await assert.rejects(
      downloadGoArchive(altered, target, async () => {
        fetched++;
        if (mode === "foreign-redirect")
          return new Response(null, {
            status: 302,
            headers: { location: "https://example.invalid/secret" },
          });
        return new Response(
          mode === "large"
            ? Buffer.concat([payload, Buffer.from("x")])
            : mode === "truncated"
              ? payload.subarray(1)
              : payload,
          {
            status: 200,
            headers: mode === "encoding" ? { "content-encoding": "gzip" } : {},
          },
        );
      }),
    );
    await assert.rejects(
      lstat(path.join(target, row.file)),
      (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.equal(fetched, 1);
  }
});
test("Go source startup binds committed bytes without invoking actually armed repository monitors or clean filters", async (t) => {
  const directory = await realpath(await fixture(t, {}));
  for (const file of goBootstrapSourceFiles) {
    const target = path.join(directory, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(root, file), target);
  }
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (args: string[]) =>
    exec("git", args, {
      cwd: directory,
      env,
      timeout: 10000,
      maxBuffer: 1024 ** 2,
    });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git([
    "-c",
    "user.name=Synthetic",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--no-gpg-sign",
    "-qm",
    "Original synthetic source fixture",
  ]);
  const monitor = path.join(directory, ".git/synthetic-fsmonitor"),
    marker = path.join(directory, ".git/synthetic-monitor-armed");
  await writeFile(
    monitor,
    "#!/bin/sh\nprintf armed > .git/synthetic-monitor-armed\nprintf 'token\\0'\n",
    { mode: 0o700 },
  );
  await git(["config", "core.fsmonitor", monitor]);
  await git(["config", "core.fsmonitorHookVersion", "2"]);
  await git(["status", "--porcelain=v1"]);
  assert.equal(
    await readFile(marker, "utf8"),
    "armed",
    "Fixture filesystem monitor did not actually arm",
  );
  await rm(marker);
  const frame = await captureGoSourceFrame(directory);
  assert.equal(frame.committedControllerSourcesMatch, true);
  assert.equal(frame.wholeCheckoutCleanlinessAssessed, false);
  assert.equal(frame.files.length, goBootstrapSourceFiles.length);
  await assert.rejects(
    lstat(marker),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  const filter = path.join(directory, ".git/synthetic-clean-filter"),
    filterMarker = path.join(directory, ".git/synthetic-filter-armed");
  await writeFile(
    filter,
    "#!/bin/sh\nprintf armed > " +
      "'" +
      filterMarker.replaceAll("'", "'\\''") +
      "'" +
      "\ncat\n",
    { mode: 0o700 },
  );
  await writeFile(
    path.join(directory, ".gitattributes"),
    "package.json filter=synthetic\n",
  );
  await git(["config", "filter.synthetic.clean", filter]);
  await git(["config", "filter.synthetic.required", "true"]);
  const packageFile = path.join(directory, "package.json"),
    packageOriginal = await readFile(packageFile);
  await writeFile(
    packageFile,
    Buffer.concat([packageOriginal, Buffer.from(" ")]),
  );
  await git([
    "-c",
    "core.fsmonitor=false",
    "hash-object",
    "--path=package.json",
    "package.json",
  ]);
  assert.equal(
    await readFile(filterMarker, "utf8"),
    "armed",
    "Fixture clean filter did not actually arm",
  );
  await rm(filterMarker);
  const altered = await captureGoSourceFrame(directory);
  assert.equal(altered.committedControllerSourcesMatch, false);
  await assert.rejects(
    lstat(filterMarker),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
  await writeFile(packageFile, packageOriginal);
  assert.equal(
    (await captureGoSourceFrame(directory)).committedControllerSourcesMatch,
    true,
  );
});
test("Go hosted carrier has fixed operator scope cleanup export and a separate observation cutoff without SDK tree uploads or MCP execution registration", async () => {
  const workflow = parse(
    await readFile(
      path.join(root, ".github/workflows/upstream-go-bootstrap.yml"),
      "utf8",
    ),
  );
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.ok(workflow.on.workflow_dispatch === null);
  assert.deepEqual(workflow.on.push.branches, [
    "pr/upstream-producer/go-bootstrap-*",
  ]);
  const job = workflow.jobs["original-go-bootstrap-observation"];
  assert.equal(job["runs-on"], "ubuntu-24.04");
  assert.equal(job["timeout-minutes"], 360);
  const runs = job.steps.map((step: { run?: string }) => step.run ?? "");
  const startup = runs.findIndex((text: string) =>
      text.includes("--capture-startup"),
    ),
    acquire = runs.findIndex((text: string) =>
      text.includes("acquire-go-bootstrap-inputs"),
    ),
    native = runs.findIndex((text: string) => text.includes("--run"));
  assert.ok(startup >= 0 && acquire > startup && native > acquire);
  const delivery = runs.find((text: string) => text.includes("docker pull"));
  assert.equal(
    delivery,
    "docker pull --platform linux/amd64 " + catalog.profiles[0].image,
  );
  const upload = job.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(upload.if, "always()");
  assert.ok(upload.with.path.includes("work/evidence/*"));
  assert.ok(!upload.with.path.includes("work/stages"));
  assert.equal(upload.with["retention-days"], 1);
  const toolRows = [
    ["bash", "/bin/bash"],
    ["gcc", "/usr/bin/gcc"],
    ["as", "/usr/bin/as"],
    ["ld", "/usr/bin/ld"],
    ["python3", "/usr/bin/python3"],
    ["cc1", "/usr/lib/gcc/x86_64-linux-gnu/12/cc1"],
    ["collect2", "/usr/lib/gcc/x86_64-linux-gnu/12/collect2"],
    ["loader", "/lib64/ld-linux-x86-64.so.2"],
  ].map(([role, invocation]) => ({
    role,
    invocation,
    canonicalPath: invocation,
    mode: 0o755,
    bytes: 17,
    sha256: "c".repeat(64),
  }));
  inspectGoImageTools(toolRows);
  assert.throws(
    () => inspectGoImageTools(toolRows.slice(1)),
    /bindings are missing or foreign/,
  );
  const result = await exec(
    process.execPath,
    [
      path.join(root, "scripts/qualify-go-bootstrap-producer.mjs"),
      "--command",
      "synthetic-unapproved",
    ],
    { cwd: root, timeout: 10000 },
  ).then(
    () => ({ code: 0, stderr: "" }),
    (error) => ({ code: error.code, stderr: String(error.stderr) }),
  );
  assert.equal(result.code, 2);
  assert.match(result.stderr, /arbitrary execution arguments are unavailable/);
});

test("Go source-chain caller passes the current attempt and retains the closed pre-start transport wiring", async () => {
  const raw = await readFile(
    path.join(root, "scripts/qualify-go-bootstrap-producer.mjs"),
    "utf8",
  );
  const source = ts.createSourceFile(
    "go-controller.mjs",
    raw,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "requireCurrentGoPredecessor"
    )
      calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0]!.arguments.map((arg) => arg.getText(source)),
    ["profile", "completed", "source.sha256", "chainAttempt"],
  );
  assert.ok(
    goBootstrapSourceFiles.includes(
      "scripts/producer-qualification/go-bootstrap-transport.mjs",
    ),
  );
  for (const helperFile of goBootstrapSourceFiles.filter((file: string) =>
    file.endsWith(".mjs"),
  )) {
    const helper = ts.createSourceFile(
      helperFile,
      await readFile(path.join(root, helperFile), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of helper.statements) {
      if (
        !(
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ) ||
        !statement.moduleSpecifier ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      )
        continue;
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith(".")) continue;
      const target = path.posix.normalize(
        path.posix.join(path.posix.dirname(helperFile), specifier),
      );
      assert.ok(
        goBootstrapSourceFiles.includes(target),
        "Unbound actual controller helper import: " +
          helperFile +
          " -> " +
          target,
      );
    }
  }
});

test("Go independent read-only retention observes the actual leaf boundary across cache roots and preserves link refusal", async (t) => {
  const directory = await realpath(await fixture(t, {}));
  const program = `import sys,json,importlib.util
from pathlib import Path
spec=importlib.util.spec_from_file_location('observer',sys.argv[1]);w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w);base=Path(sys.argv[2]);roots=[base/name for name in ['bundle','controls','work']]
for root in roots:root.mkdir()
cache=roots[2]/'cache';cache.mkdir();file=cache/'large-cache-entry'
with file.open('wb')as handle:handle.truncate(w.MAX_LEAF_BYTES)
value=w.count_roots(roots);assert value['bytes']==512*1024**2 and value['files']==1
with file.open('r+b')as handle:handle.truncate(w.MAX_LEAF_BYTES+1)
try:w.count_roots(roots)
except ValueError as error:assert 'regular-leaf bound'in str(error)
else:raise AssertionError('actual oversized cache file was admitted')
file.unlink();(cache/'linked').symlink_to('../..')
try:w.count_roots(roots)
except ValueError as error:assert 'linked or nonregular'in str(error)
else:raise AssertionError('retention link guard was lost')
print(json.dumps({'boundaryBytes':512*1024**2,'oversizedCacheRefused':True,'linkRefused':True,'nativeExecuted':False}))`;
  const { stdout } = await exec(
    "python3",
    [
      "-I",
      "-S",
      "-B",
      "-c",
      program,
      path.join(
        root,
        "scripts/producer-qualification/go-bootstrap-retention-observer.py",
      ),
      directory,
    ],
    { timeout: 10000, maxBuffer: 1024 ** 2 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    boundaryBytes: 512 * 1024 ** 2,
    oversizedCacheRefused: true,
    linkRefused: true,
    nativeExecuted: false,
  });
});

test("Go bootstrap preflight requires the complete selected version line and rejects adjacent conflicting or irrelevant output", () => {
  const terminal = { exitCode: 0, signal: null, reason: null, stopError: null };
  for (const id of originalGoStageIds.slice(1)) {
    const profile = goProfile(catalog, id),
      phase = profile.originalCommands[0];
    assert.equal(phase.phase, "bootstrap-preflight");
    // The original bash -c preflight is not traced and invokes exactly go version.
    const line = "go version " + profile.predecessor.version + " linux/amd64";
    requireOriginalGoPhase(profile, phase, terminal, line + "\n");
    for (const output of [
      "go version " + profile.predecessor.version + "0 linux/amd64\n",
      "go version synthetic-adjacent linux/amd64\n" + line + "\n",
      line + "\ngo version synthetic-conflicting linux/amd64\n",
      "irrelevant diagnostic mentions " + profile.predecessor.version + "\n",
      "go version " + profile.predecessor.version + " darwin/arm64\n",
      line + "\n" + line + "\n",
      "",
      line,
      "\n" + line + "\n",
      "go version synthetic-other linux/amd64\n",
    ])
      assert.throws(
        () => requireOriginalGoPhase(profile, phase, terminal, output),
        /bootstrap version check failed/,
      );
  }
});

test("Go hosted carrier declared setup observation cleanup and export bounds fit its job ceiling", async () => {
  const workflow = parse(
    await readFile(
      path.join(root, ".github/workflows/upstream-go-bootstrap.yml"),
      "utf8",
    ),
  );
  const job = workflow.jobs["original-go-bootstrap-observation"];
  const declared = job.steps.map(
    (step: { "timeout-minutes": number }) => step["timeout-minutes"],
  );
  assert.ok(
    declared.every(
      (minutes: number) => Number.isSafeInteger(minutes) && minutes > 0,
    ),
  );
  const total = declared.reduce(
    (sum: number, minutes: number) => sum + minutes,
    0,
  );
  assert.equal(total, 355, "Declared carrier steps must total 355 minutes");
  assert.deepEqual(
    declared,
    Object.values(catalog.observationLimits.hostedStepMinutes),
  );
  assert.equal(catalog.observationLimits.hostedJobSlackMinutes, 5);
  assert.equal(catalog.observationLimits.hostedCleanupReserveMinutes, 5);
  assert.ok(
    total <=
      job["timeout-minutes"] - catalog.observationLimits.hostedJobSlackMinutes,
    "Declared carrier steps must leave a five-minute job margin",
  );
  const native = job.steps.find((step: { run?: string }) =>
    step.run?.includes("--run"),
  );
  assert.ok(
    catalog.observationLimits.observationSeconds / 60 +
      catalog.observationLimits.hostedCleanupReserveMinutes <=
      native["timeout-minutes"],
    "Native step must reserve five minutes after its startup observation window",
  );
});

test("Go archive exclusive publication preserves a real target that appears after the ENOENT check", async (t) => {
  const parent = await realpath(await fixture(t, {}));
  for (const kind of ["file", "symlink", "directory"]) {
    const directory = path.join(parent, kind);
    await mkdir(directory);
    const payload = Buffer.from("Original synthetic downloaded archive"),
      incumbent = Buffer.from("Original synthetic incumbent must survive");
    const row = {
      file: "go1.17.2.src.tar.gz",
      url: "https://go.dev/dl/go1.17.2.src.tar.gz",
      bytes: payload.length,
      sha256: hash(payload),
    };
    const target = path.join(directory, row.file),
      sentinel = path.join(directory, "original-target"),
      originalLstat = fs.promises.lstat;
    await writeFile(sentinel, incumbent);
    const descriptor = Object.getOwnPropertyDescriptor(fs.promises, "lstat");
    assert.ok(descriptor);
    let inserted = false;
    const outcome = await (async () => {
      try {
        // Preserve the real syscall result, while another real writer wins publication.
        Object.defineProperty(fs.promises, "lstat", {
          ...descriptor,
          value: async (...args: Parameters<typeof originalLstat>) => {
            try {
              return await Reflect.apply(originalLstat, fs.promises, args);
            } catch (error) {
              if (
                args[0] === target &&
                !inserted &&
                (error as NodeJS.ErrnoException).code === "ENOENT"
              ) {
                inserted = true;
                if (kind === "file")
                  await writeFile(target, incumbent, {
                    flag: "wx",
                    mode: 0o600,
                  });
                else if (kind === "symlink")
                  await symlink("original-target", target);
                else {
                  await mkdir(target);
                  await writeFile(path.join(target, "sentinel"), incumbent);
                }
              }
              throw error;
            }
          },
        });
        syncBuiltinESMExports();
        return await downloadGoArchive(
          row,
          directory,
          async () =>
            new Response(payload, {
              status: 200,
              headers: { "content-length": String(payload.length) },
            }),
        ).then(
          () => ({ published: true, error: null }),
          (error: NodeJS.ErrnoException) => ({ published: false, error }),
        );
      } finally {
        Object.defineProperty(fs.promises, "lstat", descriptor);
        syncBuiltinESMExports();
      }
    })();
    assert.equal(inserted, true, "Real ENOENT race fixture did not arm");
    if (kind === "directory") {
      assert.equal((await lstat(target)).isDirectory(), true);
      assert.deepEqual(
        await readFile(path.join(target, "sentinel")),
        incumbent,
      );
    } else {
      assert.deepEqual(
        await readFile(target),
        incumbent,
        "Publication must preserve the target that won the real race",
      );
      if (kind === "symlink") {
        assert.equal((await lstat(target)).isSymbolicLink(), true);
        assert.equal(await readlink(target), "original-target");
      }
    }
    assert.deepEqual(await readFile(sentinel), incumbent);
    assert.equal(outcome.published, false);
    assert.equal(outcome.error?.code, "EEXIST");
    assert.deepEqual(
      await readFile(target + ".partial"),
      payload,
      "Failed publication retains the completed partial as evidence",
    );
  }
});

test("Go failed acquisition retains its actual incomplete partial and failed receipt without a ready artifact claim", async (t) => {
  const parent = await realpath(await fixture(t, {})),
    directory = path.join(parent, "acquisition");
  const original = catalog.profiles[0].sourceArchive,
    filename = original.url.split("/").at(-1);
  const payload = Buffer.from([0]);
  await assert.rejects(
    acquireGoBootstrapInputs(
      directory,
      async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-length": String(original.bytes) },
        }),
    ),
    /archive is incomplete/,
  );
  const receipt = JSON.parse(
    await readFile(path.join(directory, "acquisition.json"), "utf8"),
  );
  assert.equal(receipt.state, "failed");
  assert.deepEqual(receipt.archives, []);
  assert.match(receipt.failure, /archive is incomplete/);
  for (const field of [
    "buildExecuted",
    "projectCodeExecuted",
    "inferenceInvoked",
    "gateAComplete",
  ])
    assert.equal(receipt[field], false);
  assert.deepEqual(
    await readFile(path.join(directory, "archives", filename + ".partial")),
    payload,
  );
  await assert.rejects(
    lstat(path.join(directory, "archives", filename)),
    (error) => (error as NodeJS.ErrnoException).code === "ENOENT",
  );
});

test("Go all matching historical regular manifests cannot promote exact historical replay or full closure", async (t) => {
  const directory = await realpath(await fixture(t, {})),
    controls = path.join(directory, "scripts", "producer-qualification");
  await mkdir(controls, { recursive: true });
  const synthetic = structuredClone(catalog);
  for (const profile of synthetic.profiles) {
    const own = inspectGoPhysicalTree(syntheticStageTrees(profile.id).sdk);
    profile.historicalOutputManifest.sha256 = own.regularManifestSha256;
    if (profile.predecessor)
      profile.predecessor.historicalSdkManifestSha256 = inspectGoPhysicalTree(
        syntheticStageTrees(profile.predecessor.stage).sdk,
      ).regularManifestSha256;
  }
  // This separate closed synthetic source fixture has no original/private SDK bytes.
  const raw = JSON.stringify(synthetic, null, 2) + "\n";
  await writeFile(path.join(controls, "go-bootstrap.v1.json"), raw);
  const source = await readFile(
    path.join(root, "scripts/producer-qualification/go-bootstrap-profile.mjs"),
    "utf8",
  );
  const bound = source.replace(
    /(export const goBootstrapCatalogSha256\s*=\s*)"[a-f0-9]{64}"/u,
    '$1"' + hash(raw) + '"',
  );
  assert.notEqual(bound, source);
  await writeFile(path.join(controls, "go-bootstrap-profile.mjs"), bound);
  await copyFile(
    path.join(root, "scripts/qualify-binutils-producer.mjs"),
    path.join(directory, "scripts/qualify-binutils-producer.mjs"),
  );
  await copyFile(
    path.join(
      root,
      "scripts/producer-qualification/binutils-retention-observer.mjs",
    ),
    path.join(controls, "binutils-retention-observer.mjs"),
  );
  const api = await import(
    pathToFileURL(path.join(controls, "go-bootstrap-profile.mjs")).href
  );
  const {
    rows,
    source: frame,
    chainAttempt,
  } = syntheticChain(api, await api.loadGoBootstrapCatalog());
  const summary = api.completeGoChain(rows, frame, chainAttempt);
  assert.equal(
    summary.exactHistoricalPrivateInputReplay,
    false,
    "Regular-only matching cannot establish exact historical input replay",
  );
  assert.equal(summary.freshNativeUpstreamSourceAncestryComplete, true);
  assert.equal(summary.historicalBootstrapRegularInputsMatched, true);
  assert.equal(rows[0].historicalBootstrapRegularInputsMatched, null);
  assert.ok(
    rows
      .slice(1)
      .every((row) => row.historicalBootstrapRegularInputsMatched === true),
  );
  assert.ok(
    rows.every((row) => row.historicalRegularOutputComparison === "match"),
  );
  for (const row of [...rows, summary])
    for (const flag of [
      "exactHistoricalPrivateInputReplay",
      "fullCompilerSdkBootstrapClosureVerified",
      "completeOriginalNoticeClosureVerified",
      "gateAComplete",
    ])
      assert.equal(row[flag], false, flag);
  const before = rows[3].sdkTree,
    changedMode = structuredClone(before);
  changedMode.root.uid++;
  assert.equal(
    inspectGoPhysicalTree(before).regularManifestSha256,
    inspectGoPhysicalTree(changedMode).regularManifestSha256,
  );
  assert.notEqual(
    inspectGoPhysicalTree(before).fullManifestSha256,
    inspectGoPhysicalTree(changedMode).fullManifestSha256,
  );
});
