import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateScalaModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type ScalaScope = {
  id: string;
  parent: string | null;
  caller: string | null;
  unknown: boolean;
  kind: "file" | "function" | "block" | "class" | "lambda";
};
export type ScalaBinding = {
  name: string;
  scope: string;
  kind: "function" | "constant" | "value" | "type";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  private: boolean;
  unsupported: boolean;
};
export type ScalaSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  packageName: string | null;
  scopes: ScalaScope[];
  bindings: ScalaBinding[];
  imports: (Range & {
    scope: string;
    specifier: string | null;
    alias: string | null;
    unsupported: boolean;
  })[];
  calls: (Range & {
    scope: string;
    caller: string | null;
    name: string | null;
    qualifier: string | null;
    unsupported: boolean;
  })[];
  references: (Range & {
    scope: string;
    caller: string | null;
    declaration: string | null;
    name: string;
    qualifier: string | null;
  })[];
  omissions: string[];
};
const field = (node: Node, name: string) => node.childForFieldName(name);
const named = (node: Node | null | undefined) =>
  node && /^[A-Za-z_][A-Za-z_0-9]*$/.test(node.text) ? node.text : null;
function qualified(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "type_identifier")
    return named(node);
  if (node.type === "package_identifier") {
    const parts = node.namedChildren.map(named);
    return parts.length && parts.every((p) => p !== null)
      ? parts.join(".")
      : null;
  }
  if (node.type === "field_expression") {
    const prefix = qualified(field(node, "value")),
      suffix = named(field(node, "field"));
    return prefix && suffix ? prefix + "." + suffix : null;
  }
  return null;
}
const child = (node: Node, kind: string) =>
  node.namedChildren.find((n) => n.type === kind);
const modifiers = (node: Node) =>
  new Set(child(node, "modifiers")?.namedChildren.map((n) => n.text) ?? []);
