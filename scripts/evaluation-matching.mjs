import { Buffer } from "node:buffer";
import process from "node:process";
import {
  freezeReviewEvaluationCommonDefects,
  prepareReviewEvaluationMatching,
  reviewEvaluationMatchingPacket,
  sealReviewEvaluationMappings,
  inspectSealedReviewEvaluationMappings,
  scoreReviewEvaluationArtifacts,
} from "../dist/src/review-evaluation-matching.js";
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
  if (command === "freeze" && rest.length === 0) {
    const value = await input();
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !==
        JSON.stringify(["declaration", "inventory"])
    )
      throw Error("Invalid common inventory wrapper");
    result = freezeReviewEvaluationCommonDefects(
      project,
      store,
      value.declaration,
      digest,
      value.inventory,
    );
  } else if (command === "prepare" && rest.length === 1)
    result = prepareReviewEvaluationMatching(project, store, digest, rest[0]);
  else if (
    command === "packet" &&
    rest.length === 2 &&
    rest[1] === "--allow-source"
  )
    result = reviewEvaluationMatchingPacket(
      project,
      store,
      digest,
      rest[0],
      true,
    );
  else if (command === "seal" && rest.length === 0)
    result = sealReviewEvaluationMappings(
      project,
      store,
      digest,
      await input(),
    );
  else if (command === "inspect" && rest.length === 0)
    result = inspectSealedReviewEvaluationMappings(project, store, digest);
  else if (command === "score" && rest.length === 0)
    result = scoreReviewEvaluationArtifacts(project, store, digest);
  else throw Error("Invalid command");
  process.stdout.write(JSON.stringify(result) + "\n");
  if ("scoringBindingsComplete" in result)
    process.exitCode = result.scoringBindingsComplete ? 0 : 2;
  else if ("mappingsComplete" in result)
    process.exitCode =
      result.mappingsComplete && result.judgmentsResolved ? 0 : 2;
} catch {
  process.stderr.write(
    "Independent matching input or artifacts invalid or unavailable\n",
  );
  process.exitCode = 1;
}
