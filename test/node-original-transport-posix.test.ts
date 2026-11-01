import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { test } from "node:test";
import { URL } from "node:url";
const profile = await import(
  new URL(
    "../../scripts/producer-qualification/node-original-profile.mjs",
    import.meta.url,
  ).href
);
const transport = await import(
  new URL(
    "../../scripts/producer-qualification/node-original-transport.mjs",
    import.meta.url,
  ).href
);
const controller = await import(
  new URL("../../scripts/qualify-node-original-producer.mjs", import.meta.url)
    .href
);
const catalog = profile.nodeOriginalCatalog();
const imageConfig = {
  Env: ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
  Labels: {},
  Volumes: null,
};
const containerId = "a".repeat(64),
  imageId = "sha256:" + "b".repeat(64);
const terminal = {
  exitCode: 0,
  signal: null,
  error: null,
  reason: null,
  stopError: null,
};
function setup(kind = "original", selector = "build") {
  const args = controller.nodeOriginalArguments(kind, selector, {
    attempt: randomUUID(),
    cid: "/synthetic/id",
    stageWork: "/synthetic/work/node",
    destination: "/synthetic",
    grantSeconds: 60,
  });
  return {
    args,
    spec: transport.nodeContainerSpec(args, imageConfig, imageId, kind),
  };
}
function inspection(
  spec: ReturnType<typeof transport.nodeContainerSpec>,
  exited = false,
) {
  return {
    Id: containerId,
    Name: "/" + spec.name,
    Image: imageId,
    Config: {
      Image: spec.image,
      Entrypoint: spec.entrypoint,
      Cmd: spec.cmd,
      User: "0:0",
      WorkingDir: spec.workdir,
      Tty: false,
      OpenStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      AttachStdin: false,
      Env: Object.entries(spec.env).map(([key, value]) => key + "=" + value),
      Labels: spec.labels,
      Volumes: null,
    },
    HostConfig: {
      ContainerIDFile: spec.cidfile,
      NetworkMode: spec.networkMode,
      Privileged: false,
      Init: true,
      AutoRemove: false,
      ReadonlyRootfs: spec.readonly,
      NanoCpus: spec.cpus,
      Memory: spec.memory,
      PidsLimit: spec.pids,
      CapAdd: spec.capAdd,
      CapDrop: spec.capDrop,
      SecurityOpt: spec.securityOpt,
      Binds: null,
      VolumesFrom: null,
      Links: null,
      Devices: [],
      DeviceRequests: null,
      PortBindings: {},
      Tmpfs: {},
      PidMode: "",
      IpcMode: "private",
      UTSMode: "",
      UsernsMode: "",
      PublishAllPorts: false,
      RestartPolicy: { Name: "no" },
      Mounts: spec.mounts.map(
        (row: {
          Type: string;
          Source: string;
          Destination: string;
          RW: boolean;
        }) => ({
          Type: row.Type,
          Source: row.Source,
          Target: row.Destination,
          ReadOnly: !row.RW,
        }),
      ),
    },
    Mounts: spec.mounts,
    State: {
      Status: exited ? "exited" : "created",
      Running: false,
      Pid: 0,
      ExitCode: 0,
      StartedAt: exited ? "2026-01-01T00:00:01Z" : "0001-01-01T00:00:00Z",
      FinishedAt: exited ? "2026-01-01T00:00:02Z" : "0001-01-01T00:00:00Z",
      OOMKilled: false,
      Error: "",
    },
  };
}
test(
  "Original Node commands use fresh built Node for each closed local archive and reject unknown stage names",
  { skip: process.platform === "win32" },
  () => {
    const original = setup();
    assert.ok(original.args.includes("bridge"));
    assert.deepEqual(original.spec.cmd, ["-j4"]);
    assert.equal(original.spec.cpus, 4e9);
    assert.equal(original.spec.memory, 8 * 1024 ** 3);
    assert.equal(original.spec.pids, 1024);
    const metadata = setup("metadata", "prepare");
    assert.equal(metadata.spec.networkMode, "none");
    assert.equal(metadata.spec.cpus, 1e9);
    assert.ok(metadata.spec.cmd.includes("60"));
    for (const row of catalog.docCache.artifacts) {
      const command = profile.nodeOriginalCacheCommand(row.id);
      assert.equal(command[0], "/work/node-v22.16.0/out/Release/node");
      assert.deepEqual(command.slice(2), [
        "--cache=/work/npm-cache",
        "cache",
        "add",
        "/bundle/docs/" + row.id + ".tgz",
      ]);
    }
    assert.throws(() => profile.nodeOriginalCacheCommand("../foreign"));
    assert.throws(() => setup("original", "build-adjacent"));
    assert.throws(() => setup("metadata", "prepare-adjacent"));
  },
);

