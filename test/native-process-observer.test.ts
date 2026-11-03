import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readNativeProcCommand,
  readNativeProcParentPhase,
  nativeProcessDiagnostic,
} from "./native-process-observer.js";
const denied = (code: string) =>
  Object.assign(new Error("original synthetic proc failure"), { code });
test("native process observer excludes unrelated inaccessible and wrong executable identities without crediting a body", async () => {
  const executable = "/usr/local/bin/kubeconform",
    calls: string[] = [];
  const unrelated = await readNativeProcCommand("17", executable, {
    readText: async (file) => {
      calls.push(file);
      return "node\0unrelated.js\0";
    },
    readLink: async (file) => {
      calls.push(file);
      throw denied("EACCES");
    },
  });
  assert.equal(unrelated, null);
  assert.deepEqual(calls, ["/proc/17/cmdline"]);
  for (const code of ["ENOENT", "ESRCH", "EACCES"]) {
    assert.equal(
      await readNativeProcCommand("17", executable, {
        readText: async () => {
          throw denied(code);
        },
        readLink: async () => executable,
      }),
      null,
      code,
    );
    assert.equal(
      await readNativeProcCommand("17", executable, {
        readText: async () => "kubeconform\0-strict\0",
        readLink: async () => {
          throw denied(code);
        },
      }),
      null,
      code,
    );
  }
  assert.equal(
    await readNativeProcCommand("17", executable, {
      readText: async () => "kubeconform\0-strict\0",
      readLink: async () => "/unverified/kubeconform",
    }),
    null,
  );
  for (const identifier of ["kubeconform-extra", "prefix-kubeconform", ""])
    assert.equal(
      await readNativeProcCommand("17", executable, {
        readText: async () => identifier + "\0-strict\0",
        readLink: async () => executable,
      }),
      null,
      identifier,
    );
});
test("native process observer retains exact native command arguments and propagates unexplained IO failures", async () => {
  const executable = "/usr/local/bin/terraform",
    calls: string[] = [];
  for (const argv0 of [executable, "terraform"]) {
    const command = await readNativeProcCommand("23", executable, {
      readText: async (file) => {
        calls.push(file);
        return argv0 + "\0validate\0-json\0";
      },
      readLink: async (file) => {
        calls.push(file);
        return executable;
      },
    });
    assert.deepEqual(command, [argv0, "validate", "-json", ""]);
  }
  assert.deepEqual(calls, [
    "/proc/23/cmdline",
    "/proc/23/exe",
    "/proc/23/cmdline",
    "/proc/23/exe",
  ]);
  const error = denied("EIO");
  await assert.rejects(
    readNativeProcCommand("23", executable, {
      readText: async () => {
        throw error;
      },
      readLink: async () => executable,
    }),
    (observed) => observed === error,
  );
});

test("native parent diagnostic distinguishes exact source and installed probe phases without exposing arguments", async () => {
  const node = "/usr/local/bin/node",
    root = "/private-original-source-canary";
  const stat = (pid: string, parent: string, start: string) =>
    `${pid} (original) S ${parent} ${Array(17).fill("0").join(" ")} ${start} 0`;
  for (const runner of [
    "/workspace/dist/src/terraform-runner.js",
    "/consumer/node_modules/@stsepelin/checktrail/dist/src/terraform-runner.js",
  ]) {
    const expected = {
      nodeInvocation: node,
      nodeExecutable: node,
      runner,
      root,
    };
    for (const [suffix, phase] of [
      [[], "validation-command"],
      [["--version"], "tool-version-probe"],
      [["--version-extra"], "unrecognized-parent"],
      [["prefix--version"], "unrecognized-parent"],
      [["--version", "extra"], "unrecognized-parent"],
    ] as const) {
      const args = [
        node,
        runner,
        root,
        '{"source":"PRIVATE_ORIGINAL_ARGUMENT_CANARY"}',
        ...suffix,
      ];
      const result = await readNativeProcParentPhase("23", expected, {
        readText: async (file) =>
          file === "/proc/23/stat"
            ? stat("23", "17", "101")
            : file === "/proc/17/stat"
              ? stat("17", "1", "99")
              : args.join(String.fromCharCode(0)) + String.fromCharCode(0),
        readLink: async () => node,
      });
      assert.deepEqual(result, { phase, nativePid: 23, parentPid: 17 });
      assert.doesNotMatch(
        JSON.stringify(result),
        /PRIVATE_ORIGINAL|private-original|terraform-runner|workspace|consumer/,
      );
    }
    for (const changed of ["node", "runner", "root", "exe"] as const) {
      const args = [node, runner, root, "{}", "--version"];
      if (changed === "node") args[0] = "/adjacent/node";
      if (changed === "runner")
        args[1] = runner.replace(
          "terraform-runner.js",
          "terraform-runner-extra.js",
        );
      if (changed === "root") args[2] += "-adjacent";
      const result = await readNativeProcParentPhase("23", expected, {
        readText: async (file) =>
          file === "/proc/23/stat"
            ? stat("23", "17", "101")
            : file === "/proc/17/stat"
              ? stat("17", "1", "99")
              : args.join(String.fromCharCode(0)) + String.fromCharCode(0),
        readLink: async () => (changed === "exe" ? "/adjacent/node" : node),
      });
      assert.equal(result.phase, "unrecognized-parent", changed);
    }
  }
});

