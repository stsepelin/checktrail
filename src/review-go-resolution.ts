import path from "node:path";
import { capturedGoModulePath } from "./go-workspace.js";
import {
  reviewGoBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateGoModuleRoots,
  type GoModuleRoot,
  type GoSyntaxUnit,
  type GoBinding,
} from "./review-go-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type GoAnalysis = Extract<
  ReviewBehavior,
  { profile: "go-selected-bindings-v1" }
>;
type Group = {
  units: GoSyntaxUnit[];
  packageName: string | null;
  ambiguous: boolean;
};
type Source = { path: string; sha256: string; content: string };
export function capturedGoModuleManifests(
  roots: GoModuleRoot[],
  current: Source[],
  base: Source[],
  diff: boolean,
): GoAnalysis["goBindings"]["moduleManifests"] {
  validateGoModuleRoots(roots);
  return (
    diff
      ? ([
          ["base", base],
          ["current", current],
        ] as const)
      : ([["current", current]] as const)
  ).flatMap(([revision, sources]) =>
    roots.map((root) => {
      const file = path.posix.join(root, "go.mod"),
        source = sources.find((source) => source.path === file);
      const modulePath = source ? capturedGoModulePath(source.content) : null;
      return {
        revision,
        root,
        file,
        sha256: source?.sha256 ?? null,
        modulePath,
        state: !source
          ? ("missing" as const)
          : modulePath === null
            ? ("unsupported" as const)
            : ("captured" as const),
      };
    }),
  );
}
const key = (...values: string[]) => JSON.stringify(values);
const omissionValues =
  reviewGoBehaviorSchema.shape.goBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
