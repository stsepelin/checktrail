import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type {
  ReviewEvaluationConfigurationFiles,
  ReviewEvaluationConfigurationReport,
} from "../src/review-evaluation-configuration.js";
import { inspectReviewEvaluationConfiguration as inspect } from "../src/review-evaluation-configuration.js";
import { inspectReviewEvaluationProtocol } from "../src/review-evaluation-protocol.js";
import { protocolFixture } from "./review-evaluation-protocol-fixture.js";
import { setPrivateFixtureAccess } from "./windows-private-fixture.js";
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const procedures = [
  "acquisition",
  "answerSeparation",
  "hostIsolation",
  "independentJudgment",
  "commonDefectMatching",
  "externalMetering",
  "stopRules",
] as const;
export async function configurationFixture(t: TestContext) {
  const base = mkdtempSync(path.join(tmpdir(), "checktrail-config-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "private"),
    repository = path.join(base, "project");
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(repository);
  await setPrivateFixtureAccess(root, "directory");
  const declaration = protocolFixture();
  const configurations =
    {} as ReviewEvaluationConfigurationFiles["configurations"];
  const procedureFiles = {} as ReviewEvaluationConfigurationFiles["procedures"];
  const bodies = new Map<string, string>();
  for (const role of [
    "reference",
    "priorWorkflow",
    "verifier",
    ...procedures,
  ] as const) {
    const file = role + ".json",
      body = "private-canary-" + role;
    const full = path.join(root, file);
    writeFileSync(full, body, { mode: 0o600 });
    await setPrivateFixtureAccess(full, "file");
    bodies.set(file, body);
    const pin = { file, bytes: Buffer.byteLength(body) };
    if (role === "reference" || role === "priorWorkflow") {
      configurations[role] = pin;
      declaration.protocol[role].configurationSha256 = sha(body);
    } else if (role === "verifier") {
      configurations.verifier = pin;
      declaration.protocol.verifierConfigurationSha256 = sha(body);
    } else {
      procedureFiles[role] = pin;
      declaration.protocol.procedures[
        (role + "Sha256") as keyof typeof declaration.protocol.procedures
      ] = sha(body);
    }
  }
  const files = { configurations, procedures: procedureFiles };
  const digest = () =>
    inspectReviewEvaluationProtocol(declaration).protocolSha256;
  const inspectFiles = (): ReviewEvaluationConfigurationReport =>
    inspect(repository, root, declaration, files, digest());
  return { root, repository, declaration, files, bodies, digest, inspectFiles };
}
