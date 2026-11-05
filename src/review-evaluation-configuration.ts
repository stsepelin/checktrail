import { createHash } from "node:crypto";
import {
  lstatSync,
  opendirSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  evaluationPrivateArtifacts as files,
  withEvaluationPrivateStorage,
} from "./review-evaluation-artifacts.js";
import {
  inspectReviewEvaluationProtocol,
  reviewEvaluationProtocolInputSchema,
} from "./review-evaluation-protocol.js";

const procedures = [
  "acquisition",
  "answerSeparation",
  "hostIsolation",
  "independentJudgment",
  "commonDefectMatching",
  "externalMetering",
  "stopRules",
] as const;
const configurations = ["reference", "priorWorkflow", "verifier"] as const;
const leaf = z.strictObject({
  file: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  bytes: z.number().int().min(0).max(1048576),
});
export const reviewEvaluationConfigurationFilesSchema = z.strictObject({
  configurations: z.strictObject({
    reference: leaf,
    priorWorkflow: leaf,
    verifier: leaf,
  }),
  procedures: z.strictObject({
    acquisition: leaf,
    answerSeparation: leaf,
    hostIsolation: leaf,
    independentJudgment: leaf,
    commonDefectMatching: leaf,
    externalMetering: leaf,
    stopRules: leaf,
  }),
});
export type ReviewEvaluationConfigurationFiles = z.infer<
  typeof reviewEvaluationConfigurationFilesSchema
>;
type Role = (typeof configurations)[number] | (typeof procedures)[number];
type Issue =
  | "unavailable-or-unsafe-file"
  | "byte-length"
  | "digest"
  | "changed-during-inspection";