export function resolveGoBindings(
  analysis: Analysis,
  units: GoSyntaxUnit[],
  roots: GoModuleRoot[],
  primary: string[],
  current: Source[],
  base: Source[],
  diff: boolean,
): GoAnalysis {
  validateGoModuleRoots(roots);
  const moduleManifests = capturedGoModuleManifests(roots, current, base, diff);
  const omissions = new Set<Omission>([
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "build-selection-unknown",
    "captured-module-directives",
  ]);
  for (const manifest of moduleManifests)
    if (manifest.state !== "captured")
      omissions.add(
        manifest.state === "missing"
          ? "missing-module-manifest"
          : "unsupported-module-manifest",
      );
  const physical = new Map<string, Group>(),
    groups = new Map<string, Group>(),
    ownGroups = new Map<GoSyntaxUnit, Group>();
  for (const unit of units) {
    const root = roots.find(
      (root) => root === "." || unit.file.startsWith(root + "/"),
    );
    const directory = path.posix.dirname(unit.file),
      physicalKey = key(unit.revision, directory);
    const group = physical.get(physicalKey) ?? {
      units: [],
      packageName: unit.packageName,
      ambiguous: false,
    };
    group.units.push(unit);
    if (group.packageName !== unit.packageName || unit.packageName === null)
      group.ambiguous = true;
    physical.set(physicalKey, group);
    ownGroups.set(unit, group);
    if (root === undefined) omissions.add("outside-module-roots");
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
  }
  for (const group of physical.values()) {
    const unit = group.units[0]!,
      directory = path.posix.dirname(unit.file);
    const root = roots.find(
      (root) => root === "." || unit.file.startsWith(root + "/"),
    );
    const manifest = moduleManifests.find(
      (manifest) =>
        manifest.revision === unit.revision && manifest.root === root,
    );
    if (
      root !== undefined &&
      manifest?.modulePath !== null &&
      manifest?.modulePath !== undefined
    ) {
      const relative = path.posix.relative(root, directory),
        name = manifest.modulePath + (relative ? "/" + relative : "");
      const id = key(unit.revision, name),
        previous = groups.get(id);
      if (previous && previous !== group)
        groups.set(id, {
          units: [...previous.units, ...group.units],
          packageName: null,
          ambiguous: true,
        });
      else groups.set(id, group);
    }
  }
  for (const group of [...physical.values(), ...groups.values()])
    if (group.ambiguous) omissions.add("ambiguous-package");
  const selected = (unit: GoSyntaxUnit, specifier: string | null) => {
    if (!specifier) return { state: "dynamic" as const, group: null };
    const group = groups.get(key(unit.revision, specifier));
    if (!group) return { state: "external" as const, group: null };
    return group.ambiguous
      ? { state: "ambiguous" as const, group: null }
      : { state: "selected" as const, group };
  };
  type Found =
    | { unit: GoSyntaxUnit; binding: GoBinding }
    | { group: Group }
    | {
        failure:
          | "unsupported-dispatch"
          | "no-selected-definition"
          | "ambiguous-definition"
          | "mutated-binding";
      };
  const packageBinding = (group: Group | null, name: string): Found => {
    if (!group) return { failure: "no-selected-definition" };
    if (group.ambiguous) return { failure: "ambiguous-definition" };
    const values = group.units.flatMap((unit) =>
      unit.bindings
        .filter((binding) => binding.scope === "file" && binding.name === name)
        .map((binding) => ({ unit, binding })),
    );
    return values.length === 1
      ? values[0]!
      : values.length > 1
        ? { failure: "ambiguous-definition" }
        : { failure: "no-selected-definition" };
  };
  const lookup = (
    unit: GoSyntaxUnit,
    scope: string,
    name: string,
    offset: number,
  ): Found => {
    const scopes = new Map(unit.scopes.map((scope) => [scope.id, scope]));
    let current = scopes.get(scope);
    while (current && current.id !== "file") {
      if (current.unknown) return { failure: "unsupported-dispatch" };
      const values = unit.bindings.filter(
        (binding) =>
          binding.scope === current!.id &&
          binding.name === name &&
          binding.visibleFrom <= offset,
      );
      if (values.length) return { unit, binding: values.at(-1)! };
      current =
        current.parent === null ? undefined : scopes.get(current.parent);
    }
    if (scopes.get("file")!.unknown) return { failure: "unsupported-dispatch" };
    // An unselected implicit package name can mask any outer package declaration.
    if (
      unit.imports.some(
        (imported) =>
          imported.alias === null &&
          selected(unit, imported.specifier).group === null,
      )
    )
      return { failure: "unsupported-dispatch" };
    const imports = unit.imports.filter((imported) => {
      if (imported.alias === "_" || imported.alias === ".") return false;
      const target = selected(unit, imported.specifier);
      return (imported.alias ?? target.group?.packageName) === name;
    });
    const own = packageBinding(ownGroups.get(unit) ?? null, name);
    if (imports.length) {
      if (
        imports.length !== 1 ||
        unit.bindings.some(
          (binding) => binding.scope === "file" && binding.name === name,
        )
      )
        return { failure: "ambiguous-definition" };
      const target = selected(unit, imports[0]!.specifier);
      return target.group
        ? { group: target.group }
        : {
            failure:
              target.state === "ambiguous"
                ? "ambiguous-definition"
                : "no-selected-definition",
          };
    }
    return own;
  };
  const goFiles = new Set(units.map((unit) => key(unit.revision, unit.file)));
  analysis.modules = analysis.modules.filter(
    (module) => !goFiles.has(key(module.revision, module.file)),
  );
  analysis.references = analysis.references.filter(
    (reference) => !goFiles.has(key(reference.revision, reference.file)),
  );
  for (const unit of units) {
    for (const imported of unit.imports) {
      const target = selected(unit, imported.specifier);
      const address = {
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        specifier: imported.specifier,
      };
      analysis.modules.push({
        ...address,
        kind: "import",
        targetFile: target.group?.units[0]?.file ?? null,
        resolution: target.state,
      });
      if (target.state !== "selected") omissions.add("unresolved-import");
    }
    const calls = new Map(
      unit.calls.map((call) => [call.start + ":" + call.end, call]),
    );
    for (const call of analysis.calls.filter(
      (call) => call.file === unit.file && call.revision === unit.revision,
    )) {
      const captured = calls.get(call.start + ":" + call.end)!;
      call.callerFunctionId = captured.caller;
      let found: Found =
        captured.unsupported || captured.callee === null
          ? { failure: "unsupported-dispatch" }
          : lookup(
              unit,
              captured.scope,
              captured.receiver ?? captured.callee,
              call.start,
            );
      if (captured.receiver !== null && !("failure" in found))
        found =
          "group" in found && /^[A-Z]/.test(captured.callee ?? "")
            ? packageBinding(found.group, captured.callee!)
            : { failure: "unsupported-dispatch" };
      if (
        "binding" in found &&
        found.binding.kind === "function" &&
        found.binding.functionId !== null
      ) {
        call.resolution = "lexical-binding";
        call.targetFunctionId = found.binding.functionId;
      } else {
        call.resolution =
          "failure" in found ? found.failure : "unsupported-dispatch";
        call.targetFunctionId = null;
        omissions.add("unresolved-call");
      }
    }
    for (const reference of unit.references) {
      const found = lookup(
        unit,
        reference.scope,
        reference.name,
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
  const selectedCalls = analysis.calls.filter((call) =>
    goFiles.has(key(call.revision, call.file)),
  );
  const imports = analysis.modules.filter((module) =>
    goFiles.has(key(module.revision, module.file)),
  );
  const resolvedCalls = selectedCalls.filter(
      (call) => call.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter(
      (module) => module.resolution === "selected",
    ).length;
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".go")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((file) => file.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".go")))
    omissions.add("non-go-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".go") && primary.includes(fn.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "go-selected-bindings-v1" as const,
    goBindings: {
      moduleRoots: roots,
      moduleRootsProvenance: "operator-selected" as const,
      moduleManifests,
      scope: "selected-captured-go-source" as const,
      state: [...omissions].some(
        (reason) =>
          ![
            "unselected-source",
            "runtime-rebinding",
            "runtime-dispatch",
            "build-selection-unknown",
            "captured-module-directives",
          ].includes(reason),
      )
        ? ("partial" as const)
        : ("collected" as const),
      callerDepthLimit: 8 as const,
      callerEdges: closure.edges,
      counts: {
        calls: selectedCalls.length,
        resolvedCalls,
        unresolvedCalls: selectedCalls.length - resolvedCalls,
        imports: imports.length,
        resolvedImports,
        unresolvedImports: imports.length - resolvedImports,
      },
      fullImpactFallback: true as const,
      runtimeReachabilityVerified: false as const,
      nativeModuleResolutionVerified: false as const,
      validationPlanUnchanged: true as const,
      omissions: [...omissions].sort(),
    },
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) > 256 * 1024 ||
    analysis.modules.length > 512 ||
    analysis.references.length > 8192
  )
    throw new Error("Go binding metadata budget exhausted");
  return reviewGoBehaviorSchema.parse(result);
}

