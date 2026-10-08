import {
  reviewJavaBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateJavaModuleRoots,
  type JavaSyntaxUnit,
  type JavaType,
  type JavaBinding,
} from "./review-java-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type JavaAnalysis = Extract<
  ReviewBehavior,
  { profile: "java-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values);
const omissionValues =
  reviewJavaBehaviorSchema.shape.javaBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type TypeAddress = { unit: JavaSyntaxUnit; type: JavaType };
type Found =
  | { target: TypeAddress; binding: JavaBinding | null }
  | {
      failure:
        | "no-selected-definition"
        | "ambiguous-definition"
        | "unsupported-dispatch";
    };
const beneath = (file: string, roots: string[]) =>
  roots.some((root) => root === "." || file.startsWith(root + "/"));
/** Resolve bounded literal Java source candidates; compiler overload selection and all runtime behavior remain unverified. */
export function resolveJavaBindings(
  analysis: Analysis,
  units: JavaSyntaxUnit[],
  roots: string[],
  primary: string[],
): JavaAnalysis {
  validateJavaModuleRoots(roots);
  const omissions = new Set<Omission>([
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
    "build-selection-unknown",
  ]);
  const selected = units.filter((unit) => beneath(unit.file, roots));
  const types = new Map<string, TypeAddress[]>();
  for (const unit of selected)
    for (const type of unit.types) {
      if (type.qualifiedName === null) continue;
      const address = key(unit.revision, type.qualifiedName);
      types.set(address, [...(types.get(address) ?? []), { unit, type }]);
    }
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
  }
  function scopes(unit: JavaSyntaxUnit, scope: string) {
    const byScope = new Map(unit.scopes.map((s) => [s.id, s]));
    const output = [];
    for (
      let current = byScope.get(scope);
      current;
      current =
        current.parent === null ? undefined : byScope.get(current.parent)
    )
      output.push(current);
    return output;
  }
  const usable = (unit: JavaSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) && scopes(unit, scope).every((s) => !s.unknown);
  const ownerType = (
    unit: JavaSyntaxUnit,
    scope: string,
  ): TypeAddress | null => {
    const owner = scopes(unit, scope).find((s) => s.kind === "class")?.id;
    const type = unit.types.find((t) => t.scope === owner);
    return type ? { unit, type } : null;
  };
  function typeAt(unit: JavaSyntaxUnit, name: string): Found {
    const values = types.get(key(unit.revision, name)) ?? [];
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const target = values[0]!;
    if (
      target.type.unsupported ||
      !usable(target.unit, target.type.scope) ||
      (target.unit.packageName !== unit.packageName &&
        scopes(target.unit, target.type.scope).some(
          (scope) =>
            scope.kind === "class" &&
            !target.unit.types.find((type) => type.scope === scope.id)?.public,
        ))
    )
      return { failure: "unsupported-dispatch" };
    return { target, binding: null };
  }
  const shadowed = (
    unit: JavaSyntaxUnit,
    scope: string,
    name: string,
    offset: number,
  ) =>
    scopes(unit, scope).some((s) =>
      unit.bindings.some(
        (b) =>
          b.scope === s.id &&
          b.name === name &&
          b.visibleFrom <= offset &&
          (b.kind === "local" || b.kind === "field"),
      ),
    );
  function typeName(
    unit: JavaSyntaxUnit,
    scope: string,
    name: string,
    offset: number,
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    const parts = name.split("."),
      first = parts[0]!;
    if (shadowed(unit, scope, first, offset))
      return { failure: "unsupported-dispatch" };
    for (const s of scopes(unit, scope)) {
      const local = unit.bindings.filter(
        (b) =>
          b.scope === s.id &&
          b.kind === "type" &&
          b.name === first &&
          b.visibleFrom <= offset,
      );
      if (local.length) {
        if (local.length !== 1) return { failure: "ambiguous-definition" };
        if (local[0]!.unsupported) return { failure: "unsupported-dispatch" };
        const candidates = unit.types.filter(
          (t) => t.parent === s.id && t.name === first,
        );
        if (candidates.length !== 1 || candidates[0]!.qualifiedName === null)
          return { failure: "unsupported-dispatch" };
        return typeAt(
          unit,
          candidates[0]!.qualifiedName +
            (parts.length > 1 ? "." + parts.slice(1).join(".") : ""),
        );
      }
    }
    const imported = unit.imports.filter(
      (i) =>
        !i.unsupported &&
        i.specifier?.split(".").at(-1) === first &&
        (!i.static || types.has(key(unit.revision, i.specifier))),
    );
    if (imported.length) {
      const names = [...new Set(imported.map((i) => i.specifier!))];
      if (names.length !== 1) return { failure: "ambiguous-definition" };
      return typeAt(
        unit,
        names[0]! + (parts.length > 1 ? "." + parts.slice(1).join(".") : ""),
      );
    }
    // An explicit import, including a member of an unselected type, prevents guessing a same-name package type.
    if (unit.imports.some((i) => i.specifier?.split(".").at(-1) === first))
      return { failure: "no-selected-definition" };
    if (parts.length > 1) {
      const exact = typeAt(unit, name);
      if ("target" in exact || exact.failure !== "no-selected-definition")
        return exact;
    }
    return typeAt(
      unit,
      (unit.packageName ? unit.packageName + "." : "") + name,
    );
  }
  function member(
    unit: JavaSyntaxUnit,
    scope: string,
    target: TypeAddress,
    name: string,
    kind: "method" | "field",
  ): Found {
    if (!usable(target.unit, target.type.scope))
      return { failure: "unsupported-dispatch" };
    const values = target.unit.bindings.filter(
      (b) =>
        b.scope === target.type.scope && b.kind === kind && b.name === name,
    );
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const binding = values[0]!;
    const caller = ownerType(unit, scope);
    if (
      binding.unsupported ||
      !binding.static ||
      (kind === "field" && !binding.final) ||
      (binding.visibility === "private" &&
        !(
          caller?.unit.file === target.unit.file &&
          caller.type.scope === target.type.scope
        )) ||
      (binding.visibility === "package" &&
        unit.packageName !== target.unit.packageName)
    )
      return { failure: "unsupported-dispatch" };
    return { target, binding };
  }
  function importedMember(
    unit: JavaSyntaxUnit,
    scope: string,
    specifier: string,
    kind: "method" | "field",
  ): Found {
    const parts = specifier.split("."),
      name = parts.pop()!;
    if (!parts.length) return { failure: "unsupported-dispatch" };
    const target = typeAt(unit, parts.join("."));
    return "target" in target
      ? member(unit, scope, target.target, name, kind)
      : target;
  }
  function simpleMember(
    unit: JavaSyntaxUnit,
    scope: string,
    name: string,
    kind: "method" | "field",
    offset: number,
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    for (const s of scopes(unit, scope)) {
      if (
        kind === "field" &&
        unit.bindings.some(
          (b) =>
            b.scope === s.id &&
            b.kind === "local" &&
            b.name === name &&
            b.visibleFrom <= offset,
        )
      )
        return { failure: "unsupported-dispatch" };
      if (s.kind !== "class") continue;
      const type = unit.types.find((t) => t.scope === s.id);
      if (!type) return { failure: "unsupported-dispatch" };
      if (
        unit.bindings.some(
          (b) => b.scope === s.id && b.kind === kind && b.name === name,
        )
      )
        return member(unit, scope, { unit, type }, name, kind);
    }
    const imported = unit.imports.filter(
      (i) =>
        i.static && !i.unsupported && i.specifier?.split(".").at(-1) === name,
    );
    const names = [...new Set(imported.map((i) => i.specifier!))];
    if (names.length !== 1)
      return {
        failure: names.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    return importedMember(unit, scope, names[0]!, kind);
  }
  const resolve = (
    unit: JavaSyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    kind: "method" | "field",
    offset: number,
  ): Found => {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    if (qualifier === null)
      return simpleMember(unit, scope, name, kind, offset);
    const target = typeName(unit, scope, qualifier, offset);
    return "target" in target
      ? member(unit, scope, target.target, name, kind)
      : target;
  };
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
        usable(unit, "file")
      ) {
        if (!imported.static) found = typeAt(unit, imported.specifier);
        else {
          found = importedMember(unit, "file", imported.specifier, "method");
          if ("failure" in found && found.failure === "no-selected-definition")
            found = importedMember(unit, "file", imported.specifier, "field");
          if ("failure" in found && found.failure === "no-selected-definition")
            found = typeAt(unit, imported.specifier);
        }
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
              "method",
              source.start,
            );
      if ("target" in found && found.binding?.functionId) {
        call.targetFunctionId = found.binding.functionId;
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
        "field",
        source.start,
      );
      if ("target" in found && found.binding?.declarationId)
        analysis.references.push({
          revision: source.revision,
          file: source.file,
          start: source.start,
          end: source.end,
          startLine: source.startLine,
          endLine: source.endLine,
          fromFunctionId: source.caller,
          ownerDeclarationId: source.declaration,
          targetDeclarationId: found.binding.declarationId,
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
    primary.filter((f) => f.endsWith(".java")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !f.file.endsWith(".java")))
    omissions.add("non-java-source");
  if (
    !analysis.functions.some(
      (f) => f.file.endsWith(".java") && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const fixed = [
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
    "build-selection-unknown",
  ];
  const result = {
    ...analysis,
    profile: "java-selected-bindings-v1" as const,
    javaBindings: {
      moduleRoots: roots,
      scope: "selected-captured-java-source" as const,
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
    throw new Error("Java binding metadata budget exhausted");
  return reviewJavaBehaviorSchema.parse(result);
}
export function validateJavaReviewBindings(
  analysis: JavaAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateJavaModuleRoots(roots);
  const bindings = analysis.javaBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw new Error("Java binding module roots differ");
  const files = new Set(
    analysis.files
      .filter((f) => f.state === "collected" && f.file.endsWith(".java"))
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
    throw new Error("Java binding counts do not reconcile");
  const fixed: Omission[] = [
      "unselected-source",
      "runtime-rebinding",
      "runtime-dispatch",
      "module-loading-unknown",
      "build-selection-unknown",
    ],
    mandatory: Omission[] = [...fixed];
  if (
    sources.some(
      (source) =>
        source.path.endsWith(".java") && source.content.includes("\\u"),
    )
  )
    mandatory.push("unicode-escapes-unknown");
  if (calls.some((call) => call.kind === "construct"))
    mandatory.push("constructor-dispatch-unknown");
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !f.file.endsWith(".java")))
    mandatory.push("non-java-source");
  if (
    analysis.files.some(
      (f) => f.file.endsWith(".java") && !beneath(f.file, roots),
    )
  )
    mandatory.push("outside-module-roots");
  if (
    !analysis.functions.some(
      (f) => f.file.endsWith(".java") && primary.includes(f.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((f) => f.endsWith(".java")),
  );
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
    throw new Error("Java binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw new Error("Java caller closure does not reconcile");
}
