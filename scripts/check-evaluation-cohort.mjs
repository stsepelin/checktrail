import { Buffer } from "node:buffer";
import process from "node:process";
import {
  inspectReviewCohortDeclaration,
  projectReviewCohortDeclaration,
} from "../dist/src/review-cohort.js";
try {
  const args = process.argv.slice(2);
  if (
    args.length !== 0 &&
    !(
      args.length === 2 &&
      args[0] === "--expected-declaration-sha256" &&
      /^[a-f0-9]{64}$/.test(args[1])
    )
  )
    throw new Error("Invalid cohort checker arguments");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const body = Buffer.from(chunk);
    bytes += body.length;
    if (bytes > 1048576) throw new Error("Cohort input exceeds byte bound");
    chunks.push(body);
  }
  const body = Buffer.concat(chunks),
    text = body.toString("utf8");
  if (!body.equals(Buffer.from(text)))
    throw new Error("Cohort input is not UTF-8");
  const report = inspectReviewCohortDeclaration(JSON.parse(text), args[1]);
  process.stdout.write(
    JSON.stringify(projectReviewCohortDeclaration(report)) + "\n",
  );
  process.exitCode = report.declarationComplete ? 0 : 2;
} catch {
  // Invalid input may contain private identities, answer fields or malformed bytes.
  process.stderr.write("Cohort declaration invalid or unavailable\n");
  process.exitCode = 1;
}
