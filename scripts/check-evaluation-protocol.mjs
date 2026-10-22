import { Buffer } from "node:buffer";
import process from "node:process";
import {
  inspectReviewEvaluationProtocol,
  projectReviewEvaluationProtocol,
} from "../dist/src/review-evaluation-protocol.js";
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 0 &&
    !(
      args.length === 2 &&
      args[0] === "--expected-protocol-sha256" &&
      /^[a-f0-9]{64}$/.test(args[1])
    )
  )
    throw Error("Invalid protocol checker arguments");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1048576)
      throw Error("Protocol declaration exceeds byte bound");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks),
    text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text))) throw Error("Invalid UTF-8");
  const report = inspectReviewEvaluationProtocol(JSON.parse(text), args[1]);
  process.stdout.write(
    JSON.stringify(projectReviewEvaluationProtocol(report)) + "\n",
  );
  process.exitCode = report.declarationComplete ? 0 : 2;
} catch {
  process.stderr.write(
    "Evaluation protocol declaration invalid or unavailable\n",
  );
  process.exitCode = 1;
}
