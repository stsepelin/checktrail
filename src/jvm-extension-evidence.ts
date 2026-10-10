import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { JvmExtensions, JvmKind } from "./jvm-extensions.js";
import {
  jvmWrapperPins,
  jvmWrapperArchives,
  jvmWrapperProperties,
} from "./jvm-wrapper-pins.js";
import { jvmExtensionPacketSchema } from "./jvm-workspace-extensions.js";
const requireEvidence = (valid: unknown, message: string) => {
  if (!valid) throw Error(message);
};
const same = (actual: string[], expected: string[]) =>
  new Set(actual).size === actual.length &&
  new Set(expected).size === expected.length &&
  JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
const hash = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");
export function reconcileJvmExtensions(
  kind: JvmKind,
  declaration: JvmExtensions | undefined,
  observation: unknown,
  root: string,
  project: string,
  inputs: { path: string; sha256: string }[],
  workspace: string,
  distribution: string,
) {
  if (!declaration) {
    requireEvidence(
      observation === undefined,
      "Unselected JVM extension observation",
    );
    return [];
  }
  const data = jvmExtensionPacketSchema.parse(observation);
  const propertyPin = jvmWrapperPins.find(
    (p) => p.kind === kind && p.path.endsWith(".properties"),
  )!;
  const staged = jvmWrapperProperties[kind].replace(
    /^distributionUrl=.*$/m,
    "distributionUrl=" +
      pathToFileURL(
        path.resolve(root, project, declaration.archive),
      ).href.replaceAll(":", "\\:"),
  );
  requireEvidence(
    data.wrapper.file === propertyPin.path &&
      data.wrapper.originalSha256 === propertyPin.sha256 &&
      data.wrapper.stagedSha256 === hash(staged) &&
      data.wrapper.archiveSha256 === jvmWrapperArchives[kind].sha256,
    "Native wrapper source and derived offline properties",
  );
  const home = path.join(
    path.dirname(workspace),
    kind === "maven" ? "wrapper-cache" : "home",
  );
  const relative = path.relative(home, distribution);
  requireEvidence(
    path.isAbsolute(distribution) &&
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative) &&
      path.basename(distribution) ===
        (kind === "maven" ? "apache-maven-3.10.0" : "gradle-9.8.0"),
    "Owned selected wrapper distribution",
  );
  requireEvidence(
    data.generated.length === declaration.generators.length &&
      same(
        data.generated.map((g) => g.source),
        declaration.generators.map((g) => g.source),
      ),
    "Every declared native generator",
  );
  const outputs = [];
  for (const generator of declaration.generators) {
    const result = data.generated.find((g) => g.source === generator.source)!;
    requireEvidence(
      result.sourceSha256 ===
        inputs.find((i) => i.path === generator.source)?.sha256,
      "Generator input identity",
    );
    const expected = generator.outputs.map((o) => ({
      ...o,
      path: path.posix.join(generator.module, o.file),
    }));
    requireEvidence(
      same(
        result.outputs.map((o) => o.path),
        expected.map((o) => o.path),
      ),
      "Every fresh generated Java output",
    );
    for (const output of result.outputs) {
      requireEvidence(
        expected.some(
          (o) => o.path === output.path && o.className === output.className,
        ),
        "Generated output class contract",
      );
      outputs.push(output);
    }
  }
  requireEvidence(
    same(
      data.generatedClasses.map((c) => c.path),
      outputs.map((o) => o.path),
    ),
    "Every physical generated class",
  );
  for (const output of outputs) {
    const physical = data.generatedClasses.find((c) => c.path === output.path)!;
    requireEvidence(
      physical.className === output.className &&
        physical.sourceFile === path.posix.basename(output.path),
      "Native generated class and source-file origins",
    );
  }
  requireEvidence(
    data.modules.length === declaration.jpms.length &&
      same(
        data.modules.map((m) => m.module),
        declaration.jpms.map((m) => m.module),
      ),
    "Every declared native JPMS descriptor",
  );
  for (const module of declaration.jpms) {
    const observed = data.modules.find((m) => m.module === module.module)!;
    requireEvidence(
      observed.name === module.name &&
        same(observed.requires, ["java.base", ...module.requires]) &&
        same(observed.exports, module.exports),
      "Native JPMS name, requires and exports",
    );
  }
  return outputs;
}