interface Artifact {
  role: Role;
  bytes: number;
  sha256: string;
  issues: Issue[];
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function same(a: BigIntStats, b: BigIntStats) {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function namespace(root: string, allowed: Set<string>) {
  const directory = opendirSync(root);
  const names: string[] = [];
  try {
    for (
      let entry = directory.readSync();
      entry;
      entry = directory.readSync()
    ) {
      if (
        !allowed.has(entry.name) ||
        names.length >= allowed.size ||
        entry.isDirectory()
      )
        throw Error(
          "Configuration storage must contain only selected artifacts",
        );
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

/**
 * Operator-only byte binding, separate from declaration inspection.
 * Read exactly ten explicit flat files; never discover cases or run their code.
 */
export function inspectReviewEvaluationConfiguration(
  projectRoot: string,
  configurationRoot: string,
  input: unknown,
  selectedFiles: unknown,
  expectedProtocolSha256: string,
) {
  const declaration = reviewEvaluationProtocolInputSchema.parse(input);
  const protocol = inspectReviewEvaluationProtocol(
    declaration,
    expectedProtocolSha256,
  );
  if (!protocol.declarationComplete)
    throw Error(
      "Configuration inspection requires a complete protocol declaration",
    );
  const selected =
    reviewEvaluationConfigurationFilesSchema.parse(selectedFiles);
  const rows = [
    ...configurations.map((role) => ({
      role,
      ...selected.configurations[role],
      sha256:
        role === "verifier"
          ? declaration.protocol.verifierConfigurationSha256
          : declaration.protocol[role].configurationSha256,
    })),
    ...procedures.map((role) => ({
      role,
      ...selected.procedures[role],
      sha256:
        declaration.protocol.procedures[
          (role + "Sha256") as keyof typeof declaration.protocol.procedures
        ],
    })),
  ];
  const names = new Set(rows.map((row) => row.file));
  if (
    names.size !== rows.length ||
    new Set(rows.map((row) => row.file.toLowerCase())).size !== rows.length ||
    rows.reduce((total, row) => total + row.bytes, 0) > 8 * 1048576
  )
    throw Error("Configuration inspection requires distinct bounded files");

  const project = realpathSync(projectRoot);
  if (!lstatSync(project).isDirectory())
    throw Error("Configuration inspection requires a project directory");
  const canonical = realpathSync(configurationRoot);
  const relative = path.relative(project, canonical);
  if (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  )
    throw Error("Configuration storage must be outside the project");
  const rootBefore = lstatSync(canonical, { bigint: true });
  if (!rootBefore.isDirectory())
    throw Error("Configuration inspection requires a private directory");
  // Bound the namespace before Windows ACL inspection can inventory it.
  const initialNamespace = namespace(canonical, names);
  return withEvaluationPrivateStorage(() => {
    const root = files.storage(project, configurationRoot);
    if (
      root !== canonical ||
      !same(rootBefore, lstatSync(root, { bigint: true }))
    )
      throw Error("Configuration storage changed during admission");

    const observations: {
      filename: string;
      physical: BigIntStats;
      row: Artifact;
    }[] = [];
    const artifacts: Artifact[] = [];
    for (const selected of rows) {
      const row: Artifact = {
        role: selected.role,
        bytes: selected.bytes,
        sha256: selected.sha256,
        issues: [],
      };
      artifacts.push(row);
      const filename = path.join(root, selected.file);
      try {
        const before = lstatSync(filename, { bigint: true });
        const bytes = files.readPrivate(filename, selected.bytes);
        if (!same(before, lstatSync(filename, { bigint: true }))) {
          row.issues.push("changed-during-inspection");
          continue;
        }
        observations.push({ filename, physical: before, row });
        if (bytes.length !== selected.bytes) row.issues.push("byte-length");
        if (files.sha(bytes) !== selected.sha256) row.issues.push("digest");
      } catch {
        row.issues.push("unavailable-or-unsafe-file");
      }
    }
    // An earlier file must still be the same object after the last read.
    for (const observation of observations) {
      try {
        if (
          !same(
            observation.physical,
            lstatSync(observation.filename, { bigint: true }),
          )
        )
          observation.row.issues.push("changed-during-inspection");
      } catch {
        observation.row.issues.push("changed-during-inspection");
      }
    }
    const namespaceAfter = namespace(root, names);
    const storageChanged =
      !same(rootBefore, lstatSync(root, { bigint: true })) ||
      JSON.stringify(initialNamespace) !== JSON.stringify(namespaceAfter);
    const configurationBytesVerified =
      !storageChanged && artifacts.every((row) => row.issues.length === 0);
    return {
      schemaVersion: 1 as const,
      profile: "prospective-review-configuration-bytes-v1" as const,
      protocolSha256: protocol.protocolSha256,
      artifactBindingsSha256: hash(artifacts),
      configurationBytesVerified,
      storageChanged,
      artifacts,
      configurationSemanticsVerified: false as const,
      sourceContentInspected: false as const,
      labelsInspected: false as const,
      chronologyVerified: false as const,
      licenseGrantVerified: false as const,
      hostIndependenceVerified: false as const,
      gateAClosed: false as const,
      qualityAssessed: false as const,
      inferenceExecuted: false as const,
      fieldEvaluationExecuted: false as const,
    };
  });
}
export type ReviewEvaluationConfigurationReport = ReturnType<
  typeof inspectReviewEvaluationConfiguration
>;

export function projectReviewEvaluationConfiguration(
  report: ReviewEvaluationConfigurationReport,
) {
  const { artifacts } = report;
  return {
    schemaVersion: report.schemaVersion,
    profile: report.profile,
    protocolSha256: report.protocolSha256,
    artifactBindingsSha256: report.artifactBindingsSha256,
    configurationBytesVerified: report.configurationBytesVerified,
    storageChanged: report.storageChanged,
    configurationSemanticsVerified: false as const,
    sourceContentInspected: false as const,
    labelsInspected: false as const,
    chronologyVerified: false as const,
    licenseGrantVerified: false as const,
    hostIndependenceVerified: false as const,
    gateAClosed: false as const,
    qualityAssessed: false as const,
    inferenceExecuted: false as const,
    fieldEvaluationExecuted: false as const,
    counts: {
      selected: artifacts.length,
      verified: artifacts.filter((row) => row.issues.length === 0).length,
      incomplete: artifacts.filter((row) => row.issues.length !== 0).length,
    },
    sourceIncluded: false as const,
    privateIdentitiesIncluded: false as const,
  };
}
