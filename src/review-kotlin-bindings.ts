import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateKotlinModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type KotlinScope = {
  id: string;
  parent: string | null;
  caller: string | null;
  unknown: boolean;
  kind: "file" | "function" | "block" | "class" | "lambda";
};
export type KotlinBinding = {
  name: string;
  scope: string;
  kind: "function" | "constant" | "value" | "type";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  private: boolean;
  unsupported: boolean;
};
export type KotlinSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  packageName: string | null;
  scopes: KotlinScope[];
  bindings: KotlinBinding[];
  imports: (Range & {
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
const named = (node: Node | null | undefined) =>
  node && /^[A-Za-z_][A-Za-z_0-9]*$/.test(node.text) ? node.text : null;
const child = (node: Node, kind: string) =>
  node.namedChildren.find((n) => n.type === kind);
function qualified(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "simple_identifier" || node.type === "type_identifier")
    return named(node);
  if (node.type === "identifier") {
    const parts = node.namedChildren.map(named);
    return parts.length && parts.every((p) => p !== null)
      ? parts.join(".")
      : null;
  }
  if (node.type === "navigation_expression") {
    const prefix = qualified(node.namedChildren[0]);
    const suffix = node.namedChildren[1];
    const name =
      suffix?.type === "navigation_suffix" && suffix.children[0]?.type === "."
        ? named(suffix.namedChildren[0])
        : null;
    return prefix && name ? prefix + "." + name : null;
  }
  return null;
}
const modifiers = (node: Node) =>
  new Set(child(node, "modifiers")?.namedChildren.map((n) => n.text) ?? []);
/** Retain immutable source names while the syntax tree is alive; no compiler, script or project configuration runs. */
export function captureKotlinBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): KotlinSyntaxUnit {
  const address = range(nodes[0]!);
  const scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (fnIds.has(node.id)) scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (
      [
        "class_declaration",
        "object_declaration",
        "object_literal",
        "companion_object",
      ].includes(node.type)
    )
      scopeNodes.set(node.id, "class:" + node.startIndex);
    else if (
      [
        "statements",
        "for_statement",
        "catch_block",
        "when_expression",
      ].includes(node.type)
    )
      scopeNodes.set(node.id, "block:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) {
      const id = scopeNodes.get(p.id);
      if (id) return id;
    }
    return "file";
  };
  const scopes: KotlinScope[] = [
    {
      id: "file",
      parent: null,
      caller: null,
      unknown: address.file.endsWith(".kts"),
      kind: "file",
    },
  ];
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (!id) continue;
    const fn = fnIds.has(node.id),
      flags = modifiers(node),
      kind = fn
        ? node.type === "lambda_literal" || node.type === "anonymous_function"
          ? "lambda"
          : "function"
        : [
              "class_declaration",
              "object_declaration",
              "object_literal",
              "companion_object",
            ].includes(node.type)
          ? "class"
          : "block";
    scopes.push({
      id,
      parent: scopeFor(node),
      caller: fn ? fnIds.get(node.id)! : null,
      kind,
      unknown:
        kind === "class" ||
        kind === "lambda" ||
        ["for_statement", "catch_block", "when_expression"].includes(
          node.type,
        ) ||
        (fn &&
          (node.childForFieldName("receiver") !== null ||
            child(node, "type_parameters") !== undefined ||
            child(node, "type_constraints") !== undefined ||
            [...flags].some(
              (f) => !["public", "private", "internal", "tailrec"].includes(f),
            ))),
    });
  }
  const byScope = new Map(scopes.map((s) => [s.id, s]));
  const ancestry = (scope: string) => {
    const out: KotlinScope[] = [];
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
  const packages = nodes.filter((n) => n.type === "package_header");
  const packageName =
    packages.length === 0
      ? ""
      : packages.length === 1
        ? qualified(child(packages[0]!, "identifier"))
        : null;
  const result: KotlinSyntaxUnit = {
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
  if (address.file.endsWith(".kts")) omit("file", "script-loading-unknown");
  if (packageName === null) omit("file", "unsupported-package");
  const ignored = new Set<number>();
  function add(
    node: Node | null | undefined,
    scope: string,
    kind: KotlinBinding["kind"],
    visibleFrom = 0,
    extra: Partial<KotlinBinding> = {},
  ) {
    if (!node) return;
    ignored.add(node.id);
    const name = named(node);
    if (!name) {
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
    if (node.type === "function_declaration") {
      const own = scopeNodes.get(node.id)!,
        declarationName = child(node, "simple_identifier");
      const local = scope !== "file";
      add(declarationName, scope, "function", local ? node.startIndex : 0, {
        functionId: fnIds.get(node.id) ?? null,
        declarationId: declarations.get(node.id)?.id ?? null,
        private: flags.has("private"),
        unsupported:
          byScope.get(own)!.unknown ||
          child(node, "function_body") === undefined,
      });
      if (byScope.get(own)!.unknown) omit(own, "unsupported-function", false);
    }
    if (
      ["class_declaration", "object_declaration", "type_alias"].includes(
        node.type,
      )
    ) {
      add(
        child(node, "type_identifier") ?? child(node, "simple_identifier"),
        scope,
        "type",
        scope === "file" ? 0 : node.startIndex,
        { unsupported: true },
      );
      omit(scope, "unsupported-type", false);
    }
    if (node.type === "object_literal") omit(scope, "unsupported-type");
    if (node.type === "property_declaration") {
      const variable = child(node, "variable_declaration"),
        constant = scope === "file" && flags.has("const"),
        unsupported =
          child(node, "multi_variable_declaration") !== undefined ||
          child(node, "getter") !== undefined ||
          child(node, "setter") !== undefined ||
          child(node, "property_delegate") !== undefined ||
          [...flags].some(
            (f) => !["public", "private", "internal", "const"].includes(f),
          );
      add(
        variable ? child(variable, "simple_identifier") : null,
        scope,
        constant ? "constant" : "value",
        scope === "file" ? 0 : node.startIndex,
        {
          declarationId: declarations.get(node.id)?.id ?? null,
          private: flags.has("private"),
          unsupported,
        },
      );
      if (unsupported) omit(scope, "unsupported-property");
    }
    if (node.type === "parameter") {
      let fn = node.parent;
      while (fn && !fnIds.has(fn.id)) fn = fn.parent;
      if (fn)
        add(child(node, "simple_identifier"), scopeNodes.get(fn.id)!, "value");
    }
    if (node.type === "import_header") {
      const specifier = qualified(child(node, "identifier")),
        aliasNode = child(node, "import_alias"),
        alias = aliasNode
          ? named(aliasNode.namedChildren[0])
          : (specifier?.split(".").at(-1) ?? null),
        unsupported =
          specifier === null ||
          alias === null ||
          child(node, "wildcard_import") !== undefined;
      result.imports.push({ ...range(node), specifier, alias, unsupported });
      if (unsupported) omit("file", "unsupported-import");
    }
    if (
      fnIds.has(node.id) &&
      node.type !== "function_declaration" &&
      byScope.get(scopeNodes.get(node.id)!)!.unknown
    )
      omit(scopeNodes.get(node.id)!, "unsupported-function", false);
    if (node.type.includes("annotation")) omit(scope, "annotations-unknown");
    if (
      [
        "delegation_specifiers",
        "delegation_specifier",
        "type_parameters",
        "type_arguments",
        "type_constraints",
      ].includes(node.type)
    )
      omit(scope, "unsupported-type");
    if (node.type === "multi_variable_declaration")
      omit(scope, "unsupported-pattern");
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "call_expression") {
      const expression = qualified(node.namedChildren[0]),
        parts = expression?.split(".") ?? [],
        name = parts.pop() ?? null;
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        name,
        qualifier: parts.length ? parts.join(".") : null,
        unsupported:
          expression === null ||
          node.namedChildren.some((n) => n.type === "type_arguments"),
      });
    }
    if (
      !["simple_identifier", "navigation_expression"].includes(node.type) ||
      ignored.has(node.id) ||
      node.parent?.type === "navigation_expression" ||
      node.parent?.type === "navigation_suffix"
    )
      continue;
    const expression = qualified(node);
    if (expression === null) continue;
    let skip = false;
    for (let p = node.parent; p; p = p.parent) {
      if (
        [
          "package_header",
          "import_header",
          "modifiers",
          "user_type",
          "receiver_type",
          "type_parameters",
          "type_arguments",
          "callable_reference",
          "label",
        ].includes(p.type) ||
        p.type.endsWith("_type")
      ) {
        skip = true;
        break;
      }
      if (
        (p.type === "call_expression" && p.namedChildren[0]?.id === node.id) ||
        (p.type === "value_argument" &&
          p.namedChildren[0]?.id === node.id &&
          p.children.some((n) => n.type === "="))
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
