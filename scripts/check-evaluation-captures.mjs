import { Buffer } from "node:buffer";
import process from "node:process";
import { inspectReviewEvaluationCaptures } from "../dist/src/review-evaluation-captures.js";
try {
  if (process.argv.length !== 2) throw Error("Invalid capture arguments");
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > 4 * 1048576) throw Error("Capture input bound exceeded");
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks),
    text = bytes.toString("utf8");
  if (!bytes.equals(Buffer.from(text))) throw Error("Invalid UTF-8");
  const report = inspectReviewEvaluationCaptures(JSON.parse(text));
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exitCode =
    report.captureInventoryComplete &&
    report.declaredOutputsComplete &&
    report.measurementAccountingComplete
      ? 0
      : 2;
} catch {
  process.stderr.write("Evaluation capture input invalid or unavailable\n");
  process.exitCode = 1;
}