const classKinds = [
  "class_definition",
  "object_definition",
  "trait_definition",
  "enum_definition",
  "package_object",
];
/** Capture plain Scala 3 lexical candidates from immutable strings, without running a compiler, script or build. */
export function captureScalaBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): ScalaSyntaxUnit {
  const address = range(nodes[0]!),
    scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (fnIds.has(node.id)) scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (classKinds.includes(node.type))
      scopeNodes.set(node.id, "class:" + node.startIndex);
    else if (
      [
        "block",
        "for_expression",
        "catch_clause",
        "case_clause",
        "match_expression",
      ].includes(node.type)
    )
      scopeNodes.set(node.id, "scope:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) {
      const id = scopeNodes.get(p.id);
      if (id) return id;
    }
    return "file";
  };
  const scopes: ScalaScope[] = [
    {
      id: "file",
      parent: null,
      caller: null,
      unknown: address.file.endsWith(".sc"),
      kind: "file",
    },
  ];
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (!id) continue;
    const fn = fnIds.has(node.id),
      kind = classKinds.includes(node.type)
        ? "class"
        : fn
          ? node.type === "lambda_expression"
            ? "lambda"
            : "function"
          : "block",
      flags = modifiers(node);
    scopes.push({
      id,
      parent: scopeFor(node),
      caller: fn ? fnIds.get(node.id)! : null,
      kind,
      unknown:
        kind === "class" ||
        kind === "lambda" ||
        [
          "for_expression",
          "catch_clause",
          "case_clause",
          "match_expression",
        ].includes(node.type) ||
        (fn &&
          (child(node, "type_parameters") !== undefined ||
            [...flags].some((f) => !["private", "final"].includes(f)))),
    });
  }
  const byScope = new Map(scopes.map((s) => [s.id, s]));
  const ancestry = (scope: string) => {
    const out: ScalaScope[] = [];
    for (
      let s = byScope.get(scope);
      s;
      s = s.parent === null ? undefined : byScope.get(s.parent)
    )
      out.push(s);
    return out;
  };
  const caller = (scope: string) =>
    ancestry(scope).find((s) => s.caller !== null)?.caller ?? null;
  const packages = nodes.filter((n) => n.type === "package_clause"),
    packageName =
      packages.length === 0
        ? ""
        : packages.length === 1 && field(packages[0]!, "body") === null
          ? qualified(field(packages[0]!, "name"))
          : null;
  const result: ScalaSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    packageName,
    scopes,
    bindings: [],
    imports: [],
    calls: [],
    references: [],
    omissions: [],
  };
  const omit = (scope: string, reason: string, unknown = true) => {
    if (unknown) byScope.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  if (address.file.endsWith(".sc")) omit("file", "script-loading-unknown");
  if (packageName === null) omit("file", "unsupported-package");
  const ignored = new Set<number>();
  function add(
    node: Node | null | undefined,
    scope: string,
    kind: ScalaBinding["kind"],
    visibleFrom = 0,
    extra: Partial<ScalaBinding> = {},
  ) {
    if (!node) return;
    ignored.add(node.id);
    const name = named(node);
    if (name === null) {
      omit(scope, "unsupported-binding");
      return;
    }
    result.bindings.push({
      name,
      scope,
      kind,
      visibleFrom,
      functionId: null,
      declarationId: null,
      private: false,
      unsupported: false,
      ...extra,
    });
  }
  for (const node of nodes) {
    const scope = scopeFor(node),
      flags = modifiers(node);
    if (
      node.type === "function_definition" ||
      node.type === "function_declaration"
    ) {
      const own = scopeNodes.get(node.id);
      add(field(node, "name"), scope, "function", 0, {
        functionId: fnIds.get(node.id) ?? null,
        declarationId: declarations.get(node.id)?.id ?? null,
        private: flags.has("private"),
        unsupported:
          own === undefined ||
          byScope.get(own)!.unknown ||
          field(node, "body") === null,
      });
      if (own && byScope.get(own)!.unknown)
        omit(own, "unsupported-function", false);
    }
    if (classKinds.includes(node.type) || node.type === "type_definition") {
      add(field(node, "name"), scope, "type", 0, { unsupported: true });
      omit(scope, "unsupported-type", false);
    }
    if (
      [
        "val_definition",
        "var_definition",
        "val_declaration",
        "var_declaration",
      ].includes(node.type)
    ) {
      const pattern = field(node, "pattern"),
        value = field(node, "value"),
        constant =
          node.type === "val_definition" &&
          scope === "file" &&
          value !== null &&
          [
            "string",
            "integer_literal",
            "floating_point_literal",
            "boolean_literal",
            "character_literal",
          ].includes(value.type),
        unsupported =
          pattern?.type !== "identifier" ||
          [...flags].some((f) => !["private", "final"].includes(f));
      add(pattern, scope, constant ? "constant" : "value", 0, {
        declarationId: declarations.get(node.id)?.id ?? null,
        private: flags.has("private"),
        unsupported,
      });
      if (unsupported) omit(scope, "unsupported-pattern");
    }
    if (node.type === "parameter") {
      let fn = node.parent;
      while (fn && !fnIds.has(fn.id)) fn = fn.parent;
      if (fn) add(field(node, "name"), scopeNodes.get(fn.id)!, "value");
    }
    if (node.type === "import_declaration") {
      if (scope !== "file") omit(scope, "unsupported-import");
      const identifiers = node.namedChildren.filter(
          (n) => n.type === "identifier",
        ),
        parts = identifiers.map(named),
        prefix = parts.every((p) => p !== null) ? parts.join(".") : null;
      const selectors = child(node, "namespace_selectors"),
        renamed = node.namedChildren.find((n) =>
          ["as_renamed_identifier", "arrow_renamed_identifier"].includes(
            n.type,
          ),
        );
      const push = (
        part: Node,
        specifier: string | null,
        alias: string | null,
        unsupported: boolean,
      ) => {
        result.imports.push({
          ...range(part),
          scope,
          specifier,
          alias,
          unsupported: unsupported || scope !== "file",
        });
        if (unsupported) omit(scope, "unsupported-import");
      };
      if (selectors) {
        for (const selector of selectors.namedChildren) {
          if (selector.type === "identifier") {
            const name = named(selector);
            push(
              selector,
              prefix && name ? prefix + "." + name : null,
              name,
              prefix === null || name === null,
            );
          } else if (
            ["as_renamed_identifier", "arrow_renamed_identifier"].includes(
              selector.type,
            )
          ) {
            const name = named(field(selector, "name")),
              alias = named(field(selector, "alias"));
            push(
              selector,
              prefix && name ? prefix + "." + name : null,
              alias,
              prefix === null ||
                name === null ||
                alias === null ||
                alias === "_",
            );
          } else push(selector, null, null, true);
        }
      } else if (renamed) {
        const name = named(field(renamed, "name")),
          alias = named(field(renamed, "alias"));
        push(
          node,
          prefix && name ? prefix + "." + name : null,
          alias,
          prefix === null || name === null || alias === null || alias === "_",
        );
      } else if (node.namedChildren.some((n) => n.type !== "identifier"))
        push(node, prefix, null, true);
      else
        push(
          node,
          prefix,
          parts.at(-1) ?? null,
          prefix === null || parts.length < 2,
        );
    }
    if (
      fnIds.has(node.id) &&
      node.type !== "function_definition" &&
      byScope.get(scopeNodes.get(node.id)!)!.unknown
    )
      omit(scopeNodes.get(node.id)!, "unsupported-function", false);
    if (node.type.includes("annotation")) omit(scope, "annotations-unknown");
    if (
      [
        "extension_definition",
        "given_definition",
        "given_declaration",
        "export_declaration",
        "implicit_function",
        "quote_expression",
        "splice_expression",
      ].includes(node.type)
    )
      omit(scope, "unsupported-function");
    if (node.type === "type_parameters" || node.type === "type_arguments")
      omit(scope, "unsupported-type");
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (
      node.type === "call_expression" ||
      node.type === "instance_expression"
    ) {
      const expression =
          node.type === "call_expression"
            ? qualified(field(node, "function"))
            : null,
        parts = expression?.split(".") ?? [],
        name = parts.pop() ?? null;
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        name,
        qualifier: parts.length ? parts.join(".") : null,
        unsupported: expression === null,
      });
      if (node.type === "instance_expression")
        omit(scope, "constructor-dispatch-unknown", false);
    }
    if (
      !["identifier", "field_expression"].includes(node.type) ||
      ignored.has(node.id) ||
      node.parent?.type === "field_expression"
    )
      continue;
    const expression = qualified(node);
    if (expression === null) continue;
    let skip = false;
    for (let p = node.parent; p; p = p.parent) {
      if (
        [
          "package_clause",
          "import_declaration",
          "modifiers",
          "type_parameters",
          "type_arguments",
          "annotation",
        ].includes(p.type) ||
        p.type.endsWith("_type")
      ) {
        skip = true;
        break;
      }
      if (
        (p.type === "call_expression" &&
          field(p, "function")?.id === node.id) ||
        (p.type === "assignment_expression" &&
          p.parent?.type === "arguments" &&
          field(p, "left")?.id === node.id)
      ) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    let declaration: string | null = null;
    for (let p = node.parent; p; p = p.parent)
      if (declarations.has(p.id)) {
        declaration = declarations.get(p.id)!.id;
        break;
      }
    const parts = expression.split("."),
      name = parts.pop()!;
    result.references.push({
      ...range(node),
      scope,
      caller: caller(scope),
      declaration,
      name,
      qualifier: parts.length ? parts.join(".") : null,
    });
  }
  return result;
}
