import { Buffer } from "node:buffer";
import process from "node:process";
import { inspectReviewEvaluationPair } from "../dist/src/review-evaluation-pair.js";

try {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--expected-protocol-sha256" ||
    !/^[a-f0-9]{64}$/.test(args[1])
  )
    throw Error("Invalid arguments");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 3 * 1048576) throw Error("Input exceeds bound");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text))) throw Error("Invalid UTF-8");
  const report = inspectReviewEvaluationPair(JSON.parse(text), args[1]);
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = report.declaredSettingsMatched ? 0 : 2;
} catch {
  process.stderr.write("Evaluation pair invalid or unavailable\n");
  process.exitCode = 1;
}
