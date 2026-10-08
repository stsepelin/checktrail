import path from "node:path";
import {
  reviewPhpBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validatePhpModuleRoots,
  phpSelectedPath,
  type PhpSyntaxUnit,
  type PhpImport,
} from "./review-php-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type PhpAnalysis = Extract<
  ReviewBehavior,
  { profile: "php-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values);
const omissionValues =
  reviewPhpBehaviorSchema.shape.phpBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Binding = PhpSyntaxUnit["bindings"][number];
const symbol = (name: string, kind: Binding["kind"]) => {
  const parts = (name.startsWith("\\") ? name.slice(1) : name).split("\\");
  return kind === "function"
    ? parts.join("\\").toLowerCase()
    : [
        ...parts.slice(0, -1).map((part) => part.toLowerCase()),
        parts.at(-1)!,
      ].join("\\");
};
/** Selected source names describe literal candidates, never native loading or runtime reachability. */
export function resolvePhpBindings(
  analysis: Analysis,
  units: PhpSyntaxUnit[],
  roots: string[],
  primary: string[],
): PhpAnalysis {
  validatePhpModuleRoots(roots);
  const omissions = new Set<Omission>([
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
  ]);
  const definitions = new Map<
    string,
    { unit: PhpSyntaxUnit; binding: Binding }[]
  >();
  for (const unit of units) {
    if (!phpSelectedPath(unit.file, roots))
      omissions.add("outside-module-roots");
    else
      for (const binding of unit.bindings) {
        const address = key(
          unit.revision,
          binding.kind,
          symbol(binding.name, binding.kind),
        );
        definitions.set(address, [
          ...(definitions.get(address) ?? []),
          { unit, binding },
        ]);
      }
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
  }
  type Found =
    | { unit: PhpSyntaxUnit; binding: Binding }
    | {
        failure:
          | "no-selected-definition"
          | "ambiguous-definition"
          | "unsupported-dispatch";
      };
  const find = (
    revision: string,
    name: string,
    kind: Binding["kind"],
  ): Found => {
    const values =
      definitions.get(key(revision, kind, symbol(name, kind))) ?? [];
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    return values[0]!.binding.conditional
      ? { failure: "unsupported-dispatch" }
      : values[0]!;
  };
  const imported = (
    unit: PhpSyntaxUnit,
    scope: string,
    alias: string,
    kind: PhpImport["kind"],
    offset: number,
  ) =>
    unit.imports.filter(
      (value) =>
        value.scope === scope &&
        value.kind === kind &&
        value.visibleFrom <= offset &&
        value.alias !== null &&
        (kind === "constant"
          ? value.alias === alias
          : value.alias.toLowerCase() === alias.toLowerCase()),
    );
  const resolveName = (
    unit: PhpSyntaxUnit,
    scope: string,
    name: string,
    kind: Binding["kind"],
    offset: number,
  ): Found => {
    if (!phpSelectedPath(unit.file, roots))
      return { failure: "unsupported-dispatch" };
    const namespace = unit.namespaces.find((value) => value.id === scope)?.name;
    if (namespace === null || namespace === undefined)
      return { failure: "unsupported-dispatch" };
    if (name.startsWith("\\")) return find(unit.revision, name.slice(1), kind);
    if (name.startsWith("namespace\\"))
      return find(
        unit.revision,
        (namespace ? namespace + "\\" : "") + name.slice("namespace\\".length),
        kind,
      );
    const parts = name.split("\\"),
      qualified = parts.length > 1;
    const matches = imported(
      unit,
      scope,
      parts[0]!,
      qualified ? "namespace" : kind,
      offset,
    );
    if (matches.length > 1) return { failure: "ambiguous-definition" };
    if (matches.length) {
      const value = matches[0]!;
      if (value.name === null) return { failure: "unsupported-dispatch" };
      return find(
        unit.revision,
        value.name + (qualified ? "\\" + parts.slice(1).join("\\") : ""),
        kind,
      );
    }
    // A missing selected namespace definition cannot prove that PHP's runtime global fallback wins.
    return find(
      unit.revision,
      (namespace ? namespace + "\\" : "") + name,
      kind,
    );
  };
  const namespaceTarget = (unit: PhpSyntaxUnit, name: string | null) => {
    if (name === null) return { state: "dynamic" as const, file: null };
    const prefix = name.toLowerCase();
    const targets = units.filter(
      (target) =>
        target.revision === unit.revision &&
        phpSelectedPath(target.file, roots) &&
        target.namespaces.some(
          (scope) =>
            scope.name !== null &&
            (scope.name.toLowerCase() === prefix ||
              scope.name.toLowerCase().startsWith(prefix + "\\")),
        ),
    );
    return targets.length === 1
      ? { state: "selected" as const, file: targets[0]!.file }
      : {
          state: targets.length
            ? ("ambiguous" as const)
            : ("external" as const),
          file: null,
        };
  };
  const files = new Set(units.map((unit) => key(unit.revision, unit.file)));
  analysis.modules = analysis.modules.filter(
    (value) => !files.has(key(value.revision, value.file)),
  );
  analysis.references = analysis.references.filter(
    (value) => !files.has(key(value.revision, value.file)),
  );
  for (const unit of units) {
    for (const imported of unit.imports) {
      const found =
        imported.kind === "namespace"
          ? null
          : imported.name === null
            ? { failure: "unsupported-dispatch" as const }
            : find(unit.revision, imported.name, imported.kind);
      const target =
        imported.kind === "namespace"
          ? namespaceTarget(unit, imported.name)
          : found && "binding" in found
            ? { state: "selected" as const, file: found.unit.file }
            : {
                state:
                  found &&
                  "failure" in found &&
                  found.failure === "ambiguous-definition"
                    ? ("ambiguous" as const)
                    : ("external" as const),
                file: null,
              };
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        kind: "import",
        specifier: imported.name,
        targetFile: target.file,
        resolution: target.state,
      });
      if (target.state !== "selected") omissions.add("unresolved-import");
    }
    for (const required of unit.requires) {
      const target =
        required.anchored && required.specifier !== null
          ? path.posix.normalize(
              path.posix.dirname(unit.file) + required.specifier,
            )
          : null;
      const selected =
        target !== null &&
        phpSelectedPath(target, roots) &&
        units.some(
          (value) => value.revision === unit.revision && value.file === target,
        );
      analysis.modules.push({
        revision: required.revision,
        file: required.file,
        start: required.start,
        end: required.end,
        startLine: required.startLine,
        endLine: required.endLine,
        kind: "require",
        specifier: required.specifier,
        targetFile: selected ? target : null,
        resolution: selected
          ? "selected"
          : required.anchored
            ? "missing"
            : "dynamic",
      });
      if (!selected) {
        omissions.add("unresolved-import");
        omissions.add("unresolved-loading");
      }
    }
    const calls = new Map(unit.calls.map((call) => [call.start, call]));
    for (const call of analysis.calls.filter(
      (call) => call.revision === unit.revision && call.file === unit.file,
    )) {
      const captured = calls.get(call.start);
      if (!captured) {
        call.targetFunctionId = null;
        call.resolution = "unsupported-dispatch";
        omissions.add("unresolved-call");
        continue;
      }
      call.callerFunctionId = captured.caller;
      const found =
        captured.unsupported || captured.name === null
          ? { failure: "unsupported-dispatch" as const }
          : resolveName(
              unit,
              captured.scope,
              captured.name,
              "function",
              call.start,
            );
      if ("binding" in found && found.binding.functionId !== null) {
        call.targetFunctionId = found.binding.functionId;
        call.resolution = "lexical-binding";
      } else {
        call.targetFunctionId = null;
        call.resolution =
          "failure" in found ? found.failure : "unsupported-dispatch";
        omissions.add("unresolved-call");
      }
    }
    for (const reference of unit.references) {
      const found = resolveName(
        unit,
        reference.scope,
        reference.name,
        "constant",
        reference.start,
      );
      if (!("binding" in found) || found.binding.declarationId === null)
        continue;
      analysis.references.push({
        revision: reference.revision,
        file: reference.file,
        start: reference.start,
        end: reference.end,
        startLine: reference.startLine,
        endLine: reference.endLine,
        fromFunctionId: reference.caller,
        ownerDeclarationId: reference.owner,
        targetDeclarationId: found.binding.declarationId,
      });
    }
  }
  const calls = analysis.calls.filter((call) =>
      files.has(key(call.revision, call.file)),
    ),
    imports = analysis.modules.filter((value) =>
      files.has(key(value.revision, value.file)),
    );
  const resolvedCalls = calls.filter(
      (call) => call.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter(
      (value) => value.resolution === "selected",
    ).length;
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".php")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((file) => file.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".php")))
    omissions.add("non-php-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".php") && primary.includes(fn.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "php-selected-bindings-v1" as const,
    phpBindings: {
      moduleRoots: roots,
      scope: "selected-captured-php-source" as const,
      state: [...omissions].some(
        (value) =>
          ![
            "unselected-source",
            "runtime-rebinding",
            "runtime-dispatch",
            "module-loading-unknown",
          ].includes(value),
      )
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
    throw new Error("PHP binding metadata budget exhausted");
  return reviewPhpBehaviorSchema.parse(result);
}

export function validatePhpReviewBindings(
  analysis: PhpAnalysis,
  roots: string[],
  primary: string[],
): void {
  validatePhpModuleRoots(roots);
  const bindings = analysis.phpBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw new Error("PHP binding module roots differ");
  const files = new Set(
    analysis.files
      .filter(
        (file) => file.state === "collected" && file.file.endsWith(".php"),
      )
      .map((file) => key(file.revision, file.file)),
  );
  const calls = analysis.calls.filter((call) =>
      files.has(key(call.revision, call.file)),
    ),
    imports = analysis.modules.filter((value) =>
      files.has(key(value.revision, value.file)),
    );
  const resolvedCalls = calls.filter(
      (call) => call.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter(
      (value) => value.resolution === "selected",
    ).length;
  const counts = {
    calls: calls.length,
    resolvedCalls,
    unresolvedCalls: calls.length - resolvedCalls,
    imports: imports.length,
    resolvedImports,
    unresolvedImports: imports.length - resolvedImports,
  };
  if (JSON.stringify(counts) !== JSON.stringify(bindings.counts))
    throw new Error("PHP binding counts do not reconcile");
  const mandatory: Omission[] = [
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
  ];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((file) => file.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".php")))
    mandatory.push("non-php-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".php") && primary.includes(fn.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".php")),
  );
  if (closure.exhausted) mandatory.push("depth-limit");
  if (
    mandatory.some((value) => !bindings.omissions.includes(value)) ||
    JSON.stringify(bindings.omissions) !==
      JSON.stringify([...new Set(bindings.omissions)].sort()) ||
    bindings.state !==
      (bindings.omissions.some(
        (value) =>
          ![
            "unselected-source",
            "runtime-rebinding",
            "runtime-dispatch",
            "module-loading-unknown",
          ].includes(value),
      )
        ? "partial"
        : "collected")
  )
    throw new Error("PHP binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw new Error("PHP caller closure does not reconcile");
}
