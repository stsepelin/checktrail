import {
  reviewScalaBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateScalaModuleRoots,
  type ScalaSyntaxUnit,
  type ScalaBinding,
} from "./review-scala-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type ScalaAnalysis = Extract<
  ReviewBehavior,
  { profile: "scala-selected-bindings-v1" }
>;
const key = (...v: string[]) => JSON.stringify(v);
const omissionValues =
  reviewScalaBehaviorSchema.shape.scalaBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: ScalaSyntaxUnit; binding: ScalaBinding };
type Found =
  | { target: Address }
  | {
      failure:
        | "no-selected-definition"
        | "ambiguous-definition"
        | "unsupported-dispatch";
    };
const beneath = (file: string, roots: string[]) =>
  roots.some((root) => root === "." || file.startsWith(root + "/"));
/** Plain selected Scala 3 term candidates only; compiler overloads and implicit behavior remain unknown. */
export function resolveScalaBindings(
  analysis: Analysis,
  units: ScalaSyntaxUnit[],
  roots: string[],
  primary: string[],
): ScalaAnalysis {
  validateScalaModuleRoots(roots);
  const fixed: Omission[] = [
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
    "build-selection-unknown",
  ];
  const omissions = new Set<Omission>(fixed),
    declarations = new Map<string, Address[]>();
  const scopes = (unit: ScalaSyntaxUnit, scope: string) => {
    const byScope = new Map(unit.scopes.map((s) => [s.id, s])),
      out = [];
    for (
      let s = byScope.get(scope);
      s;
      s = s.parent === null ? undefined : byScope.get(s.parent)
    )
      out.push(s);
    return out;
  };
  const usable = (unit: ScalaSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) && scopes(unit, scope).every((s) => !s.unknown);
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
    if (unit.packageName === null || !beneath(unit.file, roots)) continue;
    for (const binding of unit.bindings.filter((b) => b.scope === "file")) {
      const address = key(
        unit.revision,
        (unit.packageName ? unit.packageName + "." : "") + binding.name,
      );
      declarations.set(address, [
        ...(declarations.get(address) ?? []),
        { unit, binding },
      ]);
    }
  }
  function select(
    unit: ScalaSyntaxUnit,
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
    if (
      target.binding.kind !== kind ||
      target.binding.unsupported ||
      !usable(target.unit, target.binding.scope) ||
      (target.binding.private && target.unit.packageName !== unit.packageName)
    )
      return { failure: "unsupported-dispatch" };
    return { target };
  }
  const exact = (
    unit: ScalaSyntaxUnit,
    name: string,
    kind: "function" | "constant",
  ) => select(unit, declarations.get(key(unit.revision, name)) ?? [], kind);
  function importReceiver(unit: ScalaSyntaxUnit, specifier: string): boolean {
    const first = specifier.split(".")[0]!;
    const samePackage =
      (unit.packageName ? unit.packageName + "." : "") + first;
    const valueReceiver =
      (declarations.get(key(unit.revision, samePackage)) ?? []).length > 0;
    const importedReceiver = unit.imports.some(
      (imported) => imported.alias === first,
    );
    return valueReceiver || importedReceiver;
  }
  function resolve(
    unit: ScalaSyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    kind: "function" | "constant",
    offset: number,
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    if (qualifier !== null) {
      const first = qualifier.split(".")[0]!;
      if (
        scopes(unit, scope).some((s) =>
          unit.bindings.some(
            (b) =>
              b.scope === s.id && b.name === first && b.visibleFrom <= offset,
          ),
        ) ||
        unit.imports.some((i) => i.alias === first)
      )
        return { failure: "unsupported-dispatch" };
      return exact(unit, qualifier + "." + name, kind);
    }
    for (const current of scopes(unit, scope).filter(
      (s) => s.kind !== "file",
    )) {
      const values = unit.bindings.filter(
        (b) =>
          b.scope === current.id && b.name === name && b.visibleFrom <= offset,
      );
      if (values.length)
        return select(
          unit,
          values.map((binding) => ({ unit, binding })),
          kind,
        );
    }
    const inFile = unit.bindings.filter(
      (b) => b.scope === "file" && b.name === name,
    );
    if (inFile.length)
      return select(
        unit,
        inFile.map((binding) => ({ unit, binding })),
        kind,
      );
    const imported = unit.imports.filter(
      (i) => i.scope === "file" && i.alias === name,
    );
    if (imported.length !== 0) {
      if (imported.length !== 1) return { failure: "ambiguous-definition" };
      const item = imported[0]!;
      return item.unsupported ||
        item.specifier === null ||
        importReceiver(unit, item.specifier)
        ? { failure: "unsupported-dispatch" }
        : exact(unit, item.specifier, kind);
    }
    return unit.packageName === null
      ? { failure: "unsupported-dispatch" }
      : exact(
          unit,
          (unit.packageName ? unit.packageName + "." : "") + name,
          kind,
        );
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
      let found: Found = { failure: "unsupported-dispatch" };
      if (
        !imported.unsupported &&
        imported.specifier !== null &&
        usable(unit, "file") &&
        !importReceiver(unit, imported.specifier)
      ) {
        const values =
          declarations.get(key(unit.revision, imported.specifier)) ?? [];
        found =
          values.length === 1
            ? select(
                unit,
                values,
                values[0]!.binding.kind === "constant"
                  ? "constant"
                  : "function",
              )
            : {
                failure: values.length
                  ? "ambiguous-definition"
                  : "no-selected-definition",
              };
      }
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        kind: "import",
        specifier: imported.specifier,
        targetFile: "target" in found ? found.target.unit.file : null,
        resolution:
          "target" in found
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
    primary.filter((f) => f.endsWith(".scala")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((f) => f.file.endsWith(".sc")))
    omissions.add("script-loading-unknown");
  if (
    analysis.files.some(
      (f) =>
        (f.file.endsWith(".scala") || f.file.endsWith(".sc")) &&
        !beneath(f.file, roots),
    )
  )
    omissions.add("outside-module-roots");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (
    analysis.files.some(
      (f) => !f.file.endsWith(".scala") && !f.file.endsWith(".sc"),
    )
  )
    omissions.add("non-scala-source");
  if (
    !analysis.functions.some(
      (f) => f.file.endsWith(".scala") && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "scala-selected-bindings-v1" as const,
    scalaBindings: {
      moduleRoots: roots,
      scope: "selected-captured-scala-source" as const,
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
    throw Error("Scala binding metadata budget exhausted");
  return reviewScalaBehaviorSchema.parse(result);
}
export function validateScalaReviewBindings(
  analysis: ScalaAnalysis,
  roots: string[],
  primary: string[],
): void {
  validateScalaModuleRoots(roots);
  const bindings = analysis.scalaBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("Scala binding module roots differ");
  const files = new Set(
    analysis.files
      .filter(
        (f) =>
          f.state === "collected" &&
          (f.file.endsWith(".scala") || f.file.endsWith(".sc")),
      )
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
    throw Error("Scala binding counts do not reconcile");
  const fixed: Omission[] = [
      "unselected-source",
      "runtime-rebinding",
      "runtime-dispatch",
      "module-loading-unknown",
      "build-selection-unknown",
    ],
    mandatory: Omission[] = [...fixed];
  if (calls.some((call) => call.kind === "construct"))
    mandatory.push("constructor-dispatch-unknown");
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (
    analysis.files.some(
      (f) => !f.file.endsWith(".scala") && !f.file.endsWith(".sc"),
    )
  )
    mandatory.push("non-scala-source");
  if (analysis.files.some((f) => f.file.endsWith(".sc")))
    mandatory.push("script-loading-unknown");
  if (
    analysis.files.some(
      (f) =>
        (f.file.endsWith(".scala") || f.file.endsWith(".sc")) &&
        !beneath(f.file, roots),
    )
  )
    mandatory.push("outside-module-roots");
  if (
    !analysis.functions.some(
      (f) => f.file.endsWith(".scala") && primary.includes(f.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((f) => f.endsWith(".scala")),
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
    throw Error("Scala binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("Scala caller closure does not reconcile");
}