/** Reconcile retained summary claims with selected source and exact captured module directives. */
export function validateGoReviewBindings(
  analysis: GoAnalysis,
  roots: GoModuleRoot[],
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
): void {
  validateGoModuleRoots(roots);
  const bindings = analysis.goBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw new Error("Go binding module roots differ");
  const manifests = capturedGoModuleManifests(roots, current, base, diff);
  if (JSON.stringify(bindings.moduleManifests) !== JSON.stringify(manifests))
    throw new Error("Go captured module directives differ");
  const files = new Set(
    analysis.files
      .filter((file) => file.state === "collected" && file.file.endsWith(".go"))
      .map((file) => key(file.revision, file.file)),
  );
  const calls = analysis.calls.filter((call) =>
      files.has(key(call.revision, call.file)),
    ),
    imports = analysis.modules.filter((module) =>
      files.has(key(module.revision, module.file)),
    );
  const resolvedCalls = calls.filter(
      (call) => call.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter(
      (module) => module.resolution === "selected",
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
    throw new Error("Go binding counts do not reconcile");
  const mandatory: Omission[] = [
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "build-selection-unknown",
    "captured-module-directives",
  ];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((file) => file.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".go")))
    mandatory.push("non-go-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".go") && primary.includes(fn.file),
    )
  )
    mandatory.push("no-selected-functions");
  for (const manifest of manifests)
    if (manifest.state !== "captured")
      mandatory.push(
        manifest.state === "missing"
          ? "missing-module-manifest"
          : "unsupported-module-manifest",
      );
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".go")),
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
            "build-selection-unknown",
            "captured-module-directives",
          ].includes(value),
      )
        ? "partial"
        : "collected")
  )
    throw new Error("Go binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw new Error("Go caller closure does not reconcile");
}
