import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { windowsEnvironment } from "./windows-process.js";

const sid = z
  .string()
  .min(5)
  .max(184)
  .regex(/^S-1-\d+(?:-\d+){1,15}$/);
const accessSchema = z.strictObject({
  userSid: sid,
  tokenOwnerSid: sid,
  ownerSid: sid,
  protected: z.boolean(),
  canonical: z.boolean(),
  rules: z
    .array(
      z.strictObject({
        sid,
        rights: z.number().int(),
        inheritance: z.number().int(),
        propagation: z.number().int(),
        type: z.enum(["Allow", "Deny"]),
      }),
    )
    .length(1),
});

/** Validate OS-observed ACL data; these are not accepted from MCP or a project. */
export function validateWindowsTaskAccess(
  value: unknown,
  kind: "file" | "directory",
): void {
  const acl = accessSchema.parse(value);
  const rule = acl.rules[0]!;
  if (
    !acl.canonical ||
    // An arbitrary owner group could grant its other members owner rights. Only
    // the caller or the privileged built-in Administrators token owner is selected.
    (acl.tokenOwnerSid !== acl.userSid &&
      acl.tokenOwnerSid !== "S-1-5-32-544") ||
    (kind === "directory" && !acl.protected) ||
    (acl.ownerSid !== acl.userSid && acl.ownerSid !== acl.tokenOwnerSid) ||
    rule.sid !== acl.userSid ||
    rule.type !== "Allow" ||
    rule.rights !== 2032127 ||
    rule.inheritance !== (kind === "directory" ? 3 : 0) ||
    rule.propagation !== 0
  )
    throw new Error("Windows task storage requires a private caller-only ACL");
}

// Fixed shipped OS inspection, with no profile, project script, path interpolation
// or external commands. New empty objects receive private ACLs before data writes;
// pre-existing objects are inspected and never repaired implicitly.
const accessScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($request.kind -ne 'directory' -and $request.kind -ne 'file') { throw 'invalid kind' }
  $item = Get-Item -LiteralPath $request.path -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
  if ([bool]$item.PSIsContainer -ne ($request.kind -eq 'directory')) { throw 'wrong type' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($request.created) {
    if ($request.kind -eq 'directory') { $acl = New-Object System.Security.AccessControl.DirectorySecurity }
    else { $acl = New-Object System.Security.AccessControl.FileSecurity }
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($request.kind -eq 'directory') { $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $request.path -AclObject $acl
  }
  $acl = Get-Acl -LiteralPath $request.path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [ordered]@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;type=$_.AccessControlType.ToString()}
  })
  [ordered]@{userSid=$identity.User.Value;tokenOwnerSid=$identity.Owner.Value;ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;canonical=$acl.AreAccessRulesCanonical;rules=@($rules)} | ConvertTo-Json -Depth 4 -Compress
} catch {
  [Console]::Error.WriteLine('Windows task ACL inspection unavailable')
  exit 1
}
`;

export function ensureWindowsTaskAccess(
  filename: string,
  kind: "file" | "directory",
  created: boolean,
): void {
  if (process.platform !== "win32")
    throw new Error("Windows task ACL inspection requires Windows");
  if (!/^[A-Za-z]:\\/.test(filename) || /[\0\r\n]/.test(filename))
    throw new Error(
      "Windows task storage requires a canonical local-drive path",
    );
  if (
    realpathSync(filename).toLowerCase() !==
      path.win32.normalize(filename).toLowerCase() ||
    lstatSync(filename).isSymbolicLink()
  )
    throw new Error("Windows task storage rejects linked paths");
  const environment = windowsEnvironment(process.env);
  const systemRoot = environment.SYSTEMROOT;
  if (!systemRoot || !/^[A-Za-z]:\\/.test(systemRoot))
    throw new Error("Windows task ACL inspector unavailable");
  const selected = path.win32.join(
    systemRoot,
    "System32/WindowsPowerShell/v1.0/powershell.exe",
  );
  const executable = realpathSync(selected);
  if (
    executable.toLowerCase() !== selected.toLowerCase() ||
    !lstatSync(executable).isFile()
  )
    throw new Error("Windows task ACL inspector unavailable");
  let observed: unknown;
  try {
    const output = execFileSync(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(accessScript, "utf16le").toString("base64"),
      ],
      {
        encoding: "utf8",
        input: JSON.stringify({ path: filename, kind, created }),
        env: { SYSTEMROOT: systemRoot },
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 32768,
      },
    );
    observed = JSON.parse(output.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Windows task ACL inspection unavailable");
  }
  validateWindowsTaskAccess(observed, kind);
}
