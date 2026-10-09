import path from "node:path";
import {
  reviewRustBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateRustCrateRoots,
  type RustSyntaxUnit,
  type RustBinding,
} from "./review-rust-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type RustAnalysis = Extract<
  ReviewBehavior,
  { profile: "rust-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values);
const omissionValues =
  reviewRustBehaviorSchema.shape.rustBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Module = {
  root: string;
  unit: RustSyntaxUnit;
  scope: string;
  parts: string[];
  directory: string;
};
type Found =
  | { kind: "function" | "constant"; binding: RustBinding; module: Module }
  | { kind: "module"; module: Module }
  | {
      failure:
        | "no-selected-definition"
        | "ambiguous-definition"
        | "unsupported-dispatch";
    };
/** Resolve only captured Rust item/module candidates; Cargo, compiler configuration and runtime remain unknown. */
export function resolveRustBindings(
  analysis: Analysis,
  units: RustSyntaxUnit[],
  roots: string[],
  primary: string[],
): RustAnalysis {
  validateRustCrateRoots(roots);
  const omissions = new Set<Omission>([
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
    "build-selection-unknown",
  ]);
  const modules = new Map<string, Module[]>(),
    memberships = new Map<string, Module[]>();
  const moduleStates = new Map<
    string,
    {
      file: string | null;
      resolution: "selected" | "missing" | "ambiguous" | "dynamic";
    }
  >();
  const fileKey = (unit: RustSyntaxUnit) => key(unit.revision, unit.file);
  function add(module: Module): void {
    const address = key(module.unit.revision, module.root, ...module.parts);
    const previous = modules.get(address) ?? [];
    if (
      previous.some(
        (value) =>
          value.unit.file === module.unit.file && value.scope === module.scope,
      )
    )
      return;
    modules.set(address, [...previous, module]);
    const membership = key(
      module.unit.revision,
      module.unit.file,
      module.scope,
    );
    memberships.set(membership, [
      ...(memberships.get(membership) ?? []),
      module,
    ]);
  }
  for (const revision of ["base", "current"] as const) {
    if (!analysis.files.some((file) => file.revision === revision)) continue;
    for (const root of roots) {
      const unit = units.find(
        (unit) => unit.revision === revision && unit.file === root,
      );
      if (!unit) {
        omissions.add("missing-crate-root");
        continue;
      }
      const queue: Module[] = [
        {
          root,
          unit,
          scope: "file",
          parts: [],
          directory: path.posix.dirname(root),
        },
      ];
      let cursor = 0;
      while (cursor < queue.length) {
        if (cursor >= 4096) {
          omissions.add("depth-limit");
          break;
        }
        const module = queue[cursor++]!;
        add(module);
        for (const declaration of module.unit.modules.filter(
          (value) => value.scope === module.scope,
        )) {
          const address = key(
            declaration.revision,
            declaration.file,
            String(declaration.start),
          );
          if (
            declaration.unsupported ||
            declaration.name === null ||
            module.parts.length >= 8
          ) {
            moduleStates.set(address, { file: null, resolution: "dynamic" });
            omissions.add(
              declaration.unsupported ? "unsupported-module" : "depth-limit",
            );
            continue;
          }
          const parts = [...module.parts, declaration.name],
            directory = path.posix.join(module.directory, declaration.name);
          if (declaration.bodyScope !== null) {
            const next = {
              ...module,
              scope: declaration.bodyScope,
              parts,
              directory,
            };
            queue.push(next);
            moduleStates.set(address, {
              file: module.unit.file,
              resolution: "selected",
            });
            continue;
          }
          const candidates = [
            directory + ".rs",
            path.posix.join(directory, "mod.rs"),
          ];
          const selected = units.filter(
            (unit) =>
              unit.revision === revision && candidates.includes(unit.file),
          );
          if (selected.length !== 1) {
            moduleStates.set(address, {
              file: null,
              resolution: selected.length ? "ambiguous" : "missing",
            });
            omissions.add("unresolved-module");
            if (selected.length) omissions.add("ambiguous-definition");
            continue;
          }
          const target = selected[0]!;
          queue.push({ root, unit: target, scope: "file", parts, directory });
          const previous = moduleStates.get(address);
          moduleStates.set(
            address,
            previous && previous.file !== target.file
              ? { file: null, resolution: "ambiguous" }
              : { file: target.file, resolution: "selected" },
          );
        }
      }
    }
  }
  for (const unit of units) {
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
    if (!memberships.has(key(unit.revision, unit.file, "file")))
      omissions.add("outside-crate-roots");
  }
  if ([...memberships.values()].some((values) => values.length > 1))
    omissions.add("ambiguous-definition");
  const contextFor = (unit: RustSyntaxUnit, scope: string): Module | null => {
    const scopes = new Map(unit.scopes.map((value) => [value.id, value]));
    for (
      let current = scopes.get(scope);
      current;
      current = current.parent === null ? undefined : scopes.get(current.parent)
    ) {
      if (current.unknown) return null;
      if (current.kind === "module") {
        const values =
          memberships.get(key(unit.revision, unit.file, current.id)) ?? [];
        return values.length === 1 ? values[0]! : null;
      }
    }
    return null;
  };
  const moduleAt = (module: Module, parts: string[]): Found => {
    const values =
      modules.get(key(module.unit.revision, module.root, ...parts)) ?? [];
    return values.length === 1
      ? { kind: "module", module: values[0]! }
      : {
          failure: values.length
            ? "ambiguous-definition"
            : "no-selected-definition",
        };
  };
  const seenKey = (module: Module, binding: RustBinding) =>
    key(
      module.unit.revision,
      module.root,
      module.unit.file,
      binding.scope,
      binding.name,
      binding.kind,
      binding.importPath ?? "",
    );
  function bindingValue(
    module: Module,
    binding: RustBinding,
    namespace: "value" | "type",
    seen: Set<string>,
    depth: number,
  ): Found {
    if (binding.unsupported || depth > 8)
      return { failure: "unsupported-dispatch" };
    if (binding.kind === "function" || binding.kind === "constant")
      return namespace === "value"
        ? { kind: binding.kind, binding, module }
        : { failure: "unsupported-dispatch" };
    if (binding.kind === "module")
      return moduleAt(module, [...module.parts, binding.name]);
    if (binding.kind !== "import" || binding.importPath === null)
      return { failure: "unsupported-dispatch" };
    const address = seenKey(module, binding);
    if (seen.has(address)) return { failure: "unsupported-dispatch" };
    const next = new Set(seen);
    next.add(address);
    return resolvePath(
      module.unit,
      binding.scope,
      binding.importPath,
      namespace,
      0,
      next,
      depth + 1,
      true,
    );
  }
  function lookup(
    unit: RustSyntaxUnit,
    scope: string,
    name: string,
    namespace: "value" | "type",
    offset: number,
    seen: Set<string>,
    depth: number,
    moduleOnly = false,
  ): Found {
    const scopes = new Map(unit.scopes.map((value) => [value.id, value]));
    for (
      let current = scopes.get(scope);
      current;
      current = current.parent === null ? undefined : scopes.get(current.parent)
    ) {
      if (current.unknown) return { failure: "unsupported-dispatch" };
      const context = contextFor(unit, current.id);
      if (context === null) return { failure: "unsupported-dispatch" };
      const candidates = unit.bindings.filter(
        (value) =>
          value.scope === current!.id &&
          value.name === name &&
          (value.namespace === namespace || value.namespace === "both") &&
          value.visibleFrom <= offset,
      );
      const locals = candidates.filter((value) => value.kind === "local");
      if (locals.length && !moduleOnly)
        return { failure: "unsupported-dispatch" };
      const items = candidates.filter((value) => value.kind !== "local");
      if (items.length > 1) return { failure: "ambiguous-definition" };
      if (items.length)
        return bindingValue(context, items[0]!, namespace, seen, depth);
      if (current.kind === "module")
        return { failure: "no-selected-definition" };
    }
    return { failure: "no-selected-definition" };
  }
  function walk(
    module: Module,
    parts: string[],
    namespace: "value" | "type",
    seen: Set<string>,
    depth: number,
  ): Found {
    if (contextFor(module.unit, module.scope) === null)
      return { failure: "unsupported-dispatch" };
    if (!parts.length) return { kind: "module", module };
    const values = module.unit.bindings.filter(
      (value) =>
        value.scope === module.scope &&
        value.name === parts[0] &&
        (value.namespace === (parts.length === 1 ? namespace : "type") ||
          value.namespace === "both"),
    );
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const found = bindingValue(
      module,
      values[0]!,
      parts.length === 1 ? namespace : "type",
      seen,
      depth,
    );
    return parts.length === 1
      ? found
      : "kind" in found && found.kind === "module"
        ? walk(found.module, parts.slice(1), namespace, seen, depth + 1)
        : { failure: "unsupported-dispatch" };
  }
  function resolvePath(
    unit: RustSyntaxUnit,
    scope: string,
    name: string,
    namespace: "value" | "type",
    offset: number,
    seen = new Set<string>(),
    depth = 0,
    importing = false,
  ): Found {
    if (depth > 8) return { failure: "unsupported-dispatch" };
    const context = contextFor(unit, scope);
    if (context === null) return { failure: "unsupported-dispatch" };
    const parts = name.split("::");
    if (parts.some((part) => !part)) return { failure: "unsupported-dispatch" };
    if (["crate", "self", "super"].includes(parts[0]!)) {
      let base = context.parts;
      if (parts[0] === "crate") {
        base = [];
        parts.shift();
      } else if (parts[0] === "self") parts.shift();
      else
        while (parts[0] === "super") {
          if (!base.length) return { failure: "no-selected-definition" };
          base = base.slice(0, -1);
          parts.shift();
        }
      const start = moduleAt(context, base);
      return "kind" in start && start.kind === "module"
        ? walk(start.module, parts, namespace, seen, depth)
        : start;
    }
    if (parts.length === 1)
      return lookup(
        unit,
        scope,
        parts[0]!,
        namespace,
        offset,
        seen,
        depth,
        importing,
      );
    const first = lookup(
      unit,
      scope,
      parts[0]!,
      "type",
      offset,
      seen,
      depth,
      true,
    );
    return "kind" in first && first.kind === "module"
      ? walk(first.module, parts.slice(1), namespace, seen, depth + 1)
      : first;
  }
  const files = new Set(units.map(fileKey));
  analysis.modules = analysis.modules.filter(
    (value) => !files.has(key(value.revision, value.file)),
  );
  analysis.references = analysis.references.filter(
    (value) => !files.has(key(value.revision, value.file)),
  );
  for (const unit of units) {
    for (const declaration of unit.modules) {
      const state = moduleStates.get(
        key(declaration.revision, declaration.file, String(declaration.start)),
      ) ?? { file: null, resolution: "dynamic" as const };
      analysis.modules.push({
        revision: declaration.revision,
        file: declaration.file,
        start: declaration.start,
        end: declaration.end,
        startLine: declaration.startLine,
        endLine: declaration.endLine,
        kind: "import",
        specifier: declaration.name,
        targetFile: state.file,
        resolution: state.resolution,
      });
      if (state.resolution !== "selected") omissions.add("unresolved-import");
    }
    for (const imported of unit.imports) {
      const value =
        imported.unsupported || imported.specifier === null
          ? { failure: "unsupported-dispatch" as const }
          : resolvePath(
              unit,
              imported.scope,
              imported.specifier,
              "value",
              0,
              new Set(),
              0,
              true,
            );
      const type =
        value && "failure" in value
          ? imported.unsupported || imported.specifier === null
            ? value
            : resolvePath(
                unit,
                imported.scope,
                imported.specifier,
                "type",
                0,
                new Set(),
                0,
                true,
              )
          : value;
      const target = "failure" in type ? null : type.module;
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        kind: "import",
        specifier: imported.specifier,
        targetFile: target?.unit.file ?? null,
        resolution: target
          ? "selected"
          : "failure" in type && type.failure === "ambiguous-definition"
            ? "ambiguous"
            : imported.unsupported
              ? "dynamic"
              : "external",
      });
      if (!target) omissions.add("unresolved-import");
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
          : resolvePath(unit, source.scope, source.name, "value", source.start);
      if (
        "kind" in found &&
        found.kind === "function" &&
        found.binding.functionId !== null
      ) {
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
      const found = resolvePath(
        unit,
        reference.scope,
        reference.name,
        "value",
        reference.start,
      );
      if (
        "kind" in found &&
        found.kind === "constant" &&
        found.binding.declarationId !== null
      )
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
  const calls = analysis.calls.filter((value) =>
      files.has(key(value.revision, value.file)),
    ),
    imports = analysis.modules.filter((value) =>
      files.has(key(value.revision, value.file)),
    ),
    resolvedCalls = calls.filter(
      (value) => value.resolution === "lexical-binding",
    ).length,
    resolvedImports = imports.filter(
      (value) => value.resolution === "selected",
    ).length;
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".rs")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((file) => file.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".rs")))
    omissions.add("non-rust-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".rs") && primary.includes(fn.file),
    )
  )
    omissions.add("no-selected-functions");
  const state = [...omissions].some(
    (value) =>
      ![
        "unselected-source",
        "runtime-rebinding",
        "runtime-dispatch",
        "module-loading-unknown",
        "build-selection-unknown",
      ].includes(value),
  )
    ? ("partial" as const)
    : ("collected" as const);
  const result = {
    ...analysis,
    profile: "rust-selected-bindings-v1" as const,
    rustBindings: {
      crateRoots: roots,
      scope: "selected-captured-rust-source" as const,
      state,
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
    throw new Error("Rust binding metadata budget exhausted");
  return reviewRustBehaviorSchema.parse(result);
}
export function validateRustReviewBindings(
  analysis: RustAnalysis,
  roots: string[],
  primary: string[],
): void {
  validateRustCrateRoots(roots);
  const bindings = analysis.rustBindings;
  if (JSON.stringify(bindings.crateRoots) !== JSON.stringify(roots))
    throw new Error("Rust binding crate roots differ");
  const files = new Set(
    analysis.files
      .filter((file) => file.state === "collected" && file.file.endsWith(".rs"))
      .map((file) => key(file.revision, file.file)),
  );
  const calls = analysis.calls.filter((value) =>
      files.has(key(value.revision, value.file)),
    ),
    imports = analysis.modules.filter((value) =>
      files.has(key(value.revision, value.file)),
    ),
    resolvedCalls = calls.filter(
      (value) => value.resolution === "lexical-binding",
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
    throw new Error("Rust binding counts do not reconcile");
  const mandatory: Omission[] = [
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
    "module-loading-unknown",
    "build-selection-unknown",
  ];
  if (
    analysis.files.some((file) =>
      roots.some(
        (root) =>
          !analysis.files.some(
            (candidate) =>
              candidate.revision === file.revision &&
              candidate.file === root &&
              candidate.state === "collected",
          ),
      ),
    )
  )
    mandatory.push("missing-crate-root");
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((file) => file.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".rs")))
    mandatory.push("non-rust-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".rs") && primary.includes(fn.file),
    )
  )
    mandatory.push("no-selected-functions");
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".rs")),
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
            "build-selection-unknown",
          ].includes(value),
      )
        ? "partial"
        : "collected")
  )
    throw new Error("Rust binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw new Error("Rust caller closure does not reconcile");
}
