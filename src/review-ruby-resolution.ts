import path from "node:path";
import {
  reviewRubyBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateRubyModuleRoots,
  rubySourceOmissions,
  type RubySyntaxUnit,
  type RubyBinding,
} from "./review-ruby-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type RubyAnalysis = Extract<
  ReviewBehavior,
  { profile: "ruby-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/")),
  sourceFile = (file: string) => file.endsWith(".rb");
const omissionValues =
  reviewRubyBehaviorSchema.shape.rubyBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: RubySyntaxUnit; binding: RubyBinding };
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
];
/** Unique selected module and singleton candidates only; Ruby loading, reopening, mixins and runtime symbols are not certified. */
export function resolveRubyBindings(
  analysis: Analysis,
  units: RubySyntaxUnit[],
  roots: string[],
  primary: string[],
): RubyAnalysis {
  validateRubyModuleRoots(roots);
  const omissions = new Set<Omission>(fixed),
    modules = new Map<string, RubySyntaxUnit[]>();
  const scopes = (unit: RubySyntaxUnit, scope: string) => {
    const map = new Map(unit.scopes.map((s) => [s.id, s])),
      values: RubySyntaxUnit["scopes"] = [];
    for (
      let s = map.get(scope);
      s;
      s = s.parent === null ? undefined : map.get(s.parent)
    )
      values.push(s);
    return values;
  };
  const usable = (unit: RubySyntaxUnit, scope: string) =>
    beneath(unit.file, roots) &&
    scopes(unit, scope).every((value) => !value.unknown);
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const value of unit.omissions)
      if (omissionValues.includes(value as Omission))
        omissions.add(value as Omission);
    if (unit.moduleName !== null && beneath(unit.file, roots)) {
      const name = key(unit.revision, unit.moduleName);
      modules.set(name, [...(modules.get(name) ?? []), unit]);
    }
  }
  function moduleAt(
    unit: RubySyntaxUnit,
    name: string,
  ): { unit: RubySyntaxUnit } | Failure {
    const values = modules.get(key(unit.revision, name)) ?? [];
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    return usable(values[0]!, "file")
      ? { unit: values[0]! }
      : { failure: "unsupported-dispatch" };
  }
  function moduleName(
    unit: RubySyntaxUnit,
    name: string,
    absolute: boolean,
  ): { unit: RubySyntaxUnit } | Failure {
    const first = name.split("::")[0]!;
    if (
      !absolute &&
      unit.bindings.some(
        (binding) =>
          binding.scope === "file" &&
          binding.kind === "constant" &&
          binding.name === first,
      )
    )
      return { failure: "unsupported-dispatch" };
    return moduleAt(unit, name);
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
  function exported(
    target: RubySyntaxUnit,
    name: string,
    kind: "function" | "constant",
  ): Found {
    return select(
      target.bindings
        .filter(
          (binding) =>
            binding.scope === "file" &&
            binding.name === name &&
            binding.kind === kind,
        )
        .map((binding) => ({ unit: target, binding })),
      kind,
    );
  }
  function resolve(
    unit: RubySyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    absolute: boolean,
    kind: "function" | "constant",
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    if (kind === "constant" && qualifier === null && absolute)
      return { failure: "no-selected-definition" };
    const target =
      qualifier === null
        ? unit.moduleName === null
          ? { failure: "unsupported-dispatch" as const }
          : moduleAt(unit, unit.moduleName)
        : moduleName(unit, qualifier, absolute);
    return "unit" in target ? exported(target.unit, name, kind) : target;
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
      let target: RubySyntaxUnit | undefined;
      let resolution: ReviewBehavior["modules"][number]["resolution"] =
        "external";
      if (imported.unsupported || !usable(unit, "file")) resolution = "dynamic";
      else if (
        imported.specifier !== null &&
        !path.posix.isAbsolute(imported.specifier) &&
        !imported.specifier.includes("\\") &&
        !imported.specifier.includes("\0")
      ) {
        const raw = path.posix.normalize(
            path.posix.join(path.posix.dirname(unit.file), imported.specifier),
          ),
          file = raw.endsWith(".rb") ? raw : raw + ".rb";
        if (raw !== ".." && !raw.startsWith("../") && beneath(file, roots)) {
          target = units.find(
            (value) =>
              value.revision === unit.revision &&
              value.file === file &&
              usable(value, "file"),
          );
          if (target) resolution = "selected";
        }
      }
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        specifier: imported.specifier,
        kind: "import",
        targetFile: target?.file ?? null,
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
              source.absolute,
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
        source.absolute,
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
    for (const reason of rubySourceOmissions(file.file, ""))
      omissions.add(reason);
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    omissions.add("outside-module-roots");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    omissions.add("non-ruby-source");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "ruby-selected-bindings-v1" as const,
    rubyBindings: {
      moduleRoots: roots,
      scope: "selected-captured-ruby-source" as const,
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
    throw Error("Ruby binding metadata budget exhausted");
  return reviewRubyBehaviorSchema.parse(result);
}
export function validateRubyReviewBindings(
  analysis: RubyAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateRubyModuleRoots(roots);
  const bindings = analysis.rubyBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("Ruby binding module roots differ");
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
    throw Error("Ruby binding counts do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    mandatory.push("non-ruby-source");
  for (const source of sources)
    if (sourceFile(source.path))
      mandatory.push(...rubySourceOmissions(source.path, source.content));
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
    throw Error("Ruby binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("Ruby caller closure does not reconcile");
}
