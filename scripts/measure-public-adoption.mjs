import assert from "node:assert/strict";
import { compareNativeEvidence } from "./public-adoption-evidence.mjs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";

const base = realpathSync(process.argv[2] ?? ".checktrail/adoption-alpha2");
const artifact = realpathSync(
  process.argv[3] ??
    path.join(
      base,
      "../onboarding-alpha2/stsepelin-checktrail-0.1.0-alpha.2.tgz",
    ),
);
const planPath = new URL("./public-adoption-plan.json", import.meta.url);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const cliRelative =
  "installation/node_modules/@stsepelin/checktrail/dist/src/cli.js";
const cli = path.join(base, cliRelative);
const output = path.join(base, "observations");
mkdirSync(output, { recursive: true });
const env = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);
const invoke = (command, args, cwd = base, extraEnv = {}) => {
  const start = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    timeout: 240_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.signal)
    throw result.error ?? new Error(`Process terminated: ${result.signal}`);
  return {
    exitCode: result.status,
    wallMs: Math.round(performance.now() - start),
    stdout: result.stdout,
    stderr: result.stderr,
  };
};
assert.equal(
  invoke(process.execPath, [cli, "--version"]).stdout.trim(),
  plan.engine.version,
);
assert.equal(hash(readFileSync(artifact)), plan.engine.tarballSha256);
const members = invoke("tar", ["-tzf", artifact])
  .stdout.trim()
  .split("\n")
  .filter(
    (file) => file.startsWith("package/dist/src/") && !file.endsWith("/"),
  );
