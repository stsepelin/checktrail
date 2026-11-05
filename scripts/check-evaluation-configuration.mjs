import { Buffer } from "node:buffer";
import process from "node:process";
import {
  inspectReviewEvaluationConfiguration,
  projectReviewEvaluationConfiguration,
} from "../dist/src/review-evaluation-configuration.js";

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--project" ||
    args[2] !== "--configuration-root" ||
    args[4] !== "--expected-protocol-sha256" ||
    !/^[a-f0-9]{64}$/.test(args[5])
  )
    throw Error("Invalid configuration checker arguments");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1048576)
      throw Error("Configuration declaration exceeds bound");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text))) throw Error("Invalid UTF-8");
  const input = JSON.parse(text);
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !== "declaration,files"
  )
    throw Error("Invalid configuration declaration");
  const report = inspectReviewEvaluationConfiguration(
    args[1],
    args[3],
    input.declaration,
    input.files,
    args[5],
  );
  process.stdout.write(
    JSON.stringify(projectReviewEvaluationConfiguration(report)) + "\n",
  );
  process.exitCode = report.configurationBytesVerified ? 0 : 2;
} catch {
  process.stderr.write("Evaluation configuration invalid or unavailable\n");
  process.exitCode = 1;
}
