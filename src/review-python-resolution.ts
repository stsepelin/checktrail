import path from "node:path";
import {
  reviewPythonBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import {
  validatePythonModuleRoots,
  type PythonSyntaxUnit,
  type Binding,
  type Scope,
} from "./review-python-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type PythonAnalysis = Extract<
  ReviewBehavior,
  { profile: "python-selected-bindings-v1" }
>;
const key = (revision: string, module: string) =>
  JSON.stringify([revision, module]);
const omissionValues =
  reviewPythonBehaviorSchema.shape.pythonBindings.shape.omissions.element
    .options;
type Omission = (typeof omissionValues)[number];
/** The closure is bounded selected-source metadata, never an executable impact filter. */
export function pythonCallerClosure(
  analysis: Pick<ReviewBehavior, "functions" | "calls">,
  primary: string[],
): {
  edges: PythonAnalysis["pythonBindings"]["callerEdges"];
  exhausted: boolean;
} {
  const incoming = new Map<string, string[]>();
  for (const call of analysis.calls)
    if (
      call.resolution === "lexical-binding" &&
      call.targetFunctionId !== null &&
      call.callerFunctionId !== null
    ) {
      const values = incoming.get(call.targetFunctionId) ?? [];
      if (!values.includes(call.callerFunctionId))
        values.push(call.callerFunctionId);
      incoming.set(call.targetFunctionId, values);
    }
  const edges: PythonAnalysis["pythonBindings"]["callerEdges"] = [];
  let exhausted = false;
  for (const target of analysis.functions.filter((fn) =>
    primary.includes(fn.file),
  )) {
    const visited = new Set([target.id]);
    const queue = [{ id: target.id, depth: 0 }];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      for (const caller of incoming.get(current.id) ?? []) {
        if (visited.has(caller)) continue;
        if (current.depth >= 8) {
          exhausted = true;
          continue;
        }
        if (edges.length >= 4096) {
          exhausted = true;
          return { edges, exhausted };
        }
        visited.add(caller);
        edges.push({
          revision: target.revision,
          targetFunctionId: target.id,
          callerFunctionId: caller,
          depth: current.depth + 1,
        });
        queue.push({ id: caller, depth: current.depth + 1 });
      }
    }
  }
  return { edges, exhausted };
}
export function resolvePythonBindings(
  analysis: Analysis,
  units: PythonSyntaxUnit[],
  roots: string[],
  primary: string[],
): PythonAnalysis {
  validatePythonModuleRoots(roots);
  const omissions = new Set<Omission>([
    "unselected-source",
    "runtime-rebinding",
    "runtime-dispatch",
  ]);
  const modules = new Map<string, PythonSyntaxUnit[]>();
  const unitNames = new Map<PythonSyntaxUnit, string | null>();
  const scopes = new Map<PythonSyntaxUnit, Map<string, Scope>>();
  const bindings = new Map<PythonSyntaxUnit, Map<string, Binding[]>>();
  for (const unit of units) {
    const root = roots.find(
      (root) => root === "." || unit.file.startsWith(root + "/"),
    );
    const relative =
      root === "."
        ? unit.file
        : root === undefined
          ? null
          : unit.file.slice(root.length + 1);
    let name: string | null = relative?.endsWith(".py")
      ? relative.slice(0, -3).replaceAll("/", ".")
      : null;
    if (name === "__init__") name = "";
    else if (name?.endsWith(".__init__")) name = name.slice(0, -9);
    if (
      name !== null &&
      !/^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(name)
    )
      name = null;
    unitNames.set(unit, name);
    if (name !== null) {
      const id = key(unit.revision, name);
      modules.set(id, [...(modules.get(id) ?? []), unit]);
    } else omissions.add("outside-module-roots");
    scopes.set(unit, new Map(unit.scopes.map((scope) => [scope.id, scope])));
    const map = new Map<string, Binding[]>();
    for (const binding of unit.bindings) {
      const id = key(binding.scope, binding.name);
      map.set(id, [...(map.get(id) ?? []), binding]);
    }
    bindings.set(unit, map);
    for (const omission of unit.omissions)
      if (omissionValues.includes(omission as Omission))
        omissions.add(omission as Omission);
  }
  const findModule = (unit: PythonSyntaxUnit, specifier: string | null) => {
    if (!specifier) return { state: "dynamic" as const, unit: null };
    let absolute = specifier;
    if (specifier.startsWith(".")) {
      const name = unitNames.get(unit);
      if (name === null || name === undefined)
        return { state: "outside-root" as const, unit: null };
      const directory =
        path.posix.basename(unit.file) === "__init__.py"
          ? name
          : name.split(".").slice(0, -1).join(".");
      const dots = specifier.match(/^\.+/)![0].length;
      const packageParts = directory ? directory.split(".") : [];
      if (dots > packageParts.length)
        return { state: "outside-root" as const, unit: null };
      absolute = [
        ...packageParts.slice(0, packageParts.length - dots + 1),
        ...(specifier.slice(dots) ? [specifier.slice(dots)] : []),
      ].join(".");
    }
    const selected = modules.get(key(unit.revision, absolute)) ?? [];
    return selected.length === 1
      ? { state: "selected" as const, unit: selected[0]! }
      : {
          state:
            selected.length > 1
              ? ("ambiguous" as const)
              : ("external" as const),
          unit: null,
        };
  };
  type Found =
    | { unit: PythonSyntaxUnit; binding: Binding }
    | {
        failure:
          | "unsupported-dispatch"
          | "no-selected-definition"
          | "ambiguous-definition"
          | "mutated-binding";
      };
  const lookup = (
    unit: PythonSyntaxUnit,
    scope: string,
    name: string,
  ): Found => {
    let current = scopes.get(unit)!.get(scope);
    while (current) {
      if (current.unknown) return { failure: "unsupported-dispatch" };
      const values = bindings.get(unit)!.get(key(current.id, name)) ?? [];
      if (values.length > 1)
        return {
          failure: values.some((value) => value.kind === "other")
            ? "mutated-binding"
            : "ambiguous-definition",
        };
      if (values.length === 1) return { unit, binding: values[0]! };
      const previous = current;
      current =
        previous.parent === null
          ? undefined
          : scopes.get(unit)!.get(previous.parent);
      // Class namespaces are not lexical parents of Python method bodies.
      if (previous.kind === "function" && current?.kind === "class")
        current =
          current.parent === null
            ? undefined
            : scopes.get(unit)!.get(current.parent);
    }
    return { failure: "no-selected-definition" };
  };
  const follow = (found: Found, visited: Set<string>, depth = 0): Found => {
    if ("failure" in found || found.binding.kind !== "import") return found;
    const id = key(
      found.unit.revision,
      found.unit.file + ":" + found.binding.scope + ":" + found.binding.name,
    );
    if (visited.has(id)) {
      omissions.add("binding-cycle");
      return { failure: "ambiguous-definition" };
    }
    if (depth >= 8) {
      omissions.add("depth-limit");
      return { failure: "no-selected-definition" };
    }
    visited.add(id);
    const selected = findModule(found.unit, found.binding.module);
    if (!selected.unit || !found.binding.imported)
      return {
        failure:
          selected.state === "ambiguous"
            ? "ambiguous-definition"
            : "no-selected-definition",
      };
    return follow(
      lookup(selected.unit, "module", found.binding.imported),
      visited,
      depth + 1,
    );
  };
  const pythonFiles = new Set(
    units.map((unit) => key(unit.revision, unit.file)),
  );
  analysis.modules = analysis.modules.filter(
    (module) => !pythonFiles.has(key(module.revision, module.file)),
  );
  analysis.references = analysis.references.filter(
    (reference) => !pythonFiles.has(key(reference.revision, reference.file)),
  );
  for (const unit of units) {
    for (const imported of unit.imports) {
      const selected = findModule(unit, imported.specifier);
      analysis.modules.push({
        ...imported,
        kind: "import",
        targetFile: selected.unit?.file ?? null,
        resolution: selected.state,
      });
      if (selected.state !== "selected") omissions.add("unresolved-import");
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
              captured.receiver?.split(".")[0] ?? captured.callee,
            );
      if (!("failure" in found) && captured.receiver !== null) {
        if (
          found.binding.kind !== "module" ||
          found.binding.receiver !== captured.receiver
        )
          found = { failure: "unsupported-dispatch" };
        else {
          const selected = findModule(found.unit, found.binding.module);
          found = selected.unit
            ? lookup(selected.unit, "module", captured.callee!)
            : {
                failure:
                  selected.state === "ambiguous"
                    ? "ambiguous-definition"
                    : "no-selected-definition",
              };
        }
      }
      found = follow(found, new Set());
      if (
        !("failure" in found) &&
        found.binding.kind === "function" &&
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
      const found = follow(
        lookup(unit, reference.scope, reference.name),
        new Set(),
      );
      if ("failure" in found || found.binding.declarationId === null) continue;
      const address = {
        revision: reference.revision,
        file: reference.file,
        start: reference.start,
        end: reference.end,
        startLine: reference.startLine,
        endLine: reference.endLine,
      };
      analysis.references.push({
        ...address,
        fromFunctionId: reference.caller,
        ownerDeclarationId: reference.owner,
        targetDeclarationId: found.binding.declarationId,
      });
    }
  }
  const selectedCalls = analysis.calls.filter((call) =>
    pythonFiles.has(key(call.revision, call.file)),
  );
  const selectedImports = analysis.modules.filter((module) =>
    pythonFiles.has(key(module.revision, module.file)),
  );
  const closure = pythonCallerClosure(
    analysis,
    primary.filter((file) => file.endsWith(".py")),
  );
  if (closure.exhausted) omissions.add("depth-limit");
  if (analysis.files.some((file) => file.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((file) => !file.file.endsWith(".py")))
    omissions.add("non-python-source");
  if (
    !analysis.functions.some(
      (fn) => fn.file.endsWith(".py") && primary.includes(fn.file),
    )
  )
    omissions.add("no-selected-functions");
  const resolvedCalls = selectedCalls.filter(
    (call) => call.resolution === "lexical-binding",
  ).length;
  const resolvedImports = selectedImports.filter(
    (module) => module.resolution === "selected",
  ).length;
  const result = {
    ...analysis,
    profile: "python-selected-bindings-v1" as const,
    pythonBindings: {
      moduleRoots: roots,
      scope: "selected-captured-python-source" as const,
      state: [...omissions].some(
        (reason) =>
          ![
            "unselected-source",
            "runtime-rebinding",
            "runtime-dispatch",
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
        imports: selectedImports.length,
        resolvedImports,
        unresolvedImports: selectedImports.length - resolvedImports,
      },
      fullImpactFallback: true as const,
      runtimeReachabilityVerified: false as const,
      validationPlanUnchanged: true as const,
      omissions: [...omissions].sort(),
    },
  };
  if (
    Buffer.byteLength(JSON.stringify(result)) > 256 * 1024 ||
    analysis.references.length > 8192 ||
    analysis.modules.length > 512
  )
    throw new Error("Python binding metadata budget exhausted");
  return reviewPythonBehaviorSchema.parse(result);
}
