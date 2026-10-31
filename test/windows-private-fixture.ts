import { execFileSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import path from "node:path";
import { ensureWindowsTaskAccess } from "../src/windows-task-access.js";

// Test-owned fixtures only. Deliberately granting public access proves refusal;
// production inspection never calls this fixture repair/grant helper.
export async function setPrivateFixtureAccess(
  filename: string,
  kind: "file" | "directory",
  privateAccess = true,
) {
  if (process.platform !== "win32") {
    await chmod(
      filename,
      kind === "directory"
        ? privateAccess
          ? 0o700
          : 0o755
        : privateAccess
          ? 0o600
          : 0o644,
    );
    return;
  }
  if (privateAccess) {
    ensureWindowsTaskAccess(filename, kind, true);
    return;
  }
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$serializer=[System.Web.Script.Serialization.JavaScriptSerializer]::new()
$serializer.MaxJsonLength=32768
$serializer.RecursionLimit=8
$request=$serializer.DeserializeObject([Console]::In.ReadToEnd())
if ($request.kind -eq 'directory') { $item=[System.IO.DirectoryInfo]::new($request.path) }
else { $item=[System.IO.FileInfo]::new($request.path) }
$acl=$item.GetAccessControl()
$inheritance=[System.Security.AccessControl.InheritanceFlags]::None
if ($request.kind -eq 'directory') { $inheritance=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::ReadAndExecute,$inheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
$item.SetAccessControl($acl)
`;
  execFileSync(
    path.join(
      process.env.SystemRoot ?? process.env.SYSTEMROOT!,
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path: filename, kind }),
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 32768,
      windowsHide: true,
    },
  );
}
