import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const request = JSON.parse(await readFile(process.argv[2], "utf8"));
const findings = [];
const files = [];
for (const file of request.scope) {
  const text = await readFile(
    path.join(request.root, request.project, file),
    "utf8",
  );
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/[ \t]+$/.test(line))
      findings.push({
        ruleId: "trailing-whitespace",
        level: "error",
        message: "Remove trailing spaces or tabs",
        file,
        line: index + 1,
      });
  }
  files.push({ path: file, status: "checked" });
}
process.stdout.write(
  JSON.stringify({
    protocolVersion: 1,
    identity: request.identity,
    checkId: request.checkId,
    sourceFingerprint: request.sourceFingerprint,
    files,
    findings,
    findingsComplete: true,
    tools: [{ name: "node", version: process.versions.node }],
  }),
);
process.exitCode = findings.length ? 1 : 0;
