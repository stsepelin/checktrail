import path from "node:path";
import {
  reviewHclBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import {
  validateHclModuleRoots,
  hclSourceOmissions,
  type HclSyntaxUnit,
} from "./review-hcl-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type HclAnalysis = Extract<
  ReviewBehavior,
  { profile: "hcl-selected-bindings-v1" }
>;
type Omission = HclAnalysis["hclBindings"]["omissions"][number];
const fixed: Omission[] = [
  "unselected-source",
  "application-semantics-unknown",
  "native-evaluation-unknown",
  "module-input-values-unknown",
  "module-loading-unknown",
  "build-selection-unknown",
];
const key = (...values: string[]) => JSON.stringify(values),
  sourceFile = (file: string) => /\.(?:tf|hcl)$/.test(file),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/"));
/** Reverse selected declaration dependencies. This does not evaluate configuration or prove runtime impact. */
export function hclDependencyClosure(
  analysis: HclAnalysis | Analysis,
  primary: string[],
) {
  const primaryIds = new Set(
    analysis.declarations
      .filter((d) => primary.includes(d.file) && sourceFile(d.file))
      .map((d) => d.id),
  );
  const edges: HclAnalysis["hclBindings"]["dependencyEdges"] = [],
    seen = new Set<string>();
  let exhausted = false,
    cycle = false;
  for (const target of primaryIds) {
    const queue = [{ id: target, depth: 0, ancestors: new Set([target]) }];
    while (queue.length) {
      const current = queue.shift()!;
      for (const ref of analysis.references.filter(
        (ref) =>
          ref.targetDeclarationId === current.id &&
          ref.ownerDeclarationId !== null,
      )) {
        const from = ref.ownerDeclarationId!,
          depth = current.depth + 1;
        if (current.ancestors.has(from)) {
          cycle = true;
          continue;
        }
        if (depth > 8) {
          exhausted = true;
          continue;
        }
        const address = key(from, target);
        if (seen.has(address)) continue;
        if (edges.length >= 4096) {
          exhausted = true;
          continue;
        }
        seen.add(address);
        edges.push({
          fromDeclarationId: from,
          targetDeclarationId: target,
          depth,
        });
        queue.push({
          id: from,
          depth,
          ancestors: new Set([...current.ancestors, from]),
        });
      }
    }
  }
  return {
    edges: edges.sort(
      (a, b) =>
        a.targetDeclarationId.localeCompare(b.targetDeclarationId) ||
        a.depth - b.depth ||
        a.fromDeclarationId.localeCompare(b.fromDeclarationId),
    ),
    exhausted,
    cycle,
  };
}
export function resolveHclBindings(
  analysis: Analysis,
  units: HclSyntaxUnit[],
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): HclAnalysis {
  validateHclModuleRoots(roots);
  const omissions = new Set<Omission>(fixed),
    files = new Set(units.map((unit) => key(unit.revision, unit.file)));
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const reason of unit.omissions) omissions.add(reason as Omission);
  }
  const selected = (unit: HclSyntaxUnit) =>
    units.filter(
      (value) =>
        value.revision === unit.revision &&
        path.posix.dirname(value.file) === path.posix.dirname(unit.file) &&
        beneath(value.file, roots),
    );
  function imported(
    unit: HclSyntaxUnit,
    value: HclSyntaxUnit["imports"][number],
  ) {
    if (value.unsupported || value.specifier === null)
      return { resolution: "dynamic" as const, units: [] as HclSyntaxUnit[] };
    if (path.posix.isAbsolute(value.specifier))
      return {
        resolution: "outside-root" as const,
        units: [] as HclSyntaxUnit[],
      };
    if (!/^\.\.?\/[A-Za-z_0-9./-]+$/.test(value.specifier))
      return { resolution: "dynamic" as const, units: [] as HclSyntaxUnit[] };
    const directory = path.posix.normalize(
        path.posix.join(path.posix.dirname(unit.file), value.specifier),
      ),
      owner = roots.find(
        (root) => root === "." || unit.file.startsWith(root + "/"),
      );
    if (
      directory.startsWith("../") ||
      directory === ".." ||
      path.posix.isAbsolute(directory) ||
      owner === undefined ||
      !beneath(directory + "/file.tf", [owner])
    )
      return {
        resolution: "outside-root" as const,
        units: [] as HclSyntaxUnit[],
      };
    const targets = units.filter(
      (target) =>
        target.revision === unit.revision &&
        path.posix.dirname(target.file) === directory &&
        target.file.endsWith(".tf"),
    );
    return {
      resolution: targets.length
        ? ("selected" as const)
        : ("external" as const),
      units: targets,
    };
  }
  analysis.references = analysis.references.filter(
    (ref) => !files.has(key(ref.revision, ref.file)),
  );
  analysis.modules = analysis.modules.filter(
    (module) => !files.has(key(module.revision, module.file)),
  );
  const references: HclAnalysis["hclBindings"]["references"] = [];
  const moduleCandidates: HclAnalysis["hclBindings"]["moduleCandidates"] = [];
  for (const unit of units) {
    for (const value of unit.imports) {
      const target = imported(unit, value),
        { name: _name, unsupported: _unsupported, ...address } = value;
      void _name;
      void _unsupported;
      const resolution = beneath(unit.file, roots)
        ? target.resolution
        : "outside-root";
      const { specifier: _specifier, ...sourceAddress } = address;
      void _specifier;
      moduleCandidates.push({
        ...sourceAddress,
        targetFiles:
          resolution === "selected"
            ? target.units.map((unit) => unit.file).sort()
            : [],
      });
      analysis.modules.push({
        ...address,
        kind: "import",
        targetFile:
          resolution === "selected"
            ? target.units.map((u) => u.file).sort()[0]!
            : null,
        resolution,
      });
      if (resolution !== "selected") omissions.add("unresolved-import");
    }
    for (const value of unit.references) {
      let candidates: HclSyntaxUnit["bindings"] = [],
        unsupported = value.unsupported || !beneath(unit.file, roots);
      const [namespace, name, member] = value.segments;
      if (
        (namespace === "var" || namespace === "local") &&
        value.segments.length === 2
      ) {
        candidates = selected(unit).flatMap((source) =>
          source.bindings.filter(
            (binding) => binding.kind === namespace && binding.name === name,
          ),
        );
      } else if (namespace === "module" && value.segments.length === 3) {
        const modules = selected(unit).flatMap((source) =>
          source.imports
            .filter((module) => module.name === name)
            .map((module) => ({ source, module })),
        );
        if (modules.length === 1) {
          const target = imported(modules[0]!.source, modules[0]!.module);
          unsupported ||= target.resolution !== "selected";
          candidates = target.units.flatMap((source) =>
            source.bindings.filter(
              (binding) => binding.kind === "output" && binding.name === member,
            ),
          );
        } else if (modules.length > 1) {
          omissions.add("ambiguous-definition");
          unsupported = true;
        }
      } else unsupported = true;
      const resolution = unsupported
          ? "unsupported-expression"
          : candidates.length === 1
            ? "selected-declaration"
            : candidates.length > 1
              ? "ambiguous-definition"
              : "no-selected-definition",
        targetDeclarationId =
          resolution === "selected-declaration"
            ? candidates[0]!.declarationId
            : null;
      const { segments: _segments, unsupported: _unknown, ...address } = value;
      void _segments;
      void _unknown;
      references.push({ ...address, targetDeclarationId, resolution });
      if (targetDeclarationId)
        analysis.references.push({
          ...address,
          fromFunctionId: null,
          targetDeclarationId,
        });
      else omissions.add("unresolved-reference");
      if (resolution === "ambiguous-definition")
        omissions.add("ambiguous-definition");
    }
  }
  const closure = hclDependencyClosure(analysis, primary);
  if (closure.exhausted) omissions.add("depth-limit");
  if (closure.cycle) omissions.add("dependency-cycle-unknown");
  if (analysis.files.some((file) => file.state !== "collected"))
    omissions.add("partial-syntax");
  for (const source of sources)
    for (const reason of hclSourceOmissions(source.path)) omissions.add(reason);
  if (
    !analysis.declarations.some(
      (d) => primary.includes(d.file) && sourceFile(d.file),
    )
  )
    omissions.add("no-selected-declarations");
  const imports = analysis.modules.filter((module) =>
      files.has(key(module.revision, module.file)),
    ),
    resolvedImports = imports.filter(
      (module) => module.resolution === "selected",
    ).length,
    resolvedReferences = references.filter(
      (ref) => ref.targetDeclarationId !== null,
    ).length;
  const result = {
    ...analysis,
    profile: "hcl-selected-bindings-v1" as const,
    hclBindings: {
      moduleRoots: roots,
      scope: "selected-captured-hcl-source" as const,
      state: [...omissions].some((value) => !fixed.includes(value))
        ? ("partial" as const)
        : ("collected" as const),
      dependencyDepthLimit: 8 as const,
      moduleCandidates,
      dependencyEdges: closure.edges,
      references,
      counts: {
        references: references.length,
        resolvedReferences,
        unresolvedReferences: references.length - resolvedReferences,
        imports: imports.length,
        resolvedImports,
        unresolvedImports: imports.length - resolvedImports,
      },
      fullImpactFallback: true as const,
      nativeEvaluationVerified: false as const,
      moduleInputsVerified: false as const,
      moduleLoadingVerified: false as const,
      validationPlanUnchanged: true as const,
      omissions: [...omissions].sort(),
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw Error("HCL binding metadata budget exhausted");
  return reviewHclBehaviorSchema.parse(result);
}
export function validateHclReviewBindings(
  analysis: HclAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateHclModuleRoots(roots);
  const bindings = analysis.hclBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("HCL binding module roots differ");
  const selectedFiles = new Set(
      analysis.files
        .filter((file) => sourceFile(file.file) && file.state === "collected")
        .map((file) => key(file.revision, file.file)),
    ),
    imports = analysis.modules.filter((module) =>
      selectedFiles.has(key(module.revision, module.file)),
    ),
    references = bindings.references;
  const resolvedReferences = references.filter(
      (ref) => ref.targetDeclarationId !== null,
    ),
    resolvedImports = imports.filter(
      (module) => module.resolution === "selected",
    ).length;
  const counts = {
    references: references.length,
    resolvedReferences: resolvedReferences.length,
    unresolvedReferences: references.length - resolvedReferences.length,
    imports: imports.length,
    resolvedImports,
    unresolvedImports: imports.length - resolvedImports,
  };
  if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))
    throw Error("HCL binding counts do not reconcile");
  if (bindings.moduleCandidates.length !== imports.length)
    throw Error("HCL module candidate counts do not reconcile");
  for (const [index, module] of imports.entries()) {
    const candidate = bindings.moduleCandidates[index]!;
    const targetDirectory =
      module.specifier === null
        ? null
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(module.file), module.specifier),
          );
    const targetFiles =
      module.resolution === "selected"
        ? analysis.files
            .filter(
              (file) =>
                file.revision === module.revision &&
                file.state === "collected" &&
                file.file.endsWith(".tf") &&
                path.posix.dirname(file.file) === targetDirectory,
            )
            .map((file) => file.file)
            .sort()
        : [];
    if (
      candidate.revision !== module.revision ||
      candidate.file !== module.file ||
      candidate.start !== module.start ||
      candidate.end !== module.end ||
      candidate.startLine !== module.startLine ||
      candidate.endLine !== module.endLine ||
      JSON.stringify(candidate.targetFiles) !== JSON.stringify(targetFiles) ||
      module.targetFile !== (targetFiles[0] ?? null)
    )
      throw Error("HCL module candidates do not reconcile");
  }
  const publicReferences = analysis.references.filter((ref) =>
    selectedFiles.has(key(ref.revision, ref.file)),
  );
  const referenceKey = (
    ref:
      | ReviewBehavior["references"][number]
      | HclAnalysis["hclBindings"]["references"][number],
  ) => [
    ref.revision,
    ref.file,
    ref.start,
    ref.end,
    ref.startLine,
    ref.endLine,
    ref.ownerDeclarationId,
    ref.targetDeclarationId,
  ];
  if (
    JSON.stringify(publicReferences.map(referenceKey)) !==
    JSON.stringify(resolvedReferences.map(referenceKey))
  )
    throw Error("HCL selected references do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedReferences) mandatory.push("unresolved-reference");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (references.some((ref) => ref.resolution === "ambiguous-definition"))
    mandatory.push("ambiguous-definition");
  if (analysis.files.some((file) => file.state !== "collected"))
    mandatory.push("partial-syntax");
  for (const source of sources)
    mandatory.push(...hclSourceOmissions(source.path));
  if (
    analysis.files.some(
      (file) => sourceFile(file.file) && !beneath(file.file, roots),
    )
  )
    mandatory.push("outside-module-roots");
  if (
    !analysis.declarations.some(
      (d) => primary.includes(d.file) && sourceFile(d.file),
    )
  )
    mandatory.push("no-selected-declarations");
  const closure = hclDependencyClosure(analysis, primary);
  if (closure.exhausted) mandatory.push("depth-limit");
  if (closure.cycle) mandatory.push("dependency-cycle-unknown");
  if (
    mandatory.some((reason) => !bindings.omissions.includes(reason)) ||
    JSON.stringify(bindings.omissions) !==
      JSON.stringify([...new Set(bindings.omissions)].sort()) ||
    bindings.state !==
      (bindings.omissions.some((reason) => !fixed.includes(reason))
        ? "partial"
        : "collected")
  )
    throw Error("HCL binding omissions do not reconcile");
  if (
    JSON.stringify(bindings.dependencyEdges) !== JSON.stringify(closure.edges)
  )
    throw Error("HCL dependency closure does not reconcile");
}
