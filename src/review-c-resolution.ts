import path from "node:path";
import {
  reviewCBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateCModuleRoots,
  cSourceOmissions,
  type CSyntaxUnit,
  type CBinding,
} from "./review-c-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type CAnalysis = Extract<ReviewBehavior, { profile: "c-selected-bindings-v1" }>;
const key = (...values: string[]) => JSON.stringify(values),
  sourceFile = (file: string) => /\.(?:c|h)$/.test(file),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/"));
const omissionValues =
  reviewCBehaviorSchema.shape.cBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: CSyntaxUnit; binding: CBinding };
type Failure = {
  failure:
    "unsupported-dispatch" | "no-selected-definition" | "ambiguous-definition";
};
type Found = { target: Address } | Failure;
const fixed: Omission[] = [
  "unselected-source",
  "runtime-dispatch",
  "module-loading-unknown",
  "build-selection-unknown",
  "translation-unit-unknown",
  "linkage-unknown",
];
/** Selected include/declaration candidates only; no native preprocessing, search-path, ABI or linkage proof. */
export function resolveCBindings(
  analysis: Analysis,
  units: CSyntaxUnit[],
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): CAnalysis {
  validateCModuleRoots(roots);
  const omissions = new Set<Omission>(fixed);
  const scopes = (unit: CSyntaxUnit, scope: string) => {
    const map = new Map(unit.scopes.map((s) => [s.id, s])),
      values: CSyntaxUnit["scopes"] = [];
    for (
      let s = map.get(scope);
      s;
      s = s.parent === null ? undefined : map.get(s.parent)
    )
      values.push(s);
    return values;
  };
  const usable = (unit: CSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) && scopes(unit, scope).every((s) => !s.unknown);
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const value of unit.omissions)
      if (omissionValues.includes(value as Omission))
        omissions.add(value as Omission);
  }
  function include(
    unit: CSyntaxUnit,
    imported: CSyntaxUnit["imports"][number],
  ) {
    if (imported.unsupported || imported.specifier === null)
      return { state: "dynamic" as const, unit: null };
    if (path.posix.isAbsolute(imported.specifier))
      return { state: "outside-root" as const, unit: null };
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(unit.file), imported.specifier),
    );
    const owner = roots.find(
      (root) => root === "." || unit.file.startsWith(root + "/"),
    );
    if (
      target.startsWith("../") ||
      path.posix.isAbsolute(target) ||
      owner === undefined ||
      !beneath(target, [owner])
    )
      return { state: "outside-root" as const, unit: null };
    const selected = units.filter(
      (value) =>
        value.revision === unit.revision &&
        value.file === target &&
        value.file.endsWith(".h"),
    );
    return selected.length === 1
      ? { state: "selected" as const, unit: selected[0]! }
      : {
          state: selected.length
            ? ("ambiguous" as const)
            : ("external" as const),
          unit: null,
        };
  }
  // Before choosing any name, every visible include must be usable: an unknown header may define macros for that name.
  function visible(
    unit: CSyntaxUnit,
    position: number,
    visited: Set<string>,
    depth = 0,
    budget = { remaining: 256 },
  ): { values: Address[]; unknown: boolean } {
    const id = key(unit.revision, unit.file);
    if (depth >= 8 || visited.has(id) || budget.remaining-- <= 0) {
      omissions.add("include-depth-limit");
      return { values: [], unknown: true };
    }
    const next = new Set(visited);
    next.add(id);
    const values = unit.bindings
      .filter((b) => b.scope === "file" && b.visibleFrom <= position)
      .map((binding) => ({ unit, binding }));
    let unknown = !usable(unit, "file");
    for (const imported of unit.imports.filter(
      (value) => value.end <= position,
    )) {
      const target = include(unit, imported);
      if (!target.unit) {
        unknown = true;
        continue;
      }
      const nested = visible(
        target.unit,
        Number.MAX_SAFE_INTEGER,
        next,
        depth + 1,
        budget,
      );
      values.push(...nested.values);
      if (values.length > 4096) {
        omissions.add("include-depth-limit");
        return { values: [], unknown: true };
      }
      unknown ||= nested.unknown;
    }
    return { values, unknown };
  }
  function select(values: Address[], kind: "function" | "constant"): Found {
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const target = values[0]!;
    if (
      target.binding.unsupported ||
      !usable(target.unit, target.binding.scope) ||
      (kind === "function"
        ? target.binding.kind !== "function"
        : target.binding.kind !== "constant" || !target.binding.literal)
    )
      return { failure: "unsupported-dispatch" };
    return { target };
  }
  function resolve(
    unit: CSyntaxUnit,
    scope: string,
    name: string,
    position: number,
    kind: "function" | "constant",
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    const expanded = visible(unit, position, new Set());
    if (expanded.unknown) return { failure: "unsupported-dispatch" };
    for (const current of scopes(unit, scope).filter((s) => s.id !== "file")) {
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
    return select(
      expanded.values.filter((v) => v.binding.name === name),
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
      const found = include(unit, imported),
        target = found.unit;
      const resolution: ReviewBehavior["modules"][number]["resolution"] =
        imported.unsupported || !usable(unit, "file")
          ? "dynamic"
          : target
            ? usable(target, "file")
              ? "selected"
              : "unparsed"
            : found.state === "ambiguous"
              ? "ambiguous"
              : found.state === "outside-root"
                ? "outside-root"
                : "external";
      analysis.modules.push({
        ...imported,
        kind: "import",
        specifier: imported.specifier,
        targetFile:
          resolution === "selected" || resolution === "unparsed"
            ? target!.file
            : null,
        resolution,
      });
      // Internal capture fields are omitted from the public strict schema.
      const added = analysis.modules[
        analysis.modules.length - 1
      ]! as ReviewBehavior["modules"][number] & { unsupported?: boolean };
      delete added.unsupported;
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
          : resolve(unit, source.scope, source.name, source.start, "function");
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
  const closure = pythonCallerClosure(analysis, primary.filter(sourceFile));
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    omissions.add("outside-module-roots");
  for (const source of sources)
    if (sourceFile(source.path))
      for (const omission of cSourceOmissions(source.path, source.content))
        omissions.add(omission);
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    omissions.add("non-c-source");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "c-selected-bindings-v1" as const,
    cBindings: {
      moduleRoots: roots,
      scope: "selected-captured-c-source" as const,
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
    throw Error("C binding metadata budget exhausted");
  return reviewCBehaviorSchema.parse(result);
}
export function validateCReviewBindings(
  analysis: CAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateCModuleRoots(roots);
  const bindings = analysis.cBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("C binding module roots differ");
  const files = new Set(
      analysis.files
        .filter((f) => f.state === "collected" && sourceFile(f.file))
        .map((f) => key(f.revision, f.file)),
    ),
    calls = analysis.calls.filter((c) => files.has(key(c.revision, c.file))),
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
    throw Error("C binding counts do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    mandatory.push("non-c-source");
  for (const source of sources)
    if (sourceFile(source.path))
      mandatory.push(...cSourceOmissions(source.path, source.content));
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    mandatory.push("outside-module-roots");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(analysis, primary.filter(sourceFile));
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
    throw Error("C binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("C caller closure does not reconcile");
}
