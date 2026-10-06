import assert from "node:assert/strict";
import { test } from "node:test";
import { readNativeProcCommand } from "./native-process-observer.js";
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
