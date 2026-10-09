import {
  reviewSwiftBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateSwiftModuleRoots,
  swiftSourceOmissions,
  type SwiftModuleRoot,
  type SwiftSyntaxUnit,
  type SwiftBinding,
} from "./review-swift-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type SwiftAnalysis = Extract<
  ReviewBehavior,
  { profile: "swift-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values),
  beneath = (file: string, roots: SwiftModuleRoot[]) =>
    roots.some(
      (root) => root.directory === "." || file.startsWith(root.directory + "/"),
    ),
  sourceFile = (file: string) => file.endsWith(".swift");
const omissionValues =
  reviewSwiftBehaviorSchema.shape.swiftBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: SwiftSyntaxUnit; binding: SwiftBinding };
type Failure = {
  failure:
    "no-selected-definition" | "ambiguous-definition" | "unsupported-dispatch";
};
type Found = { target: Address } | Failure;
const fixed: Omission[] = [
  "unselected-source",
  "runtime-rebinding",
  "runtime-dispatch",
  "module-loading-unknown",
  "build-selection-unknown",
  "module-identity-declared",
];
/** Operator-declared selected modules and source candidates only; no native module or build resolution. */
export function resolveSwiftBindings(
  analysis: Analysis,
  units: SwiftSyntaxUnit[],
  roots: SwiftModuleRoot[],
  primary: string[],
): SwiftAnalysis {
  validateSwiftModuleRoots(roots);
  const omissions = new Set<Omission>(fixed),
    moduleOf = (unit: SwiftSyntaxUnit) =>
      roots.find(
        (root) =>
          root.directory === "." || unit.file.startsWith(root.directory + "/"),
      )?.module ?? null;
  const scopes = (unit: SwiftSyntaxUnit, scope: string) => {
    const map = new Map(unit.scopes.map((s) => [s.id, s])),
      values: SwiftSyntaxUnit["scopes"] = [];
    for (
      let s = map.get(scope);
      s;
      s = s.parent === null ? undefined : map.get(s.parent)
    )
      values.push(s);
    return values;
  };
  const usable = (unit: SwiftSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) && scopes(unit, scope).every((s) => !s.unknown);
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const value of unit.omissions)
      if (omissionValues.includes(value as Omission))
        omissions.add(value as Omission);
  }
  function select(values: Address[], kind: "function" | "constant"): Found {
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const target = values[0]!;
    return target.binding.unsupported ||
      !usable(target.unit, target.binding.scope) ||
      (kind === "function"
        ? target.binding.kind !== "function"
        : target.binding.kind !== "constant" || !target.binding.literal)
      ? { failure: "unsupported-dispatch" }
      : { target };
  }
  const moduleUnits = (unit: SwiftSyntaxUnit, name: string) =>
    units.filter(
      (value) => value.revision === unit.revision && moduleOf(value) === name,
    );
  const named = (
    unit: SwiftSyntaxUnit,
    name: string,
    from: SwiftSyntaxUnit,
    foreign: boolean,
  ) =>
    unit.bindings
      .filter(
        (binding) =>
          binding.scope === "file" &&
          binding.name === name &&
          (foreign
            ? binding.access === "public"
            : binding.access !== "file" || unit.file === from.file),
      )
      .map((binding) => ({ unit, binding }));
  function resolve(
    unit: SwiftSyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    position: number,
    kind: "function" | "constant",
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    const lexical = scopes(unit, scope),
      own = moduleOf(unit);
    if (qualifier !== null) {
      if (
        lexical.some((s) =>
          unit.bindings.some(
            (b) =>
              b.scope === s.id &&
              b.name === qualifier &&
              b.visibleFrom <= position,
          ),
        )
      )
        return { failure: "unsupported-dispatch" };
      if (
        qualifier !== own &&
        !unit.imports.some(
          (value) => !value.unsupported && value.specifier === qualifier,
        )
      )
        return { failure: "no-selected-definition" };
      return select(
        moduleUnits(unit, qualifier).flatMap((value) =>
          named(value, name, unit, qualifier !== own),
        ),
        kind,
      );
    }
    for (const current of lexical.filter((value) => value.id !== "file")) {
      const values = unit.bindings.filter(
        (b) =>
          b.scope === current.id &&
          b.name === name &&
          b.visibleFrom <= position,
      );
      if (values.length)
        return select(
          values.map((binding) => ({ unit, binding })),
          kind,
        );
    }
    const local =
      own === null
        ? []
        : moduleUnits(unit, own).flatMap((value) =>
            named(value, name, unit, false),
          );
    if (local.length) return select(local, kind);
    const imports = [
      ...new Set(
        unit.imports
          .filter((value) => !value.unsupported && value.specifier !== null)
          .map((value) => value.specifier!),
      ),
    ];
    return select(
      imports.flatMap((module) =>
        moduleUnits(unit, module).flatMap((value) =>
          named(value, name, unit, true),
        ),
      ),
      kind,
    );
  }
  const files = new Set(units.map((unit) => key(unit.revision, unit.file)));
  analysis.modules = analysis.modules.filter(
    (value) => !files.has(key(value.revision, value.file)),
  );
  analysis.references = analysis.references.filter(
    (value) => !files.has(key(value.revision, value.file)),
  );
  for (const unit of units) {
    for (const imported of unit.imports) {
      const selected =
        imported.specifier === null
          ? []
          : moduleUnits(unit, imported.specifier);
      const resolution: ReviewBehavior["modules"][number]["resolution"] =
        imported.unsupported || !usable(unit, "file")
          ? "dynamic"
          : selected.length === 1
            ? usable(selected[0]!, "file")
              ? "selected"
              : "unparsed"
            : selected.length
              ? "ambiguous"
              : "external";
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        kind: "import",
        specifier: imported.specifier,
        targetFile:
          resolution === "selected" || resolution === "unparsed"
            ? selected[0]!.file
            : null,
        resolution,
      });
      if (resolution !== "selected") omissions.add("unresolved-import");
    }
    const captured = new Map(
      unit.calls.map((call) => [call.start + ":" + call.end, call]),
    );
    for (const call of analysis.calls.filter(
      (call) => call.revision === unit.revision && call.file === unit.file,
    )) {
      const source = captured.get(call.start + ":" + call.end);
      call.callerFunctionId = source?.caller ?? null;
      const found =
        !source || source.unsupported || source.name === null
          ? { failure: "unsupported-dispatch" as const }
          : resolve(
              unit,
              source.scope,
              source.name,
              source.qualifier,
              source.start,
              "function",
            );
      if ("target" in found) {
        call.resolution = "lexical-binding";
        call.targetFunctionId = found.target.binding.functionId;
      } else {
        call.resolution = found.failure;
        call.targetFunctionId = null;
        omissions.add("unresolved-call");
        if (found.failure === "ambiguous-definition")
          omissions.add("ambiguous-definition");
      }
    }
    for (const source of unit.references) {
      const found = resolve(
        unit,
        source.scope,
        source.name,
        source.qualifier,
        source.start,
        "constant",
      );
      if ("target" in found && found.target.binding.declarationId)
        analysis.references.push({
          revision: source.revision,
          file: source.file,
          start: source.start,
          end: source.end,
          startLine: source.startLine,
          endLine: source.endLine,
          fromFunctionId: source.caller,
          ownerDeclarationId: source.declaration,
          targetDeclarationId: found.target.binding.declarationId,
        });
    }
  }
  const calls = analysis.calls.filter((c) =>
      files.has(key(c.revision, c.file)),
    ),
    imports = analysis.modules.filter((m) =>
      files.has(key(m.revision, m.file)),
    ),
    resolvedCalls = calls.filter(
      (c) => c.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter((m) => m.resolution === "selected").length;
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((f) => sourceFile(f)),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  for (const file of analysis.files)
    for (const reason of swiftSourceOmissions(file.file, ""))
      omissions.add(reason);
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    omissions.add("outside-module-roots");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    omissions.add("non-swift-source");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "swift-selected-bindings-v1" as const,
    swiftBindings: {
      moduleRoots: roots,
      scope: "selected-captured-swift-source" as const,
      state: [...omissions].some((o) => !fixed.includes(o))
        ? ("partial" as const)
        : ("collected" as const),
      callerDepthLimit: 8 as const,
      callerEdges: closure.edges,
      counts: {
        calls: calls.length,
        resolvedCalls,
        unresolvedCalls: calls.length - resolvedCalls,
        imports: imports.length,
        resolvedImports,
        unresolvedImports: imports.length - resolvedImports,
      },
      fullImpactFallback: true as const,
      runtimeReachabilityVerified: false as const,
      nativeNameResolutionVerified: false as const,
      moduleLoadingVerified: false as const,
      validationPlanUnchanged: true as const,
      omissions: [...omissions].sort(),
    },
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) > 262144 ||
    analysis.modules.length > 512 ||
    analysis.references.length > 8192
  )
    throw Error("Swift binding metadata budget exhausted");
  return reviewSwiftBehaviorSchema.parse(result);
}
export function validateSwiftReviewBindings(
  analysis: SwiftAnalysis,
  roots: SwiftModuleRoot[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateSwiftModuleRoots(roots);
  const bindings = analysis.swiftBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("Swift binding module roots differ");
  const files = new Set(
    analysis.files
      .filter((f) => f.state === "collected" && sourceFile(f.file))
      .map((f) => key(f.revision, f.file)),
  );
  const calls = analysis.calls.filter((c) =>
      files.has(key(c.revision, c.file)),
    ),
    imports = analysis.modules.filter((m) =>
      files.has(key(m.revision, m.file)),
    ),
    resolvedCalls = calls.filter(
      (c) => c.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter((m) => m.resolution === "selected").length;
  const counts = {
    calls: calls.length,
    resolvedCalls,
    unresolvedCalls: calls.length - resolvedCalls,
    imports: imports.length,
    resolvedImports,
    unresolvedImports: imports.length - resolvedImports,
  };
  if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))
    throw Error("Swift binding counts do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    mandatory.push("non-swift-source");
  for (const source of sources)
    if (sourceFile(source.path))
      mandatory.push(...swiftSourceOmissions(source.path, source.content));
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    mandatory.push("outside-module-roots");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((f) => sourceFile(f)),
  );
  if (closure.exhausted) mandatory.push("depth-limit");
  if (
    mandatory.some((v) => !bindings.omissions.includes(v)) ||
    JSON.stringify(bindings.omissions) !==
      JSON.stringify([...new Set(bindings.omissions)].sort()) ||
    bindings.state !==
      (bindings.omissions.some((o) => !fixed.includes(o))
        ? "partial"
        : "collected")
  )
    throw Error("Swift binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("Swift caller closure does not reconcile");
}
