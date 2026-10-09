import {
  reviewYamlBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import {
  validateYamlModuleRoots,
  yamlSourceOmissions,
  type YamlSyntaxUnit,
} from "./review-yaml-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type YamlAnalysis = Extract<
  ReviewBehavior,
  { profile: "yaml-selected-bindings-v1" }
>;
type Omission = YamlAnalysis["yamlBindings"]["omissions"][number];
const fixed: Omission[] = [
  "unselected-source",
  "consumer-semantics-unknown",
  "native-serialization-unknown",
  "scalar-resolution-unknown",
  "merge-semantics-unknown",
  "build-selection-unknown",
];
const sourceFile = (file: string) => /\.(?:yaml|yml)$/.test(file),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/"));
export function yamlDependencyClosure(
  analysis: Analysis | YamlAnalysis,
  primary: string[],
) {
  const primaryIds = new Set(
    analysis.declarations
      .filter((d) => primary.includes(d.file) && sourceFile(d.file))
      .map((d) => d.id),
  );
  const edges: YamlAnalysis["yamlBindings"]["dependencyEdges"] = [],
    seen = new Set<string>();
  let exhausted = false;
  for (const target of primaryIds) {
    const queue = [{ id: target, depth: 0 }];
    while (queue.length) {
      const current = queue.shift()!;
      for (const ref of analysis.references.filter(
        (r) =>
          r.targetDeclarationId === current.id && r.ownerDeclarationId !== null,
      )) {
        const from = ref.ownerDeclarationId!,
          depth = current.depth + 1;
        if (depth > 8) {
          exhausted = true;
          continue;
        }
        const address = JSON.stringify([from, target]);
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
        queue.push({ id: from, depth });
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
  };
}
function selectedAnchor(
  anchors: YamlAnalysis["yamlBindings"]["anchors"],
  alias: YamlAnalysis["yamlBindings"]["aliases"][number],
) {
  return anchors
    .filter(
      (a) =>
        a.revision === alias.revision &&
        a.file === alias.file &&
        a.documentStart === alias.documentStart &&
        a.documentEnd === alias.documentEnd &&
        a.name === alias.name &&
        a.start < alias.start,
    )
    .sort((a, b) => b.start - a.start)[0];
}
export function resolveYamlBindings(
  analysis: Analysis,
  units: YamlSyntaxUnit[],
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): YamlAnalysis {
  validateYamlModuleRoots(roots);
  const omissions = new Set<Omission>(fixed),
    files = new Set(units.map((u) => JSON.stringify([u.revision, u.file])));
  analysis.references = analysis.references.filter(
    (r) => !files.has(JSON.stringify([r.revision, r.file])),
  );
  analysis.modules = analysis.modules.filter(
    (r) => !files.has(JSON.stringify([r.revision, r.file])),
  );
  const anchors: YamlAnalysis["yamlBindings"]["anchors"] = units.flatMap(
      (u) => u.anchors,
    ),
    aliases: YamlAnalysis["yamlBindings"]["aliases"] = [];
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const reason of unit.omissions) omissions.add(reason as Omission);
    for (const value of unit.aliases) {
      const provisional = {
          ...value,
          targetDeclarationId: null,
          resolution: "no-prior-anchor" as const,
        },
        target = selectedAnchor(anchors, provisional),
        unsupported =
          value.unsupported || !beneath(unit.file, roots) || target?.tagged;
      const recursive = target !== undefined && target.end > value.start;
      const resolution = unsupported
          ? "unsupported-alias"
          : recursive
            ? "recursive-alias"
            : target
              ? "selected-anchor"
              : "no-prior-anchor",
        targetDeclarationId =
          resolution === "selected-anchor" ? target!.declarationId : null;
      const { unsupported: _unsupported, ...address } = value;
      void _unsupported;
      aliases.push({ ...address, targetDeclarationId, resolution });
      if (targetDeclarationId)
        analysis.references.push({
          revision: address.revision,
          file: address.file,
          start: address.start,
          end: address.end,
          startLine: address.startLine,
          endLine: address.endLine,
          ownerDeclarationId: address.ownerDeclarationId,
          fromFunctionId: null,
          targetDeclarationId,
        });
      else omissions.add("unresolved-alias");
      if (recursive) omissions.add("recursive-alias-unknown");
    }
  }
  const closure = yamlDependencyClosure(analysis, primary);
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  for (const source of sources)
    for (const reason of yamlSourceOmissions(source.path))
      omissions.add(reason);
  if (
    !analysis.declarations.some(
      (d) => primary.includes(d.file) && sourceFile(d.file),
    )
  )
    omissions.add("no-selected-declarations");
  const resolved = aliases.filter((a) => a.targetDeclarationId !== null).length;
  const result = {
    ...analysis,
    profile: "yaml-selected-bindings-v1" as const,
    yamlBindings: {
      moduleRoots: roots,
      scope: "selected-captured-yaml-source" as const,
      state: [...omissions].some((o) => !fixed.includes(o))
        ? ("partial" as const)
        : ("collected" as const),
      dependencyDepthLimit: 8 as const,
      anchors,
      aliases,
      dependencyEdges: closure.edges,
      counts: {
        anchors: anchors.length,
        aliases: aliases.length,
        resolvedAliases: resolved,
        unresolvedAliases: aliases.length - resolved,
      },
      fullImpactFallback: true as const,
      nativeSerializationVerified: false as const,
      consumerSemanticsVerified: false as const,
      mergeSemanticsVerified: false as const,
      validationPlanUnchanged: true as const,
      omissions: [...omissions].sort(),
    },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw Error("YAML binding metadata budget exhausted");
  return reviewYamlBehaviorSchema.parse(result);
}
export function validateYamlReviewBindings(
  analysis: YamlAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateYamlModuleRoots(roots);
  const bindings = analysis.yamlBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("YAML binding module roots differ");
  const declarations = analysis.declarations.filter(
      (d) => sourceFile(d.file) && d.kind === "variable",
    ),
    anchors = bindings.anchors,
    aliases = bindings.aliases;
  if (anchors.length !== declarations.length)
    throw Error("YAML anchor counts do not reconcile");
  for (const anchor of anchors) {
    const decl = declarations.find((d) => d.id === anchor.declarationId);
    if (
      !decl ||
      decl.name !== anchor.name ||
      decl.revision !== anchor.revision ||
      decl.file !== anchor.file ||
      decl.start !== anchor.start ||
      decl.end !== anchor.end ||
      decl.startLine !== anchor.startLine ||
      decl.endLine !== anchor.endLine ||
      anchor.documentStart > anchor.start ||
      anchor.documentEnd < anchor.end
    )
      throw Error("YAML anchor source addresses do not reconcile");
  }
  const resolved = aliases.filter((a) => a.targetDeclarationId !== null),
    counts = {
      anchors: anchors.length,
      aliases: aliases.length,
      resolvedAliases: resolved.length,
      unresolvedAliases: aliases.length - resolved.length,
    };
  if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))
    throw Error("YAML binding counts do not reconcile");
  for (const alias of aliases) {
    const target = selectedAnchor(anchors, alias);
    if (
      alias.documentStart > alias.start ||
      alias.documentEnd < alias.end ||
      (alias.resolution === "selected-anchor" &&
        (!target ||
          target.tagged ||
          target.end > alias.start ||
          target.declarationId !== alias.targetDeclarationId ||
          !beneath(alias.file, roots))) ||
      (alias.resolution !== "selected-anchor" &&
        alias.targetDeclarationId !== null)
    )
      throw Error("YAML alias candidates do not reconcile");
  }
  const publicReferences = analysis.references.filter((r) =>
      sourceFile(r.file),
    ),
    referenceKey = (
      r: ReviewBehavior["references"][number] | (typeof aliases)[number],
    ) => [
      r.revision,
      r.file,
      r.start,
      r.end,
      r.startLine,
      r.endLine,
      r.ownerDeclarationId,
      r.targetDeclarationId,
    ];
  if (
    JSON.stringify(publicReferences.map(referenceKey)) !==
    JSON.stringify(resolved.map(referenceKey))
  )
    throw Error("YAML selected references do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedAliases) mandatory.push("unresolved-alias");
  if (aliases.some((a) => a.resolution === "recursive-alias"))
    mandatory.push("recursive-alias-unknown");
  if (anchors.some((a) => a.tagged)) mandatory.push("tag-semantics-unknown");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  for (const source of sources)
    mandatory.push(...yamlSourceOmissions(source.path));
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    mandatory.push("outside-module-roots");
  if (
    !analysis.declarations.some(
      (d) => primary.includes(d.file) && sourceFile(d.file),
    )
  )
    mandatory.push("no-selected-declarations");
  const closure = yamlDependencyClosure(analysis, primary);
  if (closure.exhausted) mandatory.push("depth-limit");
  if (
    mandatory.some((o) => !bindings.omissions.includes(o)) ||
    JSON.stringify(bindings.omissions) !==
      JSON.stringify([...new Set(bindings.omissions)].sort()) ||
    bindings.state !==
      (bindings.omissions.some((o) => !fixed.includes(o))
        ? "partial"
        : "collected")
  )
    throw Error("YAML binding omissions do not reconcile");
  if (
    JSON.stringify(bindings.dependencyEdges) !== JSON.stringify(closure.edges)
  )
    throw Error("YAML dependency closure does not reconcile");
}
