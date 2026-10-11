import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
const request = "  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json";
const failure =
  "  [Console]::Error.WriteLine('Windows task ACL inspection unavailable')";
const points = [
  [
    "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
    "console-ready",
    false,
  ],
  [request, "request-start", true],
  ["  if ($request.kind -ne 'directory'", "request-finished", true],
  ["  $item = Get-Item -LiteralPath $request.path -Force", "item-start", true],
  ["  if (($item.Attributes", "item-finished", true],
  [
    "  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "identity-start",
    true,
  ],
  ["  if ($request.created)", "identity-finished", true],
  [
    "    Set-Acl -LiteralPath $request.path -AclObject $acl",
    "acl-write-start",
    true,
  ],
  ["  $acl = Get-Acl -LiteralPath $request.path", "acl-read-start", true],
  ["  $rules = @(", "acl-read-finished", true],
  ["  [ordered]@{userSid=", "rules-finished", true],
];
const names = new Set([...points.map((p) => p[1]), "stdin-finished"]);
const marker = (name) =>
  "[Console]::Error.WriteLine('CT_ACL_STAGE|" +
  name +
  "|'+[Diagnostics.Stopwatch]::GetTimestamp())";
export function buildWindowsTaskAccessDiagnostic(input) {
  assert.equal(typeof input, "string");
  // Validate the whole edit before constructing any instrumented program.
  for (const anchor of [...points.map((p) => p[0]), failure])
    assert.equal(
      input.split(anchor).length,
      2,
      "Diagnostic anchor changed: " + anchor,
    );
  let program = input;
  for (const [anchor, name, before] of points)
    program = program.replace(
      anchor,
      before ? marker(name) + "\n" + anchor : anchor + "\n" + marker(name),
    );
  program = program.replace(
    request,
    "  $requestText = [Console]::In.ReadToEnd()\n" +
      marker("stdin-finished") +
      "\n  $request = $requestText | ConvertFrom-Json",
  );
  return program.replace(
    failure,
    "  [Console]::Error.WriteLine('CT_ACL_EXCEPTION|'+$_.Exception.GetType().FullName+'|'+$_.FullyQualifiedErrorId+'|'+$_.CategoryInfo.Reason)\n" +
      failure,
  );
}
export function summarizeWindowsTaskAccessDiagnostic(stderr) {
  assert.equal(typeof stderr, "string");
  assert.ok(
    Buffer.byteLength(stderr) <= 32768,
    "Diagnostic output exceeds executor bound",
  );
  const stages = [
    ...stderr.matchAll(/^CT_ACL_STAGE\|([a-z-]+)\|(\d+)\r?$/gm),
  ].map((m) => ({ stage: m[1], clockTicks: m[2] }));
  assert.ok(
    stages.every((m) => names.has(m.stage)),
    "Unknown diagnostic stage",
  );
  const safe = (text, pattern) =>
    pattern.test(text) && text.length <= 256 ? text : null;
  const exceptions = [
    ...stderr.matchAll(
      /^CT_ACL_EXCEPTION\|([^\r\n|]*)\|([^\r\n|]*)\|([^\r\n|]*)\r?$/gm,
    ),
  ].map((m) => ({
    type: safe(m[1], /^(?:System|Microsoft)\.[A-Za-z0-9_.+]+$/),
    id: safe(
      m[2],
      /^[A-Za-z][A-Za-z0-9_.]*(?:,Microsoft\.PowerShell\.Commands\.[A-Za-z0-9_.]+)?$/,
    ),
    reason: safe(m[3], /^[A-Za-z][A-Za-z0-9_]*$/),
    recordSha256: createHash("sha256").update(m[0]).digest("hex"),
  }));
  return { stages, exceptions };
}