test("native parent diagnostic refuses changed identities and bounds unreadable or oversized metadata without replacing an acceptance failure", async () => {
  const expected = {
    nodeInvocation: "/node",
    nodeExecutable: "/node",
    runner: "/runner",
    root: "/root",
  };
  const stat = (pid: string, parent: string, start: string) =>
    `${pid} (original) S ${parent} ${Array(17).fill("0").join(" ")} ${start} 0`;
  for (const changed of ["child", "parent"] as const) {
    let childReads = 0,
      parentReads = 0;
    const result = await readNativeProcParentPhase("23", expected, {
      readText: async (file) =>
        file === "/proc/23/stat"
          ? stat(
              "23",
              "17",
              changed === "child" && ++childReads > 1 ? "102" : "101",
            )
          : file === "/proc/17/stat"
            ? stat(
                "17",
                "1",
                changed === "parent" && ++parentReads > 1 ? "100" : "99",
              )
            : ["/node", "/runner", "/root", "{}", "--version", ""].join(
                String.fromCharCode(0),
              ),
      readLink: async () => "/node",
    });
    assert.equal(result.phase, "identity-changed", changed);
  }
  for (const code of ["ENOENT", "ESRCH", "EACCES", "EIO"]) {
    const result = await readNativeProcParentPhase("23", expected, {
      readText: async () => {
        throw Object.assign(Error("PRIVATE_ORIGINAL_IO_CANARY"), { code });
      },
      readLink: async () => "/node",
    });
    assert.equal(result.phase, code === "EIO" ? "read-error" : "unavailable");
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ORIGINAL/);
  }
  const nul = String.fromCharCode(0);
  const prefix = ["/node", "/runner", "/root", '{"source":"'].join(nul);
  const suffix = '"}' + nul + "--version" + nul;
  const overhead = Buffer.byteLength(prefix + suffix);
  for (const character of ["x", "é"]) {
    for (const bytes of [256 * 1024, 256 * 1024 + 1]) {
      const contentBytes = bytes - overhead;
      const width = Buffer.byteLength(character);
      const raw =
        prefix +
        character.repeat(Math.floor(contentBytes / width)) +
        "x".repeat(contentBytes % width) +
        suffix;
      assert.equal(Buffer.byteLength(raw), bytes);
      assert.ok(raw.endsWith(nul));
      const result = await readNativeProcParentPhase("23", expected, {
        readText: async (file) =>
          file === "/proc/23/stat"
            ? stat("23", "17", "101")
            : file === "/proc/17/stat"
              ? stat("17", "1", "99")
              : raw,
        readLink: async () => "/node",
      });
      assert.equal(
        result.phase,
        bytes === 256 * 1024 ? "tool-version-probe" : "unrecognized-parent",
        JSON.stringify({ character, bytes }),
      );
    }
  }
});

test("native cancellation diagnostic retains fixed terminal flags without serializing private output or command fields", () => {
  const value = {
    exitCode: null,
    signal: "SIGTERM",
    cancelled: true,
    timedOut: false,
    stdout: "PRIVATE_ORIGINAL_OUTPUT_CANARY",
    stderr: "PRIVATE_ORIGINAL_ERROR_CANARY",
    command: {
      executable: "/private-original",
      args: ["PRIVATE_ORIGINAL_ARG_CANARY"],
    },
  };
  assert.deepEqual(nativeProcessDiagnostic(value), {
    present: true,
    exitCode: null,
    signal: "SIGTERM",
    cancelled: true,
    timedOut: false,
  });
  assert.doesNotMatch(
    JSON.stringify(nativeProcessDiagnostic(value)),
    /PRIVATE_ORIGINAL|private-original|stdout|stderr|args|command/,
  );
  assert.deepEqual(nativeProcessDiagnostic(), {
    present: false,
    exitCode: null,
    signal: null,
    cancelled: false,
    timedOut: false,
  });
  assert.equal(
    nativeProcessDiagnostic({ signal: "PRIVATE_ORIGINAL_SIGNAL_CANARY" })
      .signal,
    null,
  );
});
