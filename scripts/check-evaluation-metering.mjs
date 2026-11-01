import { Buffer } from "node:buffer";
import process from "node:process";
import { inspectReviewEvaluationMetering } from "../dist/src/review-evaluation-metering.js";
try {
  if (process.argv.length !== 2) throw Error("Invalid metering arguments");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4 * 1048576) throw Error("Metering exceeds byte bound");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks),
    text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text))) throw Error("Invalid UTF-8");
  const report = inspectReviewEvaluationMetering(JSON.parse(text));
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode = report.measurementAccountingComplete ? 0 : 2;
} catch {
  process.stderr.write("Evaluation metering input invalid or unavailable\n");
  process.exitCode = 1;
}
