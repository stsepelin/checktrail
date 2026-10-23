import { Buffer } from "node:buffer";
import process from "node:process";
import {
  prepareReviewEvaluationJudging,
  reviewEvaluationJudgmentPacket,
  sealReviewEvaluationJudgments,
  inspectSealedReviewEvaluationJudgments,
} from "../dist/src/review-evaluation-judging.js";
try {
  const [command, project, store, digest, ...rest] = process.argv.slice(2);
  let result;
  const input = async () => {
    let total = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      const b = Buffer.from(chunk);
      if ((total += b.length) > 4 * 1048576) throw Error("Input bound");
      chunks.push(b);
    }
    const bytes = Buffer.concat(chunks),
      text = bytes.toString("utf8");
    if (!bytes.equals(Buffer.from(text))) throw Error("Invalid encoding");
    return JSON.parse(text);
  };
  if (!project || !store || !digest) throw Error("Missing argument");
  if (command === "prepare" && rest.length === 0)
    result = prepareReviewEvaluationJudging(
      project,
      store,
      digest,
      await input(),
    );
  else if (
    command === "packet" &&
    rest.length === 2 &&
    rest[1] === "--allow-source"
  )
    result = reviewEvaluationJudgmentPacket(
      project,
      store,
      digest,
      rest[0],
      true,
    );
  else if (command === "seal" && rest.length === 0)
    result = sealReviewEvaluationJudgments(
      project,
      store,
      digest,
      await input(),
    );
  else if (command === "inspect" && rest.length === 0)
    result = inspectSealedReviewEvaluationJudgments(project, store, digest);
  else throw Error("Invalid command");
  process.stdout.write(JSON.stringify(result) + "\n");
  if ("judgmentsComplete" in result)
    process.exitCode =
      result.judgmentsComplete && result.judgmentsResolved ? 0 : 2;
} catch {
  process.stderr.write(
    "Independent judging input or artifacts invalid or unavailable\n",
  );
  process.exitCode = 1;
}