test(
  "Original Node transport independently binds bridge and none while retaining actual configuration hashes",
  { skip: process.platform === "win32" },
  () => {
    for (const kind of [
      "original",
      "cache-preparation",
      "metadata",
      "caller-preflight",
    ]) {
      const selector =
        kind === "cache-preparation"
          ? catalog.docCache.artifacts[0].id
          : kind === "metadata"
            ? "preflight"
            : kind === "caller-preflight"
              ? "root-readable"
              : "build";
      const { args, spec } = setup(kind, selector),
        raw = inspection(spec);
      const actual = transport.requireNodeContainerConfiguration(raw, spec);
      assert.equal(actual.hostConfiguration.NetworkMode, spec.networkMode);
      assert.equal(
        actual.configurationSha256,
        createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
      );
      const altered = structuredClone(raw);
      altered.HostConfig.NetworkMode =
        kind === "metadata" || kind === "caller-preflight" ? "bridge" : "none";
      assert.throws(
        () => transport.requireNodeContainerConfiguration(altered, spec),
        /network policy differs/u,
      );
      const wrong = args.slice();
      wrong[wrong.indexOf("--network") + 1] = "host";
      assert.throws(
        () => transport.nodeContainerSpec(wrong, imageConfig, imageId, kind),
        /network policy differs/u,
      );
    }
  },
);

test(
  "Original Node delegated daemon checks still refuse privileged mounts environment and resource drift",
  { skip: process.platform === "win32" },
  () => {
    const { spec } = setup();
    for (const mutate of [
      (v: ReturnType<typeof inspection>) => {
        v.HostConfig.Privileged = true;
      },
      (v: ReturnType<typeof inspection>) => {
        v.HostConfig.Memory--;
      },
      (v: ReturnType<typeof inspection>) => {
        v.Config.Env.push("CC=clang");
      },
      (v: ReturnType<typeof inspection>) => {
        v.Mounts = v.Mounts.slice(1);
      },
      (v: ReturnType<typeof inspection>) => {
        v.Config.Entrypoint = ["/foreign/make"];
      },
    ]) {
      const value = inspection(spec);
      mutate(value);
      assert.throws(() =>
        transport.requireNodeContainerConfiguration(value, spec),
      );
    }
  },
);

test(
  "Original Node transport records actual before and after native state before cleanup",
  { skip: process.platform === "win32" },
  async () => {
    const { args, spec } = setup(),
      operations: string[] = [],
      phases: string[] = [];
    const value = await transport.runNodeContainerTransport({
      args,
      spec,
      deadline: 100,
      now: () => 0,
      custody: async () => {
        operations.push("custody");
      },
      cleanup: async () => {
        operations.push("cleanup");
      },
      record: async (row: { phase: string }) => {
        phases.push(row.phase);
      },
      invoke: async (operation: string) => {
        operations.push(operation);
        return {
          terminal,
          text:
            operation === "create"
              ? containerId
              : operation === "inspect-before-start"
                ? JSON.stringify([inspection(spec)])
                : operation === "inspect-after-terminal"
                  ? JSON.stringify([inspection(spec, true)])
                  : "original raw retained separately",
        };
      },
    });
    assert.equal(value.nativeState.ExitCode, 0);
    assert.deepEqual(phases, ["before-start", "after-terminal"]);
    assert.deepEqual(operations, [
      "create",
      "inspect-before-start",
      "custody",
      "start-attached",
      "inspect-after-terminal",
      "custody",
      "cleanup",
    ]);
  },
);

test(
  "Original Node native disagreement and expired admission refuse without invented success",
  { skip: process.platform === "win32" },
  async () => {
    const { args, spec } = setup();
    let started = false,
      cleaned = false;
    await assert.rejects(
      transport.runNodeContainerTransport({
        args,
        spec,
        deadline: 0,
        now: () => 0,
        custody: async () => {},
        record: async () => {},
        cleanup: async () => {
          cleaned = true;
        },
        invoke: async () => {
          started = true;
        },
      }),
      /expired before native start/u,
    );
    assert.equal(started, false);
    assert.equal(cleaned, true);
    await assert.rejects(
      transport.runNodeContainerTransport({
        args,
        spec,
        deadline: 100,
        now: () => 0,
        custody: async () => {},
        record: async () => {},
        cleanup: async () => {},
        invoke: async (operation: string) => {
          const raw = inspection(spec, operation === "inspect-after-terminal");
          if (operation === "inspect-after-terminal") raw.State.ExitCode = 1;
          return {
            terminal,
            text: operation === "create" ? containerId : JSON.stringify([raw]),
          };
        },
      }),
      /actual native terminal differ/u,
    );
  },
);

