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
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  [void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $serializer = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $serializer.MaxJsonLength = 32768
  $serializer.RecursionLimit = 8
  $request = $serializer.DeserializeObject([Console]::In.ReadToEnd())
  if ($request.kind -ne 'directory' -and $request.kind -ne 'file') { throw 'invalid kind' }
  if ($request.kind -eq 'directory') { $item = [System.IO.DirectoryInfo]::new($request.path) }
  else { $item = [System.IO.FileInfo]::new($request.path) }
  if (!$item.Exists) { throw 'missing object' }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
  if ([bool]($item.Attributes -band [System.IO.FileAttributes]::Directory) -ne ($request.kind -eq 'directory')) { throw 'wrong type' }
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  if ($request.created) {
    if ($request.kind -eq 'directory') { $acl = [System.Security.AccessControl.DirectorySecurity]::new() }
    else { $acl = [System.Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true, $false)
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
    if ($request.kind -eq 'directory') { $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit }
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity.User, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
    $item.SetAccessControl($acl)
  }
  $acl = $item.GetAccessControl()
  $rules = [System.Collections.Generic.List[object]]::new()
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $rules.Add([ordered]@{sid=$rule.IdentityReference.Value;rights=[int]$rule.FileSystemRights;inheritance=[int]$rule.InheritanceFlags;propagation=[int]$rule.PropagationFlags;type=$rule.AccessControlType.ToString()})
  }
  $observed = [ordered]@{userSid=$identity.User.Value;tokenOwnerSid=$identity.Owner.Value;ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;protected=$acl.AreAccessRulesProtected;canonical=$acl.AreAccessRulesCanonical;rules=$rules.ToArray()}
  [Console]::Out.WriteLine($serializer.Serialize($observed))
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
