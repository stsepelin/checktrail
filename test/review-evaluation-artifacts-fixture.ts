import { setPrivateFixtureAccess } from "./windows-private-fixture.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  encodeReviewEvaluationArtifact,
  reviewEvaluationAttemptArtifactSchema,
} from "../src/review-evaluation-artifacts.js";
import {
  reviewEvaluationCaptureAssignments,
  type ReviewEvaluationCaptureInput,
} from "../src/review-evaluation-captures.js";
import { captureFixture } from "./review-evaluation-captures-fixture.js";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const key = (r: { caseId: string; repetition: number; role: string }) =>
  JSON.stringify([r.caseId, r.repetition, r.role]);
export async function artifactFixture(
  directory: string,
  adjust?: (
    a: ReturnType<typeof reviewEvaluationAttemptArtifactSchema.parse>,
    index: number,
  ) => void,
  initial?: (input: ReviewEvaluationCaptureInput) => Buffer,
) {
  if (process.platform === "win32" && (await readdir(directory)).length !== 0)
    throw Error(
      "Only new empty fixture directories may receive initial private ACLs",
    );
  await setPrivateFixtureAccess(directory, "directory");
  await mkdir(path.join(directory, "blobs"), { mode: 0o700 });
  await setPrivateFixtureAccess(path.join(directory, "blobs"), "directory");
  const input: ReviewEvaluationCaptureInput = captureFixture(),
    blobs = new Map<string, Buffer>();
  const add = (bytes: Buffer) => {
    const id = sha(bytes);
    blobs.set(id, bytes);
    return { sha256: id, bytes: bytes.length };
  };
  const body =
    initial?.(input) ??
    Buffer.from("Original externally supplied independent review text.");
  const output = add(body),
    physical = initial ? body : Buffer.from(body.toString().padEnd(80)),
    stdout = add(physical),
    stderr = add(Buffer.alloc(0));
  const observedBytes = physical.length;
  const assignments = new Map(
    reviewEvaluationCaptureAssignments(input.declaration).map((a) => [
      key(a),
      a,
    ]),
  );
  let i = 0;
  for (const slot of input.metering.slots) {
    const assignment = assignments.get(key(slot))!;
    for (const attempt of slot.attempts) {
      const { recordSha256: _, ...metadata } = attempt;
      void _;
      const record = {
        schemaVersion: 1 as const,
        profile: "external-review-attempt-artifact-v1" as const,
        assignmentSha256: assignment.assignmentSha256,
        ...metadata,
        stdout: { retained: stdout, observedBytes, truncated: false },
        stderr: { retained: stderr, observedBytes: 0, truncated: false },
      };
      adjust?.(record, i++);
      attempt.recordSha256 = add(encodeReviewEvaluationArtifact(record)).sha256;
    }
  }
  for (const c of input.captures) {
    const slot = input.metering.slots.find((m) => key(m) === key(c))!;
    c.attemptRecords = slot.attempts.map((a) => a.recordSha256);
    c.output = output;
    const { captureSha256: _, ...metadata } = c;
    void _;
    c.captureSha256 = add(
      encodeReviewEvaluationArtifact({
        schemaVersion: 1,
        profile: "external-review-capture-artifact-v1",
        ...metadata,
      }),
    ).sha256;
  }
  for (const [id, bytes] of blobs)
    await writeFile(path.join(directory, "blobs", id + ".blob"), bytes, {
      mode: 0o600,
      flag: "wx",
    });
  return { input, blobs, output, stdout, stderr, add };
}
