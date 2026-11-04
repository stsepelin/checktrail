import { readNativeProcCommand } from "./native-process-observer.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readFile,
  readlink,
  readdir,
  mkdtemp,
  rm,
  writeFile,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "../src/engine.js";
import {
  terraformFixture,
  terraformNative,
  terraformRewrite,
} from "./terraform-fixture.js";
const runner = fileURLToPath(
  new URL("../src/terraform-runner.js", import.meta.url),
);
const nativeIo = {
  readText: (file: string) => readFile(file, "utf8"),
  readLink: (file: string) => readlink(file),
};
const statIdentity = (text: string, pid: string) => {
  if (!text.startsWith(pid + " (") || !text.includes(") ")) return null;
  const fields = text.slice(text.lastIndexOf(") ") + 2).split(" ");
  if (
    !/^[1-9]\d*$/.test(fields[1] ?? "") ||
    !/^[1-9]\d*$/.test(fields[19] ?? "") ||
    ["Z", "X", "x"].includes(fields[0] ?? "")
  )
    return null;
  return { parent: fields[1]!, start: fields[19]! };
};

/** Native argv alone cannot distinguish tool collection from validation's own version probe. */
async function readTerraformProcess(
  pid: string,
  owner: string,
  projectRoot: string,
  version = false,
  io = nativeIo,
) {
  if (!/^[1-9]\d*$/.test(pid)) return null;
  try {
    const args = await readNativeProcCommand(
      pid,
      "/usr/local/bin/terraform",
      io,
    );
    const expected = version
      ? ["version", "-json", ""]
      : ["validate", "-json", "-no-color", ""];
    if (!args || args.slice(1).join("\0") !== expected.join("\0")) return null;
    const workspace = await io.readLink(`/proc/${pid}/cwd`);
    if (
      !workspace.startsWith(owner + path.sep) ||
      !workspace.endsWith("/native")
    )
      return null;
    const before = statIdentity(await io.readText(`/proc/${pid}/stat`), pid);
    if (!before) return null;
    const parent = await readNativeProcCommand(
      before.parent,
      process.execPath,
      io,
    );
    if (
      !parent ||
      parent[1] !== runner ||
      parent[2] !== projectRoot ||
      parent.length !== (version ? 6 : 5) ||
      parent.at(-1) !== "" ||
      (version && parent[4] !== "--version")
    )
      return null;
    const after = statIdentity(await io.readText(`/proc/${pid}/stat`), pid);
    if (
      !after ||
      after.parent !== before.parent ||
      after.start !== before.start
    )
      return null;
    if ((await io.readLink(`/proc/${pid}/cwd`)) !== workspace) return null;
    return { pid: Number(pid), start: before.start, workspace };
  } catch (error) {
    if (
      ["ENOENT", "ESRCH", "EACCES"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return null;
    throw error;
  }
}

async function reached(owner: string, projectRoot: string, version = false) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const pid of await readdir("/proc")) {
      const observed = await readTerraformProcess(
        pid,
        owner,
        projectRoot,
        version,
      );
      if (observed) return observed;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(
    "Actual native validator body in the selected runner phase was not observed",
  );
}
async function exercise(
  t: Parameters<typeof terraformFixture>[0],
  mode: "cancel" | "source" | "document" | "version",
) {
  const root = await terraformFixture(t);
  for (const file of ["main.tf.json", "support.tf.json"])
    await terraformRewrite(root, file, (p) => {
      const locals = (p.locals ?? {}) as Record<string, string>;
      for (let i = 0; i < 120; i++)
        locals[
          (file === "main.tf.json"
            ? "original_scale_main_"
            : "original_scale_support_") + i
        ] =
          i === 0
            ? "${var.original_count + 1}"
            : "${local." +
              (file === "main.tf.json"
                ? "original_scale_main_"
                : "original_scale_support_") +
              (i - 1) +
              " + 1}";
      p.locals = locals;
    });
  const owner = await mkdtemp(
      path.join(tmpdir(), "original-terraform-reached-"),
    ),
    previous = process.env.TMPDIR,
    controller = new AbortController();
  process.env.TMPDIR = owner;
  const running = validate(root, {
    trusted: true,
    timeoutMs: 120000,
    signal: controller.signal,
  });
  try {
    const native = await reached(owner, root, mode === "version");
    assert.ok(
      native.pid > 0 && native.start.length > 0,
      "Real pinned Terraform validation reached before steering execution",
    );
    if (mode === "cancel" || mode === "version") controller.abort();
    else {
      const file =
        mode === "source"
          ? path.join(root, "main.tf.json")
          : path.join(native.workspace, "main.tf.json");
      await writeFile(file, (await readFile(file, "utf8")) + "\n");
    }
    const report = await running;
    assert.equal(report.outcome, "incomplete", JSON.stringify(report.checks));
    if (mode === "cancel")
      assert.ok(report.checks[0]!.processes.some((p) => p.cancelled));
    else if (mode === "version")
      assert.ok(
        report.checks[0]!.tools?.some(
          (t) => t.name === "terraform" && t.process?.cancelled,
        ),
      );
    else assert.equal(report.sourceChanged, mode === "source");
    await assert.rejects(access(native.workspace), { code: "ENOENT" });
    assert.deepEqual(await readdir(owner), []);
    try {
      const stat = await readFile(`/proc/${native.pid}/stat`, "utf8");
      const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      assert.notEqual(
        start,
        native.start,
        "Observed native validator survived completion/cancellation",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } finally {
    controller.abort();
    await running;
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(owner, { recursive: true, force: true });
  }
}
test(
  "native Terraform cancellation observes the real validator body and removes its process and owned outputs",
  terraformNative,
  async (t) => exercise(t, "cancel"),
);
test(
  "native Terraform source changed after the real validator starts invalidates the execution",
  terraformNative,
  async (t) => exercise(t, "source"),
);
test(
  "native Terraform copied module changed after the real validator starts invalidates unchanged original source",
  terraformNative,
  async (t) => exercise(t, "document"),
);

test(
  "native Terraform cancellation during version collection observes the actual native process and removes fresh outputs",
  terraformNative,
  async (t) => exercise(t, "version"),
);

function observerFixture(version: boolean) {
  const pid = "71",
    parent = "23",
    owner = "/synthetic/owned",
    root = "/synthetic/project";
  const fields = Array<string>(20).fill("0");
  fields[0] = "S";
  fields[1] = parent;
  fields[19] = "8123";
  const stat = () => pid + " (terraform) " + fields.join(" ");
  const values = new Map([
    [
      `/proc/${pid}/cmdline`,
      [
        "/usr/local/bin/terraform",
        ...(version
          ? ["version", "-json"]
          : ["validate", "-json", "-no-color"]),
        "",
      ].join("\0"),
    ],
    [`/proc/${pid}/exe`, "/usr/local/bin/terraform"],
    [`/proc/${pid}/cwd`, owner + "/command/terraform/native"],
    [`/proc/${pid}/stat`, stat()],
    [
      `/proc/${parent}/cmdline`,
      [
        process.execPath,
        fileURLToPath(new URL("../src/terraform-runner.js", import.meta.url)),
        root,
        JSON.stringify({ inputs: [] }),
        ...(version ? ["--version"] : []),
        "",
      ].join("\0"),
    ],
    [`/proc/${parent}/exe`, process.execPath],
  ]);
  const read = async (file: string) => {
    const value = values.get(file);
    assert.notEqual(value, undefined, file);
    return value!;
  };
  return {
    pid,
    parent,
    owner,
    root,
    fields,
    stat,
    values,
    io: { readText: read, readLink: read },
  };
}

test("Terraform native process observer binds exact tool-collection and validation parent phases with native identity and current owned workspace", async () => {
  for (const version of [true, false]) {
    const control = observerFixture(version);
    assert.deepEqual(
      await readTerraformProcess(
        control.pid,
        control.owner,
        control.root,
        version,
        control.io,
      ),
      {
        pid: 71,
        start: "8123",
        workspace: control.owner + "/command/terraform/native",
      },
    );
    // The same version command also runs inside validation. It is not a tool-collection witness.
    const parentCommand = control.values.get(
      `/proc/${control.parent}/cmdline`,
    )!;
    control.values.set(
      `/proc/${control.parent}/cmdline`,
      version
        ? parentCommand.replace("--version\0", "")
        : parentCommand.replace(/\0$/, "\0--version\0"),
    );
    assert.equal(
      await readTerraformProcess(
        control.pid,
        control.owner,
        control.root,
        version,
        control.io,
      ),
      null,
    );
  }
});

test("Terraform native process observer rejects phase suffixes unrelated runner identities workspace aliases and processes that exit or change parent before admission", async () => {
  const controls = [
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(
        `/proc/${c.parent}/cmdline`,
        c.values
          .get(`/proc/${c.parent}/cmdline`)!
          .replace("--version\0", "--version-extra\0"),
      ),
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(
        `/proc/${c.parent}/cmdline`,
        c.values
          .get(`/proc/${c.parent}/cmdline`)!
          .replace("terraform-runner.js", "terraform-runner.js-extra"),
      ),
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(
        `/proc/${c.parent}/cmdline`,
        c.values
          .get(`/proc/${c.parent}/cmdline`)!
          .replace(c.root, c.root + "-other"),
      ),
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(`/proc/${c.parent}/exe`, process.execPath + "-other"),
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(`/proc/${c.pid}/exe`, "/unverified/terraform"),
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(
        `/proc/${c.pid}/cmdline`,
        c.values
          .get(`/proc/${c.pid}/cmdline`)!
          .replace("version\0", "version-extra\0"),
      ),
    (c: ReturnType<typeof observerFixture>) =>
      c.values.set(`/proc/${c.pid}/cwd`, c.owner + "-other/terraform/native"),
    (c: ReturnType<typeof observerFixture>) => {
      c.fields[0] = "Z";
      c.values.set(`/proc/${c.pid}/stat`, c.stat());
    },
  ];
  for (const change of controls) {
    const c = observerFixture(true);
    change(c);
    assert.equal(
      await readTerraformProcess(c.pid, c.owner, c.root, true, c.io),
      null,
    );
  }
  for (const field of [1, 19]) {
    const c = observerFixture(true);
    let reads = 0;
    const io = {
      ...c.io,
      readText: async (file: string) => {
        if (file === `/proc/${c.pid}/stat` && ++reads === 2) {
          c.fields[field] = "999";
          return c.stat();
        }
        return c.io.readText(file);
      },
    };
    assert.equal(
      await readTerraformProcess(c.pid, c.owner, c.root, true, io),
      null,
    );
    assert.equal(
      reads,
      2,
      "The process identity must be checked again after its parent phase",
    );
  }
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EIO"]) {
    const c = observerFixture(true),
      error = Object.assign(new Error("Authored proc read failure"), { code });
    const io = {
      ...c.io,
      readLink: async (file: string) => {
        if (file.endsWith("/cwd")) throw error;
        return c.io.readLink(file);
      },
    };
    const observation = readTerraformProcess(c.pid, c.owner, c.root, true, io);
    if (code === "EIO")
      await assert.rejects(observation, (observed) => observed === error);
    else assert.equal(await observation, null, code);
  }
});
