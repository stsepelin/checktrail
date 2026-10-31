import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
const { realpath } = await import("node:fs/promises");
const {
  goContainerSpec,
  requireGoContainerConfiguration,
  requireGoMountGraph,
  captureGoMountIdentity,
  captureGoMountCustody,
  runGoContainerTransport,
} = await import(
  new URL(
    "../../scripts/producer-qualification/go-bootstrap-transport.mjs",
    import.meta.url,
  ).href
);
const { loadGoBootstrapCatalog, goProfile } = await import(
  new URL(
    "../../scripts/producer-qualification/go-bootstrap-profile.mjs",
    import.meta.url,
  ).href
);
const { originalGoArguments, goObserverArguments } = await import(
  new URL("../../scripts/qualify-go-bootstrap-producer.mjs", import.meta.url)
    .href
);
const catalog = await loadGoBootstrapCatalog();
const imageConfig = JSON.parse(
  Buffer.from(
    JSON.parse(
      await readFile(
        new URL(
          "../../scripts/producer-qualification/binutils-image-identity.v1.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ).config.base64,
    "base64",
  ).toString("utf8"),
).config;
const containerId = "a".repeat(64),
  imageId = "sha256:" + "b".repeat(64);
function setup() {
  const profile = goProfile(catalog, "go1.17.13"),
    args = originalGoArguments(profile, profile.originalCommands[2], {
      attempt: randomUUID(),
      cid: "/synthetic/owned/id",
      stageWork: "/synthetic/stages/child",
      predecessorRoot: "/synthetic/stages/parent/go",
      image: profile.image,
    }),
    spec = goContainerSpec(args, imageConfig, imageId);
  return { args, spec };
}
function inspection(spec: ReturnType<typeof goContainerSpec>, exited = false) {
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
      NetworkMode: "none",
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
      StartedAt: exited
        ? "2026-01-01T00:00:00.000000001Z"
        : "0001-01-01T00:00:00Z",
      FinishedAt: exited
        ? "2026-01-01T00:00:00.000000002Z"
        : "0001-01-01T00:00:00Z",
      OOMKilled: false,
      Error: "",
    },
  };
}
const terminal = { exitCode: 0, signal: null, reason: null, stopError: null };

test("Go actual daemon projection requires exact closed command environment budgets and both runtime and requested mount graphs", () => {
  const { args, spec } = setup(),
    good = inspection(spec);
  assert.equal(args[0], "create");
  assert.ok(!args.includes("--rm"));
  assert.deepEqual(
    requireGoContainerConfiguration(good, spec, "/synthetic/stages/parent/go")
      .mounts,
    spec.mounts,
  );
  for (const mutate of [
    (v: typeof good) => {
      v.HostConfig.Memory--;
    },
    (v: typeof good) => {
      v.HostConfig.Privileged = true;
    },
    (v: typeof good) => {
      v.HostConfig.NetworkMode = "host";
    },
    (v: typeof good) => {
      v.Config.Cmd = ["-c", "synthetic-foreign"];
    },
    (v: typeof good) => {
      v.Config.Env.push("SYNTHETIC_EXTRA=1");
    },
    (v: typeof good) => {
      v.Mounts[1].RW = true;
    },
    (v: typeof good) => {
      v.HostConfig.Mounts[1].ReadOnly = false;
    },
    (v: typeof good) => {
      v.Mounts.push({ ...v.Mounts[0], Destination: "/extra" });
    },
    (v: typeof good) => {
      v.Mounts[0].Type = "volume";
    },
    (v: typeof good) => {
      v.Mounts[0].Propagation = "shared";
    },
    (v: typeof good) => {
      v.Config.AttachStdout = false;
    },
  ]) {
    const changed = structuredClone(good);
    mutate(changed);
    assert.throws(() =>
      requireGoContainerConfiguration(
        changed,
        spec,
        "/synthetic/stages/parent/go",
      ),
    );
  }
  assert.throws(
    () =>
      goContainerSpec(
        args,
        { ...imageConfig, Volumes: { "/foreign": {} } },
        imageId,
      ),
    /unexpected volumes/,
  );
  assert.throws(
    () =>
      goContainerSpec(
        [...args.slice(0, 1), "--privileged", ...args.slice(1)],
        imageConfig,
        imageId,
      ),
    /Unexpected fixed/,
  );
  const prepProfile = goProfile(catalog, "go1.17.13"),
    prep = goObserverArguments(prepProfile, "prepare", {
      attempt: randomUUID(),
      cid: "/synthetic/cid",
      stageWork: "/synthetic/work",
      destination: "/synthetic/dest",
    });
  const prepSpec = goContainerSpec(prep, imageConfig, imageId);
  assert.deepEqual(prepSpec.capAdd, ["CAP_DAC_OVERRIDE"]);
  assert.ok(
    prepSpec.mounts
      .filter((row: { RW: boolean }) => row.RW)
      .every((row: { Destination: string }) => row.Destination === "/work"),
  );
});
test("Go sealed predecessor rejects writable equal ancestor descendant aliases and unexpected mount types or destinations", () => {
  const { spec } = setup();
  for (const source of [
    "/synthetic/stages",
    "/synthetic/stages/parent",
    "/synthetic/stages/parent/go",
    "/synthetic/stages/parent/go/cache",
  ]) {
    const mounts = structuredClone(spec.mounts);
    mounts[0].Source = source;
    assert.throws(
      () => requireGoMountGraph(mounts, mounts, "/synthetic/stages/parent/go"),
      /Writable mount aliases/,
    );
  }
  assert.doesNotThrow(() =>
    requireGoMountGraph(
      spec.mounts,
      spec.mounts,
      "/synthetic/stages/parent/go",
    ),
  );
});
test("Go physical custody rejects linked roots replacement and RW parent while permitting only a fresh sibling", async (t) => {
  const root = await realpath(await fixture(t, {})),
    parent = path.join(root, "parent"),
    child = path.join(root, "child"),
    sdk = path.join(parent, "go");
  await mkdir(parent);
  await mkdir(child);
  await mkdir(sdk);
  const identity = await captureGoMountIdentity(sdk);
  const mounts = [
    {
      Type: "bind",
      Source: child,
      Destination: "/work",
      RW: true,
      Propagation: "rprivate",
    },
    {
      Type: "bind",
      Source: sdk,
      Destination: "/bootstrap",
      RW: false,
      Propagation: "rprivate",
    },
  ];
  const captured = await captureGoMountCustody(mounts, sdk, identity);
  assert.deepEqual(captured.protectedIdentity, identity);
  await assert.rejects(
    captureGoMountCustody(
      [{ ...mounts[0], Source: root }, mounts[1]],
      sdk,
      identity,
    ),
    /Writable mount aliases/,
  );
  await symlink(sdk, path.join(root, "linked"));
  await assert.rejects(
    captureGoMountCustody(
      [{ ...mounts[0], Source: path.join(root, "linked") }, mounts[1]],
      sdk,
      identity,
    ),
    /Linked path/,
  );
  await rename(sdk, sdk + "-old");
  await mkdir(sdk);
  await assert.rejects(
    captureGoMountCustody(mounts, sdk, identity),
    /physical root changed/,
  );
});

test("Go create inspect attach protocol retains fast version output and checks actual native terminal before owned cleanup", async () => {
  const { args, spec } = setup(),
    calls: string[] = [],
    observations: unknown[] = [],
    budgets: number[] = [];
  let time = 1000,
    cleanups = 0;
  const result = await runGoContainerTransport({
    args,
    spec,
    protectedRoot: "/synthetic/stages/parent/go",
    deadline: 61000,
    now: () => time,
    custody: async () => {
      calls.push("custody");
    },
    invoke: async (operation: string, argv: string[], timeoutMs: number) => {
      calls.push(operation);
      budgets.push(timeoutMs);
      time += 1000;
      if (operation === "create") {
        assert.deepEqual(argv, args);
        return { terminal, text: containerId + "\n" };
      }
      if (operation === "start-attached") {
        assert.deepEqual(argv, ["start", "--attach", containerId]);
        return {
          terminal,
          text: "go version go1.17.13 linux/amd64\n",
          raw: { bytes: 33, sha256: "c".repeat(64) },
        };
      }
      assert.deepEqual(argv, ["inspect", containerId]);
      return {
        terminal,
        text: JSON.stringify([
          inspection(spec, operation === "inspect-after-terminal"),
        ]),
      };
    },
    record: async (row: unknown) => {
      observations.push(row);
    },
    cleanup: async () => {
      cleanups++;
      calls.push("cleanup");
    },
  });
  assert.equal(result.text, "go version go1.17.13 linux/amd64\n");
  assert.equal(result.nativeState.Status, "exited");
  assert.deepEqual(calls, [
    "create",
    "inspect-before-start",
    "custody",
    "start-attached",
    "inspect-after-terminal",
    "custody",
    "cleanup",
  ]);
  assert.equal(observations.length, 2);
  assert.equal(cleanups, 1);
  assert.deepEqual(budgets, [15000, 15000, 58000, 15000]);
});
test("Go transport malformed creation inspect custody cutoff attach failure and native mismatch all refuse with owned cleanup", async () => {
  for (const mode of [
    "create-failure",
    "create-throw",
    "record-failure",
    "create-id",
    "inspect-failure",
    "inspect-json",
    "inspect-count",
    "mount",
    "already-started",
    "custody",
    "cutoff",
    "start-throw",
    "start-failure",
    "still-created",
    "wrong-native-exit",
    "never-started",
    "oom",
    "cleanup",
  ]) {
    const { args, spec } = setup(),
      calls: string[] = [];
    let cleanup = 0,
      time = 1000;
    await assert.rejects(
      runGoContainerTransport({
        args,
        spec,
        protectedRoot: "/synthetic/stages/parent/go",
        deadline: 61000,
        now: () => time,
        custody: async () => {
          if (mode === "custody")
            throw Error("actual synthetic custody refusal");
          if (mode === "cutoff") time = 62000;
        },
        invoke: async (operation: string) => {
          calls.push(operation);
          if (operation === "create") {
            if (mode === "create-throw")
              throw Error("actual synthetic create storage refusal");
            return {
              terminal:
                mode === "create-failure"
                  ? { ...terminal, exitCode: 7 }
                  : terminal,
              text: mode === "create-id" ? "foreign" : containerId + "\n",
            };
          }
          if (operation === "start-attached") {
            if (mode === "start-throw")
              throw Error("actual synthetic transport start failure");
            return {
              terminal:
                mode === "start-failure"
                  ? { ...terminal, exitCode: 7 }
                  : terminal,
              text: "original synthetic output",
            };
          }
          const after = operation === "inspect-after-terminal",
            value = inspection(spec, after && mode !== "still-created");
          if (mode === "mount" && !after) value.Mounts[1].RW = true;
          if (mode === "already-started" && !after)
            value.State.Status = "running";
          if (mode === "wrong-native-exit" && after) value.State.ExitCode = 7;
          if (mode === "never-started" && after)
            value.State.StartedAt = "0001-01-01T00:00:00Z";
          if (mode === "oom" && after) value.State.OOMKilled = true;
          return {
            terminal:
              mode === "inspect-failure"
                ? { ...terminal, exitCode: 7 }
                : terminal,
            text:
              mode === "inspect-json"
                ? "{"
                : JSON.stringify(
                    mode === "inspect-count" ? [value, value] : [value],
                  ),
          };
        },
        record: async () => {
          if (mode === "record-failure")
            throw Error("actual synthetic prestart record storage refusal");
        },
        cleanup: async () => {
          cleanup++;
          if (mode === "cleanup")
            throw Error("actual synthetic owned cleanup refusal");
        },
      }),
      {
        name: [
          "custody",
          "start-throw",
          "cleanup",
          "record-failure",
          "create-throw",
        ].includes(mode)
          ? "Error"
          : mode === "inspect-json"
            ? "SyntaxError"
            : "AssertionError",
      },
      mode,
    );
    assert.equal(cleanup, 1, mode);
    if (
      [
        "create-failure",
        "create-throw",
        "record-failure",
        "create-id",
        "inspect-failure",
        "inspect-json",
        "inspect-count",
        "mount",
        "already-started",
        "custody",
        "cutoff",
      ].includes(mode)
    )
      assert.ok(!calls.includes("start-attached"), mode);
  }
});
test("Go nonzero actual command remains failed and all inspect metadata is recorded before qualification assertions", async () => {
  const { args, spec } = setup(),
    observations: unknown[] = [];
  const failed = { ...terminal, exitCode: 3 };
  const result = await runGoContainerTransport({
    args,
    spec,
    protectedRoot: null,
    deadline: Date.now() + 60000,
    custody: async () => {},
    invoke: async (operation: string) => {
      if (operation === "create") return { terminal, text: containerId };
      if (operation === "start-attached")
        return { terminal: failed, text: "original native failed output" };
      const value = inspection(spec, operation === "inspect-after-terminal");
      if (operation === "inspect-after-terminal") value.State.ExitCode = 3;
      return { terminal, text: JSON.stringify([value]) };
    },
    record: async (row: unknown) => {
      observations.push(row);
    },
    cleanup: async () => {},
  });
  assert.deepEqual(result.terminal, failed);
  assert.equal(result.nativeState.ExitCode, 3);
  assert.equal(observations.length, 2);
});

test("Go observed Docker API capability tokens stay distinct from fixed CLI aliases and reject every widening or malformed projection", () => {
  const observations = [
    { mode: "prepare", cli: "DAC_OVERRIDE", api: "CAP_DAC_OVERRIDE" },
    { mode: "observe", cli: "DAC_READ_SEARCH", api: "CAP_DAC_READ_SEARCH" },
  ];
  for (const id of catalog.requiredStages)
    for (const observed of observations) {
      const profile = goProfile(catalog, id);
      const args = goObserverArguments(profile, observed.mode, {
        attempt: randomUUID(),
        cid: "/synthetic/owned/cid",
        stageWork: "/synthetic/stages/current",
        predecessorRoot:
          profile.predecessor && observed.mode === "observe"
            ? "/synthetic/stages/parent/go"
            : null,
        destination: "/synthetic/owned",
      });
      const spec = goContainerSpec(args, imageConfig, imageId),
        raw = inspection(spec);
      // Synthetic data with the actual API shape/tokens; no private Docker paths or reports.
      raw.HostConfig.CapAdd = [observed.api];
      raw.HostConfig.CapDrop = ["ALL"];
      raw.HostConfig.SecurityOpt = ["no-new-privileges"];
      assert.ok(args.includes("--cap-add=" + observed.cli));
      assert.ok(args.includes("--cap-drop=ALL"));
      assert.doesNotThrow(() => requireGoContainerConfiguration(raw, spec));
      for (const capabilities of [
        [],
        [observed.cli],
        [observed.api + "_EXTRA"],
        [observed.api.toLowerCase()],
        [observed.api, "CAP_SYS_ADMIN"],
        [observed.api, "CAP_SYS_TIME"],
        [observed.api, observed.api],
        ["CAP_DAC_OVERRIDE", "CAP_DAC_READ_SEARCH"],
        ["CAP_ALL"],
      ]) {
        const changed = structuredClone(raw);
        changed.HostConfig.CapAdd = capabilities;
        assert.throws(() => requireGoContainerConfiguration(changed, spec), {
          name: "AssertionError",
        });
      }
      for (const drop of [
        [],
        ["CAP_ALL"],
        ["ALL", "ALL"],
        ["ALL", "CAP_SYS_ADMIN"],
      ]) {
        const changed = structuredClone(raw);
        changed.HostConfig.CapDrop = drop;
        assert.throws(() => requireGoContainerConfiguration(changed, spec), {
          name: "AssertionError",
        });
      }
      for (const token of [
        "SYS_ADMIN",
        "SYS_TIME",
        "ALL",
        "CAP_DAC_OVERRIDE",
        "DAC_OVERRIDE_EXTRA",
        "dac_override",
        "",
      ]) {
        const changed = args.map((value: string) =>
          value === "--cap-add=" + observed.cli ? "--cap-add=" + token : value,
        );
        assert.throws(
          () => goContainerSpec(changed, imageConfig, imageId),
          /Unqualified Go observer capability/,
        );
      }
      const capabilityAt = args.indexOf("--cap-add=" + observed.cli);
      assert.throws(
        () =>
          goContainerSpec(
            [
              ...args.slice(0, capabilityAt),
              args[capabilityAt],
              ...args.slice(capabilityAt),
            ],
            imageConfig,
            imageId,
          ),
        /Unqualified Go observer capability/,
      );
      const dropAt = args.indexOf("--cap-drop=ALL");
      assert.throws(
        () =>
          goContainerSpec(
            [...args.slice(0, dropAt), args[dropAt], ...args.slice(dropAt)],
            imageConfig,
            imageId,
          ),
        /Unqualified Go observer capability drop/,
      );
      for (const token of ["all", "CAP_ALL", "SYS_TIME", ""]) {
        const changed = args.map((value: string) =>
          value === "--cap-drop=ALL" ? "--cap-drop=" + token : value,
        );
        assert.throws(
          () => goContainerSpec(changed, imageConfig, imageId),
          /Unqualified Go observer capability drop/,
        );
      }
    }
});
