import { vbGrammarManifestDigest } from "./review-vb-grammar-assets.js";
import {
  reviewVbBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { pythonCallerClosure } from "./review-python-resolution.js";
import {
  validateVbModuleRoots,
  vbSourceOmissions,
  type VbSyntaxUnit,
  type VbModule,
  type VbBinding,
} from "./review-vb-bindings.js";
type Analysis = Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>;
type VbAnalysis = Extract<
  ReviewBehavior,
  { profile: "vb-selected-bindings-v1" }
>;
const key = (...values: string[]) => JSON.stringify(values),
  beneath = (file: string, roots: string[]) =>
    roots.some((root) => root === "." || file.startsWith(root + "/")),
  sourceFile = (file: string) => file.endsWith(".vb");
const omissionValues =
  reviewVbBehaviorSchema.shape.vbBindings.shape.omissions.element.options;
type Omission = (typeof omissionValues)[number];
type Address = { unit: VbSyntaxUnit; module: VbModule };
type Found =
  | { target: Address; binding: VbBinding | null }
  | {
      failure:
        | "no-selected-definition"
        | "ambiguous-definition"
        | "unsupported-dispatch";
    };
const fixed: Omission[] = [
  "unselected-source",
  "runtime-rebinding",
  "runtime-dispatch",
  "module-loading-unknown",
  "build-selection-unknown",
  "root-namespace-unknown",
  "project-imports-unknown",
  "assembly-visibility-unknown",
];
/** Case-folded selected source candidates only; native root namespace, project imports, assembly access and dispatch stay unverified. */
export function resolveVbBindings(
  analysis: Analysis,
  units: VbSyntaxUnit[],
  roots: string[],
  primary: string[],
): VbAnalysis {
  validateVbModuleRoots(roots);
  const omissions = new Set<Omission>(fixed);
  const modules = new Map<string, Address[]>();
  for (const unit of units) {
    if (!beneath(unit.file, roots)) omissions.add("outside-module-roots");
    for (const reason of unit.omissions)
      if (omissionValues.includes(reason as Omission))
        omissions.add(reason as Omission);
    if (beneath(unit.file, roots))
      for (const module of unit.modules)
        if (module.qualifiedName !== null) {
          const address = key(unit.revision, module.qualifiedName);
          modules.set(address, [
            ...(modules.get(address) ?? []),
            { unit, module },
          ]);
        }
  }
  function scopes(unit: VbSyntaxUnit, scope: string) {
    const map = new Map(unit.scopes.map((s) => [s.id, s])),
      out = [];
    for (
      let s = map.get(scope);
      s;
      s = s.parent === null ? undefined : map.get(s.parent)
    )
      out.push(s);
    return out;
  }
  const usable = (unit: VbSyntaxUnit, scope: string) =>
    beneath(unit.file, roots) && scopes(unit, scope).every((s) => !s.unknown);
  function own(unit: VbSyntaxUnit, scope: string): Address | null {
    const id = scopes(unit, scope).find((s) => s.kind === "module")?.id,
      module = unit.modules.find((m) => m.scope === id);
    return module ? { unit, module } : null;
  }
  function at(unit: VbSyntaxUnit, name: string): Found {
    const values = modules.get(key(unit.revision, name)) ?? [];
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const target = values[0]!;
    return target.module.unsupported ||
      !usable(target.unit, target.module.scope)
      ? { failure: "unsupported-dispatch" }
      : { target, binding: null };
  }
  function masked(unit: VbSyntaxUnit, scope: string, name: string) {
    return scopes(unit, scope).some((s) =>
      unit.bindings.some(
        (b) =>
          b.scope === s.id &&
          b.name === name &&
          (b.kind === "local" || b.kind === "constant"),
      ),
    );
  }
  function moduleName(unit: VbSyntaxUnit, scope: string, name: string): Found {
    if (!usable(unit, scope) || masked(unit, scope, name.split(".")[0]!))
      return { failure: "unsupported-dispatch" };
    const parts = name.split("."),
      first = parts[0]!,
      aliases = unit.imports.filter((i) => i.alias === first);
    if (aliases.length) {
      if (aliases.length !== 1) return { failure: "ambiguous-definition" };
      const value = aliases[0]!,
        local = own(unit, scope);
      if (parts.length === 1 && local?.module.name === first)
        return { failure: "ambiguous-definition" };
      return value.unsupported || value.specifier === null
        ? { failure: "unsupported-dispatch" }
        : at(
            unit,
            value.specifier +
              (parts.length > 1 ? "." + parts.slice(1).join(".") : ""),
          );
    }
    const ns = own(unit, scope)?.module.namespace;
    if (ns !== undefined && ns !== null) {
      const local = at(unit, (ns ? ns + "." : "") + name);
      if ("target" in local || local.failure !== "no-selected-definition")
        return local;
    }
    const exact = at(unit, name);
    if ("target" in exact || exact.failure !== "no-selected-definition")
      return exact;
    const imported = unit.imports.filter((i) => i.alias === null);
    if (
      imported.some(
        (i) =>
          i.unsupported ||
          i.specifier === null ||
          ![...modules.values()]
            .flat()
            .some(
              (m) =>
                m.unit.revision === unit.revision &&
                m.module.namespace === i.specifier,
            ),
      )
    )
      return { failure: "unsupported-dispatch" };
    return choose(imported.map((i) => at(unit, i.specifier + "." + name)));
  }
  function member(
    unit: VbSyntaxUnit,
    scope: string,
    target: Address,
    name: string,
    kind: "function" | "constant",
  ): Found {
    if (!usable(target.unit, target.module.scope))
      return { failure: "unsupported-dispatch" };
    const values = target.unit.bindings.filter(
      (b) => b.scope === target.module.scope && b.name === name,
    );
    if (values.length !== 1)
      return {
        failure: values.length
          ? "ambiguous-definition"
          : "no-selected-definition",
      };
    const binding = values[0]!,
      caller = own(unit, scope);
    return binding.unsupported ||
      (kind === "function"
        ? binding.kind !== "method" || binding.functionId === null
        : binding.kind !== "constant" || !binding.literal) ||
      (binding.access === "private" &&
        !(
          caller?.unit.file === target.unit.file &&
          caller.module.scope === target.module.scope
        ))
      ? { failure: "unsupported-dispatch" }
      : { target, binding };
  }
  function choose(found: Found[]): Found {
    const candidates = found.filter((f) => "target" in f);
    if (
      candidates.length === 1 &&
      found.every(
        (f) => "target" in f || f.failure === "no-selected-definition",
      )
    )
      return candidates[0]!;
    return {
      failure:
        candidates.length > 1 ||
        found.some(
          (f) => "failure" in f && f.failure === "ambiguous-definition",
        )
          ? "ambiguous-definition"
          : found.some(
                (f) => "failure" in f && f.failure === "unsupported-dispatch",
              )
            ? "unsupported-dispatch"
            : "no-selected-definition",
    };
  }
  function resolve(
    unit: VbSyntaxUnit,
    scope: string,
    name: string,
    qualifier: string | null,
    _position: number,
    kind: "function" | "constant",
  ): Found {
    if (!usable(unit, scope)) return { failure: "unsupported-dispatch" };
    if (qualifier !== null) {
      const target = moduleName(unit, scope, qualifier);
      return "target" in target
        ? member(unit, scope, target.target, name, kind)
        : target;
    }
    for (const s of scopes(unit, scope).filter((s) => s.kind === "function"))
      if (unit.bindings.some((b) => b.scope === s.id && b.name === name))
        return { failure: "unsupported-dispatch" };
    const caller = own(unit, scope);
    if (
      caller &&
      unit.bindings.some(
        (b) => b.scope === caller.module.scope && b.name === name,
      )
    )
      return member(unit, scope, caller, name, kind);
    const namespace = caller?.module.namespace;
    if (namespace !== undefined && namespace !== null) {
      const found = choose(
        [...modules.values()]
          .flat()
          .filter(
            (m) =>
              m.unit.revision === unit.revision &&
              m.module.namespace === namespace,
          )
          .map((m) => {
            const target = at(unit, m.module.qualifiedName!);
            return "target" in target
              ? member(unit, scope, target.target, name, kind)
              : target;
          }),
      );
      if ("target" in found || found.failure !== "no-selected-definition")
        return found;
    }
    const imported = unit.imports.filter((i) => i.alias === null);
    const found: Found[] = [];
    for (const value of imported) {
      if (value.unsupported || value.specifier === null) {
        found.push({ failure: "unsupported-dispatch" });
        continue;
      }
      const target = at(unit, value.specifier);
      if ("target" in target)
        found.push(member(unit, scope, target.target, name, kind));
      else if (target.failure !== "no-selected-definition") found.push(target);
      else {
        const selected = [...modules.values()]
          .flat()
          .filter(
            (m) =>
              m.unit.revision === unit.revision &&
              m.module.namespace === value.specifier,
          );
        if (!selected.length) found.push({ failure: "unsupported-dispatch" });
        else
          for (const m of selected) {
            const t = at(unit, m.module.qualifiedName!);
            found.push(
              "target" in t ? member(unit, scope, t.target, name, kind) : t,
            );
          }
      }
    }
    return choose(found);
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
      const selected =
        imported.specifier === null
          ? []
          : [...modules.values()]
              .flat()
              .filter(
                (m) =>
                  m.unit.revision === unit.revision &&
                  (m.module.qualifiedName === imported.specifier ||
                    m.module.namespace === imported.specifier),
              );
      const files = [...new Set(selected.map((m) => m.unit.file))];
      const ambiguous = selected.some(
        (m) =>
          (modules.get(key(unit.revision, m.module.qualifiedName!)) ?? [])
            .length !== 1,
      );
      const resolution: ReviewBehavior["modules"][number]["resolution"] =
        imported.unsupported || !usable(unit, "file")
          ? "dynamic"
          : ambiguous || files.length > 1
            ? "ambiguous"
            : files.length === 1
              ? selected.every(
                  (m) =>
                    usable(m.unit, m.module.scope) && !m.module.unsupported,
                )
                ? "selected"
                : "unparsed"
              : "external";
      analysis.modules.push({
        revision: imported.revision,
        file: imported.file,
        start: imported.start,
        end: imported.end,
        startLine: imported.startLine,
        endLine: imported.endLine,
        kind: "import",
        specifier: imported.specifier,
        targetFile:
          resolution === "selected" || resolution === "unparsed"
            ? files[0]!
            : null,
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
              source.start,
              "function",
            );
      if ("target" in found && found.binding?.functionId) {
        call.resolution = "lexical-binding";
        call.targetFunctionId = found.binding!.functionId;
      } else {
        call.resolution =
          "failure" in found ? found.failure : "unsupported-dispatch";
        call.targetFunctionId = null;
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
        source.start,
        "constant",
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
          targetDeclarationId: found.binding!.declarationId!,
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
    for (const reason of vbSourceOmissions(file.file, ""))
      omissions.add(reason);
  if (analysis.files.some((f) => sourceFile(f.file) && !beneath(f.file, roots)))
    omissions.add("outside-module-roots");
  if (analysis.files.some((f) => f.state !== "collected"))
    omissions.add("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    omissions.add("non-vb-source");
  if (
    !analysis.functions.some(
      (f) => sourceFile(f.file) && primary.includes(f.file),
    )
  )
    omissions.add("no-selected-functions");
  const result = {
    ...analysis,
    profile: "vb-selected-bindings-v1" as const,
    vbGrammarManifestDigest,
    vbBindings: {
      moduleRoots: roots,
      scope: "selected-captured-vb-source" as const,
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
    throw Error("Vb binding metadata budget exhausted");
  return reviewVbBehaviorSchema.parse(result);
}
export function validateVbReviewBindings(
  analysis: VbAnalysis,
  roots: string[],
  primary: string[],
  sources: { path: string; content: string }[],
): void {
  validateVbModuleRoots(roots);
  const bindings = analysis.vbBindings;
  if (JSON.stringify(bindings.moduleRoots) !== JSON.stringify(roots))
    throw Error("Vb binding module roots differ");
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
    throw Error("Vb binding counts do not reconcile");
  const mandatory: Omission[] = [...fixed];
  if (counts.unresolvedCalls) mandatory.push("unresolved-call");
  if (counts.unresolvedImports) mandatory.push("unresolved-import");
  if (analysis.files.some((f) => f.state !== "collected"))
    mandatory.push("partial-syntax");
  if (analysis.files.some((f) => !sourceFile(f.file)))
    mandatory.push("non-vb-source");
  for (const source of sources)
    if (sourceFile(source.path))
      mandatory.push(...vbSourceOmissions(source.path, source.content));
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
    throw Error("Vb binding omissions do not reconcile");
  if (JSON.stringify(bindings.callerEdges) !== JSON.stringify(closure.edges))
    throw Error("Vb caller closure does not reconcile");
}