assert.ok(members.length > 0);
for (const member of members) {
  const expected = invoke("tar", ["-xOf", artifact, member]);
  assert.equal(expected.exitCode, 0);
  assert.equal(
    readFileSync(
      path.join(
        base,
        "installation/node_modules/@stsepelin/checktrail",
        member.slice("package/".length),
      ),
      "utf8",
    ),
    expected.stdout,
    "Installed engine differs from the release artifact",
  );
}
const images = {
  python:
    "sha256:50acdf79e4b3fcfafb4151579ac00b097382f64190481a1d69399efea05c9fed",
  php: process.env.CHECKTRAIL_ADOPTION_PHP_IMAGE,
};
assert.match(images.php ?? "", /^sha256:[a-f0-9]{64}$/);
const containers = new Map();
const profiles = {
  nanoid: {
    checks: ["javascript.node-test"],
    negative: [
      "checktrail-adoption.test.js",
      "import { test } from 'node:test'; import assert from 'node:assert/strict'; test('checktrail adoption sentinel', () => assert.equal(1, 2));\n",
    ],
  },
  mitt: {
    checks: ["javascript.typescript"],
    negative: [
      "src/checktrail-adoption.ts",
      "export const checktrailAdoptionSentinel: number = 'wrong';\n",
    ],
  },
  "more-itertools": {
    checks: ["python.unittest"],
    container: "python",
    negative: [
      "tests/test_checktrail_adoption.py",
      "import unittest\nclass AdoptionSentinel(unittest.TestCase):\n    def test_sentinel(self):\n        self.assertEqual(1, 2)\n",
    ],
  },
  uuid: {
    checks: ["go.format", "go.vet", "go.test"],
    negative: [
      "checktrail_adoption_test.go",
      'package uuid\n\nimport "testing"\n\nfunc TestChecktrailAdoptionSentinel(t *testing.T) {\n\tt.Fatal("checktrail adoption sentinel")\n}\n',
    ],
  },
  "psr-log": {
    checks: ["php.syntax"],
    container: "php",
    negative: [
      "checktrail-adoption-broken.php",
      "<?php function checktrailAdoptionSentinel( {\n",
    ],
  },
};
const observations = [];
const trackedFingerprint = (root) => {
  const files = invoke("git", ["ls-files", "-z"], root)
    .stdout.split("\0")
    .filter(Boolean)
    .sort();
  return hash(
    JSON.stringify(
      files.map((file) => [file, hash(readFileSync(path.join(root, file)))]),
    ),
  );
};
const projectTree = (root, prefix = "") =>
  readdirSync(path.join(root, prefix), { withFileTypes: true })
    .filter(
      (entry) => ![".git", "node_modules", "__pycache__"].includes(entry.name),
    )
    .flatMap((entry) => {
      assert.ok(
        !entry.isSymbolicLink(),
        "Adoption inputs must not contain symlinks",
      );
      const file = path.join(prefix, entry.name);
      return entry.isDirectory()
        ? projectTree(root, file)
        : [[file, hash(readFileSync(path.join(root, file)))]];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
const ensureUnchanged = (root, before) =>
  assert.deepEqual(
    projectTree(root),
    before,
    "Read-only operation changed project files",
  );
const save = (id, phase, result) =>
  writeFileSync(
    path.join(output, `${id}-${phase}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
const parse = (result) => JSON.parse(result.stdout);
const summaryDoctor = (result) => {
  const value = parse(result);
  assert.equal(value.validationPerformed, false);
  return {
    exitCode: result.exitCode,
    status: value.status,
    issues: value.issues,
    validationPerformed: false,
  };
};
const summaryReport = (result) => {
  const value = parse(result);
  assert.equal(value.sourceChanged, false);
  assert.equal(value.sourceError, false);
  assert.equal(value.sourceFingerprint, value.finalSourceFingerprint);
  assert.equal(
    result.exitCode,
    value.outcome === "passed" ? 0 : value.outcome === "failed" ? 1 : 2,
  );
  return {
    exitCode: result.exitCode,
    wallMs: result.wallMs,
    outcome: value.outcome,
    sourceUnchanged: true,
    checks: value.checks.map((check) => ({
      id: check.id,
      project: check.project,
      status: check.status,
      reason: check.reason,
      files: check.scope.length,
      tests: check.tests,
      findings: check.findings?.map(({ ruleId, level, file, line }) => ({
        ruleId,
        level,
        file,
        line,
      })),
      tools: check.tools?.map(({ name, version }) => ({ name, version })),
      processes: check.processes.map(
        ({ exitCode, timedOut, cancelled, truncated }) => ({
          exitCode,
          timedOut,
          cancelled,
          truncated,
        }),
      ),
    })),
  };
};
try {
  for (const [kind, image] of Object.entries(images)) {
    const started = invoke("docker", [
      "run",
      "--detach",
      "--rm",
      "--network=none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=256m",
      "--mount",
      `type=bind,src=${base},dst=/adoption,readonly`,
      "--entrypoint",
      "node",
      image,
      "-e",
      "setInterval(() => {}, 1000)",
    ]);
    assert.equal(started.exitCode, 0, started.stderr);
    containers.set(kind, started.stdout.trim());
  }
  for (const project of plan.projects) {
    process.stderr.write(`Measuring ${project.id}\n`);
    const root = path.join(base, project.id);
    const profile = profiles[project.id];
    assert.equal(
      invoke("git", ["rev-parse", "HEAD"], root).stdout.trim(),
      project.commit,
    );
    assert.equal(
      invoke("git", ["status", "--porcelain", "--untracked-files=no"], root)
        .stdout,
      "",
    );
    assert.ok(
      !existsSync(path.join(root, "checktrail.json")),
      "Use a fresh prepared checkout",
    );
    const fingerprint = trackedFingerprint(root);
    const cliHost = (args) =>
      invoke(process.execPath, [cli, ...args, "--root", root]);
    const execute = (command, args, extraEnv = {}) =>
      profile.container
        ? invoke("docker", [
            "exec",
            "--workdir",
            `/adoption/${project.id}`,
            ...Object.entries(extraEnv).flatMap(([key, value]) => [
              "--env",
              `${key}=${value}`,
            ]),
            containers.get(profile.container),
            command,
            ...args,
          ])
        : invoke(command, args, root, extraEnv);
    const cliPrepared = (args) =>
      profile.container
        ? execute("node", [
            `/adoption/${cliRelative}`,
            ...args,
            "--root",
            `/adoption/${project.id}`,
          ])
        : cliHost(args);
    let before = projectTree(root);
    const preview = cliHost(["init"]);
    save(project.id, "preview", preview);
    ensureUnchanged(root, before);
    const discovered = parse(cliHost(["plan", "--detailed"])).projects;
    const selections = discovered.flatMap((item) => {
      const ids =
        item.adapter === "infrastructure"
          ? ["infrastructure.actionlint"]
          : profile.checks;
      return ids.flatMap((id) => ["--check", `${item.path}#${id}`]);
    });
    const created = cliHost(["init", "--write", ...selections]);
    save(project.id, "created", created);
    assert.equal(parse(created).status, "created");
    const policy = readFileSync(path.join(root, "checktrail.json"));
    const preserved = cliHost(["init", "--write"]);
    assert.equal(parse(preserved).status, "preserved");
    assert.deepEqual(readFileSync(path.join(root, "checktrail.json")), policy);
    before = projectTree(root);
    const doctorHost = cliHost(["doctor", "--detailed"]);
    save(project.id, "doctor-host", doctorHost);
    ensureUnchanged(root, before);
    if (project.id === "mitt")
      cpSync(
        path.join(base, "typescript-tools/node_modules"),
        path.join(root, "node_modules"),
        { recursive: true, errorOnExist: true, force: false },
      );
    const doctorPrepared = cliPrepared(["doctor", "--detailed"]);
    save(project.id, "doctor-prepared", doctorPrepared);
    const full = cliPrepared([
      "run",
      "--trust-project",
      "--timeout-ms",
      "120000",
      "--detailed",
    ]);
    save(project.id, "full-policy", full);
    ensureUnchanged(root, before);
    writeFileSync(
      path.join(root, "checktrail.json"),
      JSON.stringify(
        { schemaVersion: 1, projects: [{ path: ".", checks: profile.checks }] },
        null,
        2,
      ) + "\n",
    );
    const doctorNarrow = cliPrepared(["doctor", "--detailed"]);
    save(project.id, "doctor-language-only", doctorNarrow);
    before = projectTree(root);
    const native = [];
    const runNative = () => {
      if (project.id === "nanoid")
        return [
          execute(process.execPath, [
            "--test",
            "--test-reporter=tap",
            ...readdirSync(path.join(root, "test"))
              .filter((file) => file.endsWith(".test.js"))
              .map((file) => `test/${file}`),
            ...(existsSync(path.join(root, profile.negative[0]))
              ? [profile.negative[0]]
              : []),
          ]),
        ];
      if (project.id === "mitt")
        return [
          execute(process.execPath, [
            "node_modules/typescript/bin/tsc",
            "--project",
            "tsconfig.json",
            "--noEmit",
            "--pretty",
            "false",
            "--incremental",
            "false",
            "--listFiles",
          ]),
        ];
      if (project.id === "more-itertools")
        return [
          execute(
            "python3",
            ["-m", "unittest", "discover", "-s", "tests", "-p", "test*.py"],
            { PYTHONDONTWRITEBYTECODE: "1" },
          ),
        ];
      if (project.id === "uuid")
        return [
          ["gofmt", ["-l", "."]],
          ["go", ["vet", "./..."]],
          ["go", ["test", "-json", "-count=1", "./..."]],
        ].map(([cmd, args]) =>
          execute(cmd, args, {
            GOTOOLCHAIN: "local",
            GOPROXY: "off",
            GOSUMDB: "off",
            GOENV: "off",
            GOFLAGS: "-mod=readonly",
            GOWORK: "off",
            CGO_ENABLED: "0",
          }),
        );
      return projectTree(root)
        .filter(([file]) => file.endsWith(".php"))
        .map(([file]) => execute("php", ["-n", "-l", file]));
    };
    native.push(...runNative());
    save(project.id, "native", native);
    const narrow = cliPrepared([
      "run",
      "--trust-project",
      "--timeout-ms",
      "120000",
      "--detailed",
    ]);
    save(project.id, "language-only", narrow);
    ensureUnchanged(root, before);
    let negativeNative;
    let negative;
    const sentinel = path.join(root, profile.negative[0]);
    assert.ok(!existsSync(sentinel));
    try {
      writeFileSync(sentinel, profile.negative[1], { flag: "wx" });
      negativeNative = runNative();
      save(project.id, "negative-native", negativeNative);
      negative = cliPrepared([
        "run",
        "--trust-project",
        "--timeout-ms",
        "120000",
        "--detailed",
      ]);
      save(project.id, "negative-language-only", negative);
    } finally {
      rmSync(sentinel, { force: true });
    }
    ensureUnchanged(root, before);
    assert.equal(trackedFingerprint(root), fingerprint);
    let preparedTypeScript;
    if (project.id === "mitt") {
      const generated = path.join(root, "index.d.ts");
      assert.ok(!existsSync(generated));
      try {
        const build = execute(process.execPath, [
          "node_modules/typescript/bin/tsc",
          "src/index.ts",
          "--declaration",
          "--emitDeclarationOnly",
          "--strict",
          "--skipLibCheck",
          "--outDir",
          ".",
        ]);
        assert.equal(build.exitCode, 0, build.stderr + build.stdout);
        const preparedNative = runNative();
        assert.equal(preparedNative[0].exitCode, 0, preparedNative[0].stdout);
        const preparedRun = cliPrepared([
          "run",
          "--trust-project",
          "--timeout-ms",
          "120000",
          "--detailed",
        ]);
        save(project.id, "declaration-prepared-native", preparedNative);
        save(project.id, "declaration-prepared-wrapper", preparedRun);
        const comparison = compareNativeEvidence(
          project.id,
          preparedNative,
          parse(preparedRun),
        );
        assert.deepEqual(comparison.wrapperDiagnosticCodes, ["TS5023"]);
        assert.ok(
          parse(preparedRun).checks[0].processes[0].stdout.includes(
            "--noCheck",
          ),
        );
        preparedTypeScript = {
          declarationSha256: hash(readFileSync(generated)),
          buildExitCode: build.exitCode,
          nativeExitCode: preparedNative[0].exitCode,
          comparison,
          wrapper: summaryReport(preparedRun),
        };
      } finally {
        rmSync(generated, { force: true });
      }
      ensureUnchanged(root, before);
    }
    const versionCommands =
      project.id === "nanoid"
        ? [[process.execPath, ["--version"]]]
        : project.id === "mitt"
          ? [
              [
                process.execPath,
                ["node_modules/typescript/bin/tsc", "--version"],
              ],
            ]
          : project.id === "uuid"
            ? [["go", ["version"]]]
            : project.id === "more-itertools"
              ? [["python3", ["--version"]]]
              : [["php", ["-n", "-v"]]];
    observations.push({
      id: project.id,
      commit: project.commit,
      trackedSourceSha256: fingerprint,
      trackedSourceUnchanged: true,
      initialSetup: { exitCode: preview.exitCode, ...parse(preview) },
      createdPolicy: parse(created).configuration,
      preservation: "byte-identical",
      doctorHost: summaryDoctor(doctorHost),
      doctorPrepared: summaryDoctor(doctorPrepared),
      fullPolicy: summaryReport(full),
      doctorLanguageOnly: summaryDoctor(doctorNarrow),
      nativeComparison: compareNativeEvidence(
        project.id,
        native,
        parse(narrow),
      ),
      negativeComparison: compareNativeEvidence(
        project.id,
        negativeNative,
        parse(negative),
        true,
      ),
      preparedTypeScript,
      native: native.map(({ exitCode, wallMs }) => ({ exitCode, wallMs })),
      languageOnly: summaryReport(narrow),
      negativeNative: negativeNative.map(({ exitCode, wallMs }) => ({
        exitCode,
        wallMs,
      })),
      negativeLanguageOnly: summaryReport(negative),
      runtime: versionCommands.map(([cmd, args]) =>
        execute(cmd, args).stdout.trim(),
      ),
      environment: profile.container
        ? {
            os: "linux",
            image: images[profile.container],
            network: "disabled",
            sourceMount: "read-only",
          }
        : { os: process.platform, arch: process.arch, node: process.version },
    });
    writeFileSync(
      path.join(output, "summary.json"),
      JSON.stringify(
        {
          recordedAt: new Date().toISOString(),
          harnessSha256: hash(readFileSync(new URL(import.meta.url))),
          evidenceParserSha256: hash(
            readFileSync(
              new URL("./public-adoption-evidence.mjs", import.meta.url),
            ),
          ),
          planSha256: hash(readFileSync(planPath)),
          engine: plan.engine,
          observations,
        },
        null,
        2,
      ) + "\n",
    );
  }
} finally {
  for (const container of containers.values())
    invoke("docker", ["rm", "--force", container]);
}
process.stdout.write(
  JSON.stringify(
    {
      projects: observations.map(({ id, fullPolicy, languageOnly }) => ({
        id,
        full: fullPolicy.outcome,
        languageOnly: languageOnly.outcome,
      })),
      evidence: output,
    },
    null,
    2,
  ) + "\n",
);
