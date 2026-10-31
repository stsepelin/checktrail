// Fixed native producer transport. No product registration or operator-supplied commands.
import assert from "node:assert/strict";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { physicalPath } from "../qualify-binutils-producer.mjs";
import { sha256 } from "./go-bootstrap-profile.mjs";

const inside = (parent, child) =>
  child === parent || child.startsWith(parent + path.sep);
const id = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const succeeded = (row) =>
  row.exitCode === 0 &&
  row.signal === null &&
  row.reason === null &&
  row.stopError === null;
function envMap(values) {
  assert.ok(Array.isArray(values));
  const output = {};
  for (const value of values) {
    const split = value.indexOf("=");
    assert.ok(
      split > 0 && !Object.hasOwn(output, value.slice(0, split)),
      "Duplicate or malformed container environment",
    );
    output[value.slice(0, split)] = value.slice(split + 1);
  }
  return output;
}
export function goContainerSpec(args, imageConfig, imageId) {
  assert.equal(args[0], "create");
  assert.ok(id(imageId.replace(/^sha256:/u, "")));
  assert.ok(
    imageConfig.Volumes == null ||
      Object.keys(imageConfig.Volumes).length === 0,
    "Pinned image declares unexpected volumes",
  );
  const spec = {
    imageId,
    image: null,
    name: null,
    cidfile: null,
    entrypoint: null,
    cmd: null,
    workdir: null,
    mounts: [],
    labels: { ...imageConfig.Labels },
    env: envMap(imageConfig.Env),
    cpus: null,
    memory: null,
    pids: null,
    readonly: false,
    capAdd: [],
    capDrop: [],
    securityOpt: [],
  };
  const single = new Set();
  for (let i = 1; i < args.length; i++) {
    const option = args[i];
    if (!option.startsWith("--")) {
      spec.image = option;
      spec.cmd = args.slice(i + 1);
      break;
    }
    if (
      ["--init", "--pull=never", "--attach=STDOUT", "--attach=STDERR"].includes(
        option,
      )
    )
      continue;
    if (option === "--read-only") {
      spec.readonly = true;
      continue;
    }
    if (option.startsWith("--cap-add=")) {
      spec.capAdd.push(option.slice(10));
      continue;
    }
    if (option.startsWith("--cap-drop=")) {
      spec.capDrop.push(option.slice(11));
      continue;
    }
    if (option.startsWith("--security-opt=")) {
      spec.securityOpt.push(option.slice(15));
      continue;
    }
    assert.ok(
      [
        "--platform",
        "--name",
        "--cidfile",
        "--label",
        "--network",
        "--user",
        "--cpus",
        "--memory",
        "--pids-limit",
        "--entrypoint",
        "--mount",
        "--workdir",
        "--env",
      ].includes(option),
      "Unexpected fixed transport option",
    );
    const value = args[++i];
    assert.equal(typeof value, "string");
    if (!["--mount", "--label", "--env"].includes(option)) {
      assert.ok(!single.has(option));
      single.add(option);
    }
    if (option === "--platform") assert.equal(value, "linux/amd64");
    else if (option === "--network") assert.equal(value, "none");
    else if (option === "--user") assert.equal(value, "0:0");
    else if (option === "--name") spec.name = value;
    else if (option === "--cidfile") spec.cidfile = value;
    else if (option === "--entrypoint") spec.entrypoint = [value];
    else if (option === "--workdir") spec.workdir = value;
    else if (option === "--cpus") spec.cpus = Number(value) * 1e9;
    else if (option === "--memory") spec.memory = Number(value);
    else if (option === "--pids-limit") spec.pids = Number(value);
    else if (option === "--env" || option === "--label") {
      const at = value.indexOf("=");
      assert.ok(at > 0);
      const target = option === "--env" ? spec.env : spec.labels;
      if (option === "--label")
        assert.ok(!Object.hasOwn(target, value.slice(0, at)));
      target[value.slice(0, at)] = value.slice(at + 1);
    } else if (option === "--mount") {
      const match =
        /^type=bind,src=(\/[^,\r\n]+),target=(\/[^,\r\n]+)(,readonly)?$/u.exec(
          value,
        );
      assert.ok(match, "Unexpected fixed bind syntax");
      spec.mounts.push({
        Type: "bind",
        Source: match[1],
        Destination: match[2],
        RW: !match[3],
        Propagation: "rprivate",
      });
    }
  }
  assert.ok(
    spec.image &&
      spec.name &&
      spec.entrypoint &&
      spec.cmd &&
      spec.workdir &&
      spec.mounts.length > 0,
  );
  assert.ok(
    args.includes("--init") &&
      args.includes("--pull=never") &&
      args.includes("--attach=STDOUT") &&
      args.includes("--attach=STDERR"),
  );
  assert.ok(
    single.has("--platform") && single.has("--network") && single.has("--user"),
  );
  for (const value of [spec.cpus, spec.memory, spec.pids])
    assert.ok(Number.isSafeInteger(value) && value > 0);
  return spec;
}
export function requireGoMountGraph(actual, expected, protectedRoot = null) {
  assert.ok(
    Array.isArray(actual) && actual.length === expected.length,
    "Unexpected native mount count",
  );
  const seen = new Set();
  for (const mount of actual) {
    assert.ok(
      mount && typeof mount.RW === "boolean" && !seen.has(mount.Destination),
      "Malformed or duplicate native mount",
    );
    seen.add(mount.Destination);
    const selected = expected.find(
      (row) => row.Destination === mount.Destination,
    );
    assert.ok(selected, "Unexpected native mount destination");
    for (const key of ["Type", "Source", "Destination", "RW", "Propagation"])
      assert.equal(
        mount[key],
        selected[key],
        "Native mount configuration differs: " + key,
      );
    assert.ok(
      path.isAbsolute(mount.Source) &&
        path.normalize(mount.Source) === mount.Source,
    );
    if (protectedRoot && mount.RW)
      assert.ok(
        !inside(mount.Source, protectedRoot) &&
          !inside(protectedRoot, mount.Source),
        "Writable mount aliases sealed predecessor SDK",
      );
  }
  return actual.map(({ Type, Source, Destination, RW, Propagation }) => ({
    Type,
    Source,
    Destination,
    RW,
    Propagation,
  }));
}
export async function captureGoMountIdentity(root) {
  await physicalPath(root, true);
  const info = await lstat(root, { bigint: true });
  return {
    path: root,
    dev: String(info.dev),
    ino: String(info.ino),
    birthtimeNs: String(info.birthtimeNs),
    uid: String(info.uid),
    gid: String(info.gid),
    mode: String(info.mode),
  };
}
export async function captureGoMountCustody(
  mounts,
  protectedRoot = null,
  expectedProtectedIdentity = null,
) {
  requireGoMountGraph(mounts, mounts, protectedRoot);
  const roots = [];
  for (const mount of mounts)
    roots.push(await captureGoMountIdentity(mount.Source));
  let protectedIdentity = null;
  if (protectedRoot) {
    protectedIdentity = await captureGoMountIdentity(protectedRoot);
    assert.deepEqual(
      protectedIdentity,
      expectedProtectedIdentity,
      "Sealed predecessor physical root changed",
    );
    const protectedAncestors = [];
    for (let at = protectedRoot; ; at = path.dirname(at)) {
      protectedAncestors.push(await captureGoMountIdentity(at));
      if (at === path.dirname(at)) break;
    }
    for (let i = 0; i < mounts.length; i++)
      if (mounts[i].RW) {
        const writable = roots[i];
        assert.ok(
          !protectedAncestors.some(
            (row) => row.dev === writable.dev && row.ino === writable.ino,
          ),
          "Writable physical ancestor aliases sealed predecessor",
        );
        for (let at = mounts[i].Source; ; at = path.dirname(at)) {
          const row = await captureGoMountIdentity(at);
          assert.ok(
            row.dev !== protectedIdentity.dev ||
              row.ino !== protectedIdentity.ino,
            "Writable physical descendant aliases sealed predecessor",
          );
          if (at === path.dirname(at)) break;
        }
      }
  }
  return {
    roots,
    protectedIdentity,
    hardwareOrKernelMountAttestationPerformed: false,
  };
}
export function requireGoContainerConfiguration(
  value,
  spec,
  protectedRoot = null,
) {
  assert.ok(value && id(value.Id));
  assert.equal(value.Name, "/" + spec.name);
  assert.equal(value.Image, spec.imageId);
  const config = value.Config,
    host = value.HostConfig;
  assert.ok(config && host && value.State);
  assert.equal(config.Image, spec.image);
  assert.deepEqual(config.Entrypoint, spec.entrypoint);
  assert.deepEqual(config.Cmd, spec.cmd);
  assert.equal(config.User, "0:0");
  assert.equal(config.WorkingDir, spec.workdir);
  assert.equal(config.Tty, false);
  assert.equal(config.OpenStdin, false);
  assert.equal(config.AttachStdout, true);
  assert.equal(config.AttachStderr, true);
  assert.equal(config.AttachStdin, false);
  assert.deepEqual(envMap(config.Env), spec.env);
  assert.deepEqual(config.Labels, spec.labels);
  assert.ok(config.Volumes == null || Object.keys(config.Volumes).length === 0);
  assert.equal(host.NetworkMode, "none");
  assert.equal(host.Privileged, false);
  assert.equal(host.ContainerIDFile, spec.cidfile);
  assert.equal(host.Init, true);
  assert.equal(host.AutoRemove, false);
  assert.equal(host.ReadonlyRootfs, spec.readonly);
  assert.equal(host.NanoCpus, spec.cpus);
  assert.equal(host.Memory, spec.memory);
  assert.equal(host.PidsLimit, spec.pids);
  assert.deepEqual(host.CapAdd ?? [], spec.capAdd);
  assert.deepEqual(host.CapDrop ?? [], spec.capDrop);
  assert.deepEqual(host.SecurityOpt ?? [], spec.securityOpt);
  for (const key of [
    "Binds",
    "VolumesFrom",
    "Links",
    "Devices",
    "DeviceRequests",
  ])
    assert.ok(
      host[key] == null || (Array.isArray(host[key]) && host[key].length === 0),
      "Unexpected host transport grant: " + key,
    );
  for (const key of ["PortBindings", "Tmpfs"])
    assert.ok(
      host[key] == null || Object.keys(host[key]).length === 0,
      "Unexpected host transport grant: " + key,
    );
  assert.ok(host.PidMode == null || host.PidMode === "");
  assert.ok(host.IpcMode == null || ["", "private"].includes(host.IpcMode));
  assert.ok(host.UTSMode == null || host.UTSMode === "");
  assert.ok(host.UsernsMode == null || host.UsernsMode === "");
  assert.equal(host.PublishAllPorts, false);
  assert.equal(host.RestartPolicy.Name, "no");
  assert.ok(
    Array.isArray(host.Mounts) && host.Mounts.length === spec.mounts.length,
    "Unexpected requested mount count",
  );
  for (const mount of host.Mounts) {
    assert.ok(
      mount.ReadOnly === undefined || typeof mount.ReadOnly === "boolean",
      "Malformed requested read-only mount flag",
    );
    assert.ok(mount.Consistency == null || mount.Consistency === "");
    assert.ok(
      mount.VolumeOptions == null &&
        mount.TmpfsOptions == null &&
        mount.ImageOptions == null,
    );
    if (mount.BindOptions)
      for (const [key, value] of Object.entries(mount.BindOptions)) {
        assert.ok(
          key === "Propagation"
            ? value === "rprivate" || value === ""
            : [
                "NonRecursive",
                "CreateMountpoint",
                "ReadOnlyNonRecursive",
                "ReadOnlyForceRecursive",
              ].includes(key) && value === false,
          "Unexpected requested bind option",
        );
      }
  }
  const requested = host.Mounts.map((row) => ({
    Type: row.Type,
    Source: row.Source,
    Destination: row.Target,
    RW: !row.ReadOnly,
    Propagation: row.BindOptions?.Propagation || "rprivate",
  }));
  requireGoMountGraph(requested, spec.mounts, protectedRoot);
  const mounts = requireGoMountGraph(value.Mounts, spec.mounts, protectedRoot);
  return {
    containerId: value.Id,
    configurationSha256: sha256(JSON.stringify(value)),
    mounts,
    hostConfiguration: host,
    containerConfiguration: config,
    hardwareOrIsolationAttestationPerformed: false,
  };
}
function inspect(result) {
  assert.ok(succeeded(result.terminal), "Container inspect transport failed");
  const rows = JSON.parse(result.text);
  assert.ok(
    Array.isArray(rows) && rows.length === 1,
    "Malformed native container inspection",
  );
  return rows[0];
}
// invoke retains each actual physical client result before returning; no native body is admitted before inspect/custody checks.
export async function runGoContainerTransport({
  args,
  spec,
  protectedRoot,
  custody,
  invoke,
  cleanup,
  record,
  now = Date.now,
  deadline,
}) {
  let failure, answer;
  const remaining = () => {
    const value = deadline - now();
    assert.ok(
      value > 0,
      "Original command or external observation budget expired before native start",
    );
    return value;
  };
  try {
    const created = await invoke("create", args, Math.min(15000, remaining()));
    assert.ok(
      succeeded(created.terminal),
      "Container creation transport failed",
    );
    const containerId = created.text.trim();
    assert.ok(id(containerId), "Malformed created container identity");
    const beforeRaw = await invoke(
      "inspect-before-start",
      ["inspect", containerId],
      Math.min(15000, remaining()),
    );
    const before = inspect(beforeRaw);
    assert.equal(before.Id, containerId);
    const configuration = requireGoContainerConfiguration(
      before,
      spec,
      protectedRoot,
    );
    assert.equal(before.State.Status, "created");
    assert.equal(before.State.Running, false);
    assert.equal(before.State.Pid, 0);
    await custody();
    await record({
      phase: "before-start",
      rawConfigurationSha256: sha256(beforeRaw.text),
      ...configuration,
    });
    const started = await invoke(
      "start-attached",
      ["start", "--attach", containerId],
      remaining(),
    );
    // Never infer native success from the client's exit or a created container's default ExitCode.
    const afterRaw = await invoke(
      "inspect-after-terminal",
      ["inspect", containerId],
      15000,
      true,
    );
    const after = inspect(afterRaw);
    assert.equal(after.Id, containerId);
    requireGoContainerConfiguration(after, spec, protectedRoot);
    assert.equal(after.State.Status, "exited");
    assert.equal(after.State.Running, false);
    assert.ok(
      Number.isInteger(after.State.ExitCode) && after.State.ExitCode >= 0,
    );
    assert.ok(
      Date.parse(after.State.StartedAt) > 0 &&
        Date.parse(after.State.FinishedAt) >= Date.parse(after.State.StartedAt),
      "Native start and terminal observations unavailable",
    );
    assert.equal(after.State.OOMKilled, false);
    assert.equal(after.State.Error, "");
    await custody();
    await record({
      phase: "after-terminal",
      rawConfigurationSha256: sha256(afterRaw.text),
      state: after.State,
    });
    assert.equal(
      started.terminal.exitCode,
      after.State.ExitCode,
      "Docker attached client and actual native terminal differ",
    );
    assert.equal(started.terminal.signal, null);
    assert.equal(started.terminal.reason, null);
    assert.equal(started.terminal.stopError, null);
    answer = {
      ...started,
      nativeState: after.State,
      prestartConfiguration: configuration,
    };
  } catch (error) {
    failure = error;
  } finally {
    try {
      await cleanup();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return answer;
}
