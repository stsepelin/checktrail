import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  ensureWindowsTaskAccess,
  validateWindowsTaskAccess,
} from "../src/windows-task-access.js";
import { openTaskStore } from "../src/task-store.js";
import { fixture, nodeManifest, passingTest } from "./helpers.js";

const user = "S-1-5-21-10-20-30-1001";
const tokenOwner = "S-1-5-32-544";
function observed(kind: "file" | "directory" = "directory") {
  return {
    userSid: user,
    tokenOwnerSid: tokenOwner,
    ownerSid: user,
    protected: true,
    canonical: true,
    rules: [
      {
        sid: user,
        rights: 2032127,
        inheritance: kind === "directory" ? 3 : 0,
        propagation: 0,
        type: "Allow",
      },
    ],
  };
}

test("Windows task ACL validation admits only the exact caller rule and actual caller or token owner", () => {
  validateWindowsTaskAccess(observed(), "directory");
  validateWindowsTaskAccess(
    { ...observed(), tokenOwnerSid: user },
    "directory",
  );
  validateWindowsTaskAccess({ ...observed("file"), protected: false }, "file");
  validateWindowsTaskAccess(
    { ...observed("file"), ownerSid: tokenOwner },
    "file",
  );
  validateWindowsTaskAccess(
    { ...observed(), ownerSid: tokenOwner },
    "directory",
  );
});

test("Windows task ACL validation refuses each private-access boundary independently", () => {
  const base = observed();
  for (const invalid of [
    { ...base, canonical: false },
    { ...base, protected: false },
    { ...base, ownerSid: "S-1-5-21-10-20-30-1002" },
    { ...base, tokenOwnerSid: "S-1-5-32-545" },
    { ...base, tokenOwnerSid: "S-1-5-32-545", ownerSid: "S-1-5-32-545" },
    { ...base, rules: [] },
    { ...base, rules: [...base.rules, { ...base.rules[0], sid: "S-1-1-0" }] },
    { ...base, rules: [{ ...base.rules[0], sid: tokenOwner }] },
    { ...base, rules: [{ ...base.rules[0], sid: user + "-7" }] },
    { ...base, rules: [{ ...base.rules[0], rights: 1179785 }] },
    { ...base, rules: [{ ...base.rules[0], rights: 2032128 }] },
    { ...base, rules: [{ ...base.rules[0], type: "Deny" }] },
    { ...base, rules: [{ ...base.rules[0], inheritance: 0 }] },
    { ...base, rules: [{ ...base.rules[0], inheritance: 1 }] },
    { ...base, rules: [{ ...base.rules[0], propagation: 1 }] },
    { ...base, rules: [{ ...base.rules[0], propagation: 2 }] },
    { ...base, rules: [{ ...base.rules[0], unexpected: true }] },
    { ...base, unexpected: true },
    { ...base, userSid: null },
    { ...base, tokenOwnerSid: null },
    { ...base, canonical: "true" },
    { ...base, ownerSid: "not-a-sid" },
  ])
    assert.throws(
      () => validateWindowsTaskAccess(invalid, "directory"),
      JSON.stringify(invalid),
    );
  assert.throws(() => validateWindowsTaskAccess(observed(), "file"));
  assert.throws(() =>
    validateWindowsTaskAccess(
      {
        ...observed("file"),
        rules: [{ ...observed("file").rules[0], propagation: 1 }],
      },
      "file",
    ),
  );
});

test(
  "Windows task ACL inspection remains unavailable on a non-Windows host",
  { skip: process.platform === "win32" },
  () => {
    assert.throws(
      () =>
        ensureWindowsTaskAccess("C:\\original-synthetic", "directory", false),
      /requires Windows/,
    );
  },
);

const native = process.platform === "win32";
function changeAcl(filename: string) {
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$acl=Get-Acl -LiteralPath $request.path
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $request.path -AclObject $acl
`;
  const executable = path.join(
    process.env.SystemRoot ?? process.env.SYSTEMROOT!,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  execFileSync(
    executable,
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path: filename }),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 32768,
      windowsHide: true,
    },
  );
}

test(
  "native Windows task storage uses private ACLs for literal Unicode paths and native SQLite owner journals",
  { skip: !native },
  async (t) => {
    const root = await realpath(
      await fixture(t, {
        "package.json": nodeManifest,
        "value.test.js": passingTest,
      }),
    );
    const parent = await realpath(await fixture(t, {}));
    const directory = path.join(parent, "original-'[literal]-🧪");
    const first = await openTaskStore({ root, directory });
    first.close();
    ensureWindowsTaskAccess(directory, "directory", false);
    ensureWindowsTaskAccess(
      path.join(directory, "owner.sqlite"),
      "file",
      false,
    );
    ensureWindowsTaskAccess(
      path.join(directory, "tasks.sqlite"),
      "file",
      false,
    );
    await writeFile(path.join(directory, "tasks.sqlite-journal"), "");
    ensureWindowsTaskAccess(
      path.join(directory, "tasks.sqlite-journal"),
      "file",
      false,
    );
    const second = await openTaskStore({ root, directory });
    second.close();
  },
);

test(
  "native Windows task storage refuses a publicly readable directory without changing its ACL or creating a database",
  { skip: !native },
  async (t) => {
    const root = await realpath(
      await fixture(t, {
        "package.json": nodeManifest,
        "value.test.js": passingTest,
      }),
    );
    const parent = await realpath(await fixture(t, {}));
    const directory = path.join(parent, "original-public");
    await mkdir(directory);
    ensureWindowsTaskAccess(directory, "directory", true);
    changeAcl(directory);
    assert.throws(() => ensureWindowsTaskAccess(directory, "directory", false));
    await assert.rejects(openTaskStore({ root, directory }));
    assert.throws(
      () => ensureWindowsTaskAccess(directory, "directory", false),
      "Refusal must preserve the existing ACL",
    );
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(directory), []);
  },
);