test(
  "Original Node primary and cleanup errors retain exact ordered typed cause descriptors",
  { skip: process.platform === "win32" },
  async () => {
    const { args, spec } = setup(),
      first = Error("first physical observation failure"),
      second = Error("second cleanup failure");
    let caught;
    try {
      await transport.runNodeContainerTransport({
        args,
        spec,
        deadline: 100,
        now: () => 0,
        custody: async () => {},
        record: async () => {},
        invoke: async () => {
          throw first;
        },
        cleanup: async () => {
          throw second;
        },
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof AggregateError);
    assert.deepEqual(caught.errors, [first, second]);
    assert.equal(caught.cause, first);
    const rendered = controller.nodeOriginalFailure(caught);
    assert.deepEqual(
      rendered.causes.map((row: { prefix: string }) => row.prefix),
      [String(first), String(second)],
    );
    assert.equal(
      controller.combineNodeOriginalFailure(undefined, first),
      first,
    );
  },
);

test(
  "Original Node canonical empty command accepts captured null and exact array while rejecting missing or foreign arguments",
  { skip: process.platform === "win32" },
  () => {
    const { spec } = setup("original", "configure");
    assert.deepEqual(spec.cmd, []);
    const capturedShape = inspection(spec);
    capturedShape.Config.Cmd = null;
    const result = transport.requireNodeContainerConfiguration(
      capturedShape,
      spec,
    );
    assert.equal(result.emptyCommandProjectionApplied, true);
    assert.equal(result.containerConfiguration, capturedShape.Config);
    assert.equal(result.containerConfiguration.Cmd, null);
    assert.equal(
      result.configurationSha256,
      createHash("sha256").update(JSON.stringify(capturedShape)).digest("hex"),
    );
    const arrayNearMiss = transport.requireNodeContainerConfiguration(
      inspection(spec),
      spec,
    );
    assert.equal(arrayNearMiss.emptyCommandProjectionApplied, false);
    assert.deepEqual(arrayNearMiss.containerConfiguration.Cmd, []);
    for (const value of [undefined, [""], ["--help"], "", {}]) {
      const wrong = inspection(spec);
      wrong.Config.Cmd = value;
      assert.throws(() =>
        transport.requireNodeContainerConfiguration(wrong, spec),
      );
    }
    const missing = inspection(spec);
    Reflect.deleteProperty(missing.Config, "Cmd");
    assert.throws(() =>
      transport.requireNodeContainerConfiguration(missing, spec),
    );
    const nonempty = setup("original", "build"),
      nullForBuild = inspection(nonempty.spec);
    nullForBuild.Config.Cmd = null;
    assert.throws(() =>
      transport.requireNodeContainerConfiguration(nullForBuild, nonempty.spec),
    );
    const foreignEntry = inspection(spec);
    foreignEntry.Config.Cmd = null;
    foreignEntry.Config.Entrypoint = ["/foreign/configure"];
    assert.throws(() =>
      transport.requireNodeContainerConfiguration(foreignEntry, spec),
    );
  },
);

test(
  "Original Node canonical empty command preserves null through prestart transport and actual terminal admission",
  { skip: process.platform === "win32" },
  async () => {
    const { args, spec } = setup("original", "configure"),
      before = inspection(spec),
      after = inspection(spec, true);
    before.Config.Cmd = null;
    after.Config.Cmd = null;
    const operations: string[] = [],
      records: { phase: string; containerConfiguration?: { Cmd: unknown } }[] =
        [];
    const result = await transport.runNodeContainerTransport({
      args,
      spec,
      deadline: 100,
      now: () => 0,
      custody: async () => {
        operations.push("custody");
      },
      cleanup: async () => {
        operations.push("cleanup");
      },
      record: async (row: {
        phase: string;
        containerConfiguration?: { Cmd: unknown };
      }) => {
        records.push(row);
      },
      invoke: async (operation: string) => {
        operations.push(operation);
        return {
          terminal,
          text:
            operation === "create"
              ? containerId
              : operation === "inspect-before-start"
                ? JSON.stringify([before])
                : operation === "inspect-after-terminal"
                  ? JSON.stringify([after])
                  : "retained original command output",
        };
      },
    });
    assert.equal(result.nativeState.ExitCode, 0);
    assert.equal(result.prestartConfiguration.containerConfiguration.Cmd, null);
    assert.equal(records[0]!.containerConfiguration!.Cmd, null);
    assert.deepEqual(operations, [
      "create",
      "inspect-before-start",
      "custody",
      "start-attached",
      "inspect-after-terminal",
      "custody",
      "cleanup",
    ]);
  },
);
