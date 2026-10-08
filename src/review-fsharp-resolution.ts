import {
  reviewFsharpBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateFsharpModuleRoots,
  fsharpSourceOmissions,
  type FsharpSyntaxUnit,
  type FsharpBinding,
} from "./review-fsharp-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type FsharpAnalysis = Extract<
  ReviewBehavior,
  { profile: "fsharp-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/")),
  sourceFile = (file: string) => /\.(fs|fsx|fsi)$/.test(file);
const omissionValues =
  reviewFsharpBehaviorSchema.shape.fsharpBindings.shape.omissions.element
    .options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: FsharpSyntaxUnit; binding: FsharpBinding };
type Failure = {
  failure:
    "no-selected-definition" | "ambiguous-definition" | "unsupported-dispatch";
};
type Found = { target: Address } | Failure;
/** Ordered selected source candidates only; compilation order, assembly exports and runtime behavior are not certified. */
export function resolveFsharpBindings(
  analysis: Analysis,
  units: FsharpSyntaxUnit[],
  roots: string[],
  primary: string[],
): FsharpAnalysis {
  validateFsharpModuleRoots(roots);
  const fixed: Omission[] = [
      "unselected-source",
      "runtime-rebinding",
      "runtime-dispatch",
      "module-loading-unknown",
      "build-selection-unknown",
    ],
    omissions = new Set<Omission>(fixed),
    modules = new Map<string, FsharpSyntaxUnit[]>();
  const scopes = (unit: FsharpSyntaxUnit, scope: string) => {
    const byScope = new Map(unit.scopes.map((value) => [value.id, value])),
      output = [];
    for (
      let current = byScope.get(scope);
      current;
      current =
        current.parent === null ? undefined : byScope.get(current.parent)
    )
      output.push(current);
    return output;
  };
  const usable = (unit: FsharpSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) &&
    scopes(unit, scope).every((value) => !value.unknown);
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
    if (unit.moduleName !== null && beneath(unit.file, roots)) {
      const name = key(unit.revision, unit.moduleName);
      modules.set(name, [...(modules.get(name) ?? []), unit]);
    }
  }
  function moduleAt(
    unit: FsharpSyntaxUnit,
    name: string,
  ): { unit: FsharpSyntaxUnit } | Failure {
    const values = modules.get(key(unit.revision, name)) ?? [];
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    return values[0]!.file !== unit.file && usable(values[0]!, "file")
      ? { unit: values[0]! }
      : { failure: "unsupported-dispatch" };
  }
  function moduleName(
    unit: FsharpSyntaxUnit,
    scope: string,
    name: string,
    offset: number,
  ): { unit: FsharpSyntaxUnit } | Failure {
    const [first, ...remaining] = name.split(".");
    for (const current of scopes(unit, scope)) {
      if (
        unit.bindings.some(
          (binding) =>
            binding.scope === current.id &&
            binding.name === first &&
            binding.visibleFrom <= offset,
        )
      )
        return { failure: "unsupported-dispatch" };
      const aliases = unit.imports.filter(
        (imported) =>
          imported.scope === current.id &&
          imported.kind === "alias" &&
          imported.alias === first &&
          imported.visibleFrom <= offset,
      );
      if (aliases.length) {
        if (aliases.length !== 1) return { failure: "ambiguous-definition" };
        const alias = aliases[0]!;
        return alias.unsupported || alias.specifier === null
          ? { failure: "unsupported-dispatch" }
          : moduleAt(
              unit,
              alias.specifier +
                (remaining.length ? "." + remaining.join(".") : ""),
            );
      }
    }
    return moduleAt(unit, name);
  }
  function select(
    unit: FsharpSyntaxUnit,
    values: Address[],
    kind: "function" | "constant",
  ): Found {
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const target = values[0]!;
    return target.binding.unsupported ||
      !usable(target.unit, target.binding.scope) ||
      (target.binding.private && target.unit.file !== unit.file) ||
      (kind === "function"
        ? target.binding.kind !== "function"
        : target.binding.kind !== "value" || !target.binding.literal)
      ? { failure: "unsupported-dispatch" }
      : { target };
  }
  function exported(
    unit: FsharpSyntaxUnit,
    target: FsharpSyntaxUnit,
    name: string,
    kind: "function" | "constant",
  ): Found {
    return select(
      unit,
      target.bindings
        .filter((binding) => binding.scope === "file" && binding.name === name)
        .map((binding) => ({ unit: target, binding })),
      kind,
    );
  }
  function resolve(
    unit: FsharpSyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    kind: "function" | "constant",
    offset: number,
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    if (qualifier !== null) {
      const target = moduleName(unit, scope, qualifier, offset);
      return "unit" in target
        ? exported(unit, target.unit, name, kind)
        : target;
    }
    for (const current of scopes(unit, scope)) {
      const bindings = unit.bindings.filter(
          (binding) =>
            binding.scope === current.id &&
            binding.name === name &&
            binding.visibleFrom <= offset,
        ),
        opens = unit.imports.filter(
          (imported) =>
            imported.scope === current.id &&
            imported.kind === "open" &&
            imported.visibleFrom <= offset,
        );
      const events = [
        ...bindings.map((binding) => ({
          position: binding.visibleFrom,
          binding,
          imported: null,
        })),
        ...opens.map((imported) => ({
          position: imported.visibleFrom,
          binding: null,
          imported,
        })),
      ].sort((a, b) => b.position - a.position);
      for (const event of events) {
        if (event.binding)
          return select(unit, [{ unit, binding: event.binding }], kind);
        const imported = event.imported!;
        if (imported.unsupported || imported.specifier === null)
          return { failure: "unsupported-dispatch" };
        const target = moduleName(
          unit,
          scope,
          imported.specifier,
          imported.start,
        );
        if ("failure" in target)
          return {
            failure:
              target.failure === "ambiguous-definition"
                ? "ambiguous-definition"
                : "unsupported-dispatch",
          };
        const found = exported(unit, target.unit, name, kind);
        if ("target" in found || found.failure !== "no-selected-definition")
          return found;
      }
    }
    return { failure: "no-selected-definition" };
  }
  const files = new Set(units.map((unit) => key(unit.revision, unit.file)));
  analysis.modules = analysis.modules.filter(
    (m) => !files.has(key(m.revision, m.file)),
  );
  analysis.references = analysis.references.filter(
    (r) => !files.has(key(r.revision, r.file)),
  );
  for (const unit of units) {
    for (const imported of unit.imports) {
      const found =
        imported.unsupported ||
        imported.specifier === null ||
        !usable(unit, imported.scope)
          ? { failure: "unsupported-dispatch" as const }
          : moduleName(
              unit,
              imported.scope,
              imported.specifier,
              imported.start,
            );
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        kind: "import",
        specifier: imported.specifier,
        targetFile: "unit" in found ? found.unit.file : null,
        resolution:
          "unit" in found
            ? "selected"
            : found.failure === "ambiguous-definition"
              ? "ambiguous"
              : imported.unsupported
                ? "dynamic"
                : "external",
      });
      if ("failure" in found) {
        omissions.add("unresolved-import");
        if (found.failure === "ambiguous-definition")
          omissions.add("ambiguous-definition");
      }
    }
    const captured = new Map(unit.calls.map((c) => [c.start + ":" + c.end, c]));
    for (const call of analysis.calls.filter(
      (c) => c.revision === unit.revision && c.file === unit.file,
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
              "function",
              source.start,
            );
      if ("target" in found && found.target.binding.functionId) {
        call.targetFunctionId = found.target.binding.functionId;
        call.resolution = "lexical-binding";
      } else {
        call.targetFunctionId = null;
        call.resolution =
          "failure" in found ? found.failure : "unsupported-dispatch";
        omissions.add("unresolved-call");
        if ("failure" in found && found.failure === "ambiguous-definition")
          omissions.add("ambiguous-definition");
      }
    }
    for (const source of unit.references) {
      const found = resolve(
        unit,
        source.scope,
        source.name,
        source.qualifier,
        "constant",
        source.start,
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
    primary.filter((f) => f.endsWith(".fs")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  for (const file of analysis.files)
    for (const reason of fsharpSourceOmissions(file.file, ""))
      omissions.add(reason);
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    omissions.add("outside-module-roots");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    omissions.add("non-fsharp-source");
  if (
    !analysis.functions.some(
      (f) => f.file.endsWith(".fs") && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "fsharp-selected-bindings-v1" as const,
    fsharpBindings: {
      moduleRoots: roots,
      scope: "selected-captured-fsharp-source" as const,
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
    throw Error("Fsharp binding metadata budget exhausted");
  return reviewFsharpBehaviorSchema.parse(result);
}
export function validateFsharpReviewBindings(
  analysis: FsharpAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateFsharpModuleRoots(roots);
  const bindings = analysis.fsharpBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("Fsharp binding module roots differ");
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
    throw Error("Fsharp binding counts do not reconcile");
  const fixed: Omission[] = [
      "unselected-source",
      "runtime-rebinding",
      "runtime-dispatch",
      "module-loading-unknown",
      "build-selection-unknown",
    ],
    mandatory: Omission[] = [...fixed];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    mandatory.push("non-fsharp-source");
  for (const source of sources)
    if (sourceFile(source.path))
      mandatory.push(...fsharpSourceOmissions(source.path, source.content));
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    mandatory.push("outside-module-roots");
  if (
    !analysis.functions.some(
      (f) => f.file.endsWith(".fs") && primary.includes(f.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((f) => f.endsWith(".fs")),
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
    throw Error("Fsharp binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("Fsharp caller closure does not reconcile");
}
