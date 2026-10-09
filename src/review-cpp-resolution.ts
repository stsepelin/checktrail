import path from "node:path";
import {
  reviewCppBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateCppModuleRoots,
  cppSourceOmissions,
  type CppSyntaxUnit,
  type CppBinding,
} from "./review-cpp-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type CppAnalysis = Extract<
  ReviewBehavior,
  { profile: "cpp-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values),
  sourceFile = (file: string) => /\.(?:cc|cpp|cxx|h|hpp|hh|hxx)$/.test(file),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/"));
const omissionValues =
  reviewCppBehaviorSchema.shape.cppBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: CppSyntaxUnit; binding: CppBinding };
type Alias = CppSyntaxUnit["aliases"][number];
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
  "type-and-overload-selection-unknown",
];
/** Selected include/declaration candidates only; no native preprocessing, search-path, ABI or linkage proof. */
export function resolveCppBindings(
  analysis: Analysis,
  units: CppSyntaxUnit[],
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): CppAnalysis {
  validateCppModuleRoots(roots);
  const omissions = new Set<Omission>(fixed);
  const scopes = (unit: CppSyntaxUnit, scope: string) => {
    const map = new Map(unit.scopes.map((s) => [s.id, s])),
      values: CppSyntaxUnit["scopes"] = [];
    for (
      let s = map.get(scope);
      s;
      s = s.parent === null ? undefined : map.get(s.parent)
    )
      values.push(s);
    return values;
  };
  const usable = (unit: CppSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) && scopes(unit, scope).every((s) => !s.unknown);
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const value of unit.omissions)
      if (omissionValues.includes(value as Omission))
        omissions.add(value as Omission);
  }
  function include(
    unit: CppSyntaxUnit,
    imported: CppSyntaxUnit["imports"][number],
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
        /\.(?:h|hpp|hh|hxx)$/.test(value.file),
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
    unit: CppSyntaxUnit,
    position: number,
    visited: Set<string>,
    depth = 0,
    budget = { remaining: 256 },
  ): { values: Address[]; aliases: Alias[]; unknown: boolean } {
    const id = key(unit.revision, unit.file);
    if (depth >= 8 || visited.has(id) || budget.remaining-- <= 0) {
      omissions.add("include-depth-limit");
      return { values: [], aliases: [], unknown: true };
    }
    const next = new Set(visited);
    next.add(id);
    const values = unit.bindings
      .filter(
        (b) =>
          (b.scope === "file" || b.scope.startsWith("namespace:")) &&
          b.visibleFrom <= position,
      )
      .map((binding) => ({ unit, binding }));
    const aliases = unit.aliases.filter(
      (alias) => alias.scope === "file" && alias.visibleFrom <= position,
    );
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
      aliases.push(...nested.aliases);
      if (values.length + aliases.length > 4096) {
        omissions.add("include-depth-limit");
        return { values: [], aliases: [], unknown: true };
      }
      unknown ||= nested.unknown;
    }
    return { values, aliases, unknown };
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
  function qualifierNamespace(
    visibleAliases: Alias[],
    qualifier: string,
  ): { namespace: string } | Failure {
    if (qualifier === "") return { namespace: "file" };
    let name = qualifier;
    const visited = new Set<string>();
    for (let depth = 0; depth < 8; depth++) {
      if (visited.has(name)) {
        omissions.add("namespace-alias-depth-limit");
        return { failure: "ambiguous-definition" };
      }
      visited.add(name);
      const aliases = visibleAliases.filter((alias) => alias.name === name);
      if (aliases.length === 0) return { namespace: "namespace:" + name };
      if (aliases.length !== 1) return { failure: "ambiguous-definition" };
      const alias = aliases[0]!;
      if (alias.unsupported || alias.target === null)
        return { failure: "unsupported-dispatch" };
      name = alias.target;
    }
    omissions.add("namespace-alias-depth-limit");
    return { failure: "unsupported-dispatch" };
  }
  function resolve(
    unit: CppSyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    position: number,
    kind: "function" | "constant",
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    const expanded = visible(unit, position, new Set());
    if (expanded.unknown) return { failure: "unsupported-dispatch" };
    if (qualifier !== null) {
      // A value named P does not hide namespace P in P::member; native witness records this distinction.
      const namespace = qualifierNamespace(expanded.aliases, qualifier);
      if ("failure" in namespace) return namespace;
      return select(
        expanded.values.filter(
          (value) =>
            value.binding.scope === namespace.namespace &&
            value.binding.name === name,
        ),
        kind,
      );
    }
    for (const current of scopes(unit, scope).filter(
      (current) => current.id !== "file",
    )) {
      const values = current.id.startsWith("namespace:")
        ? expanded.values.filter(
            (value) =>
              value.binding.scope === current.id && value.binding.name === name,
          )
        : unit.bindings
            .filter(
              (binding) =>
                binding.scope === current.id &&
                binding.name === name &&
                binding.visibleFrom <= position,
            )
            .map((binding) => ({ unit, binding }));
      if (values.length) return select(values, kind);
    }
    return select(
      expanded.values.filter(
        (value) =>
          value.binding.scope === "file" && value.binding.name === name,
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
  const closure = pythonCallerClosure(analysis, primary.filter(sourceFile));
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    omissions.add("outside-module-roots");
  for (const source of sources)
    if (sourceFile(source.path))
      for (const omission of cppSourceOmissions(source.path, source.content))
        omissions.add(omission);
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    omissions.add("non-cpp-source");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "cpp-selected-bindings-v1" as const,
    cppBindings: {
      moduleRoots: roots,
      scope: "selected-captured-cpp-source" as const,
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
    throw Error("C++ binding metadata budget exhausted");
  return reviewCppBehaviorSchema.parse(result);
}
export function validateCppReviewBindings(
  analysis: CppAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateCppModuleRoots(roots);
  const bindings = analysis.cppBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("C++ binding module roots differ");
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
    throw Error("C++ binding counts do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    mandatory.push("non-cpp-source");
  for (const source of sources)
    if (sourceFile(source.path))
      mandatory.push(...cppSourceOmissions(source.path, source.content));
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
    throw Error("C++ binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("C++ caller closure does not reconcile");
}
