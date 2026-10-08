import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type RustScope = {
  id: string;
  parent: string | null;
  kind: "module" | "function" | "closure" | "block" | "associated";
  functionId: string | null;
  unknown: boolean;
};
export type RustBinding = {
  name: string;
  scope: string;
  namespace: "value" | "type" | "both";
  kind: "function" | "constant" | "module" | "import" | "local" | "other";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  targetScope: string | null;
  importPath: string | null;
  unsupported: boolean;
};
export type RustSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  scopes: RustScope[];
  bindings: RustBinding[];
  modules: (Range & {
    name: string | null;
    scope: string;
    bodyScope: string | null;
    unsupported: boolean;
  })[];
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
    unsupported: boolean;
  })[];
  references: (Range & {
    scope: string;
    caller: string | null;
    owner: string | null;
    name: string;
  })[];
  omissions: string[];
};
const field = (node: Node, name: string) => node.childForFieldName(name);
const ascii = (name: string) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(name);
const named = (node: Node | null) =>
  node && ascii(node.text) && !node.text.startsWith("r#") ? node.text : null;
const unwrap = (node: Node): Node =>
  node.type === "parenthesized_expression" && node.namedChildren.length === 1
    ? unwrap(node.namedChildren[0]!)
    : node;
function qualified(node: Node | null): string | null {
  if (!node) return null;
  const n = unwrap(node);
  if (["identifier", "self", "super", "crate"].includes(n.type))
    return named(n);
  if (n.type === "scoped_identifier") {
    const prefix = qualified(field(n, "path")),
      suffix = named(field(n, "name"));
    return prefix && suffix ? prefix + "::" + suffix : null;
  }
  return null;
}
function attributed(node: Node): boolean {
  for (
    let previous = node.previousNamedSibling;
    previous;
    previous = previous.previousNamedSibling
  ) {
    if (previous.type.includes("comment")) continue;
    return previous.type === "attribute_item";
  }
  return false;
}
/** Collect captured Rust names and scope boundaries without running a compiler or loading modules. */
export function captureRustBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): RustSyntaxUnit {
  const address = range(nodes[0]!);
  const scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (node.type === "mod_item" && field(node, "body"))
      scopeNodes.set(node.id, "module:" + node.startIndex);
    else if (
      ["function_item", "closure_expression"].includes(node.type) &&
      fnIds.has(node.id)
    )
      scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (["block", "impl_item", "trait_item"].includes(node.type))
      scopeNodes.set(node.id, "scope:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const id = scopeNodes.get(parent.id);
      if (!id) continue;
      if (
        ["function_item", "closure_expression", "mod_item"].includes(
          parent.type,
        )
      ) {
        const body = field(parent, "body");
        if (
          !body ||
          node.startIndex < body.startIndex ||
          node.endIndex > body.endIndex
        )
          continue;
      }
      return id;
    }
    return "file";
  };
  const scopes: RustScope[] = [
    {
      id: "file",
      parent: null,
      kind: "module",
      functionId: null,
      unknown: false,
    },
  ];
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (id)
      scopes.push({
        id,
        parent: scopeFor(node),
        kind:
          node.type === "mod_item"
            ? "module"
            : node.type === "function_item"
              ? "function"
              : node.type === "closure_expression"
                ? "closure"
                : node.type === "block"
                  ? "block"
                  : "associated",
        functionId: fnIds.get(node.id) ?? null,
        unknown:
          ["impl_item", "trait_item"].includes(node.type) ||
          attributed(node) ||
          field(node, "type_parameters") !== null,
      });
  }
  const byScope = new Map(scopes.map((scope) => [scope.id, scope]));
  const caller = (scope: string) => {
    for (
      let current = byScope.get(scope);
      current;
      current =
        current.parent === null ? undefined : byScope.get(current.parent)
    )
      if (current.functionId) return current.functionId;
    return null;
  };
  const result: RustSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    scopes,
    bindings: [],
    modules: [],
    imports: [],
    calls: [],
    references: [],
    omissions: [],
  };
  const ignored = new Set<number>();
  const omit = (scope: string, reason: string, unknown = true) => {
    if (unknown) byScope.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  const add = (
    node: Node | null,
    scope: string,
    kind: RustBinding["kind"],
    namespace: RustBinding["namespace"],
    visibleFrom = 0,
    extra: Partial<RustBinding> = {},
  ) => {
    if (!node) return;
    ignored.add(node.id);
    if (node.text === "_") return;
    const name = named(node);
    if (name === null) {
      omit(scope, "unsupported-binding");
      return;
    }
    result.bindings.push({
      name,
      scope,
      kind,
      namespace,
      visibleFrom,
      functionId: null,
      declarationId: null,
      targetScope: null,
      importPath: null,
      unsupported: false,
      ...extra,
    });
  };
  function use(
    node: Node,
    prefix: string,
    scope: string,
    unsupported: boolean,
  ): void {
    if (node.type === "scoped_use_list") {
      const value = qualified(field(node, "path")),
        list = field(node, "list");
      if (value !== null && list) {
        for (const child of list.namedChildren)
          use(child, prefix + value + "::", scope, unsupported);
        return;
      }
    }
    if (node.type === "use_list") {
      for (const child of node.namedChildren)
        use(child, prefix, scope, unsupported);
      return;
    }
    const value = qualified(
      node.type === "use_as_clause" ? field(node, "path") : node,
    );
    let specifier = value === null ? null : prefix + value;
    let aliasNode = node.type === "use_as_clause" ? field(node, "alias") : node;
    if (value === "self" && prefix) {
      specifier = prefix.slice(0, -2);
      if (node.type !== "use_as_clause") aliasNode = null;
    }
    const alias =
      node.type === "use_as_clause"
        ? named(aliasNode)
        : (specifier?.split("::").at(-1) ?? null);
    const invalid =
      unsupported ||
      specifier === null ||
      alias === null ||
      !ascii(alias) ||
      node.type === "use_wildcard";
    result.imports.push({
      ...range(node),
      scope,
      specifier,
      alias,
      unsupported: invalid,
    });
    if (invalid) omit(scope, "unsupported-import");
    if (alias !== null && alias !== "_" && ascii(alias))
      result.bindings.push({
        name: alias,
        scope,
        kind: "import",
        namespace: "both",
        visibleFrom: 0,
        functionId: null,
        declarationId: null,
        targetScope: null,
        importPath: specifier,
        unsupported: invalid,
      });
  }
  for (const node of nodes) {
    const scope = scopeFor(node),
      attributes = attributed(node);
    if (node.type === "inner_attribute_item")
      omit(scope, "unsupported-attributes");
    if (node.type === "attribute_item")
      omit(scope, "unsupported-attributes", false);
    if (node.type === "macro_invocation")
      omit(scope, "macro-expansion-unknown");
    if (node.type === "macro_definition")
      omit(scope, "macro-expansion-unknown", false);
    if (["function_item", "const_item", "static_item"].includes(node.type)) {
      const name = field(node, "name"),
        kind = node.type === "function_item" ? "function" : "constant";
      add(name, scope, kind, "value", 0, {
        functionId:
          node.type === "function_item" ? (fnIds.get(node.id) ?? null) : null,
        declarationId: declarations.get(node.id)?.id ?? null,
        unsupported:
          attributes ||
          field(node, "type_parameters") !== null ||
          byScope.get(scope)?.kind === "associated",
      });
    }
    if (
      [
        "struct_item",
        "enum_item",
        "trait_item",
        "type_item",
        "union_item",
      ].includes(node.type)
    )
      add(field(node, "name"), scope, "other", "type");
    if (
      node.type === "struct_item" &&
      (field(node, "body") === null ||
        field(node, "body")?.type === "ordered_field_declaration_list")
    )
      add(field(node, "name"), scope, "other", "value");
    if (node.type === "mod_item") {
      const name = named(field(node, "name")),
        bodyScope = scopeNodes.get(node.id) ?? null,
        unsupported = attributes || byScope.get(scope)?.kind !== "module";
      const nameNode = field(node, "name");
      if (nameNode) ignored.add(nameNode.id);
      result.modules.push({
        ...range(node),
        name,
        scope,
        bodyScope,
        unsupported,
      });
      add(nameNode, scope, "module", "type", 0, {
        targetScope: bodyScope,
        unsupported,
      });
      if (unsupported) omit(scope, "unsupported-module", false);
    }
    if (node.type === "use_declaration") {
      const argument = field(node, "argument");
      if (argument) use(argument, "", scope, attributes);
      else omit(scope, "unsupported-import");
    }
    if (node.type === "parameter") {
      let functionNode = node.parent;
      while (
        functionNode &&
        !["function_item", "closure_expression"].includes(functionNode.type)
      )
        functionNode = functionNode.parent;
      const target = functionNode ? scopeNodes.get(functionNode.id) : null,
        pattern = field(node, "pattern");
      if (target && pattern) {
        if (pattern.type === "identifier" || pattern.type === "self")
          add(pattern, target, "local", "value");
        else if (pattern.type !== "_") omit(target, "unsupported-pattern");
      }
    }
    if (node.type === "closure_parameters")
      for (const child of node.namedChildren) {
        if (child.type === "identifier")
          add(child, scopeNodes.get(node.parent!.id)!, "local", "value");
        else if (!["parameter", "_"].includes(child.type))
          omit(scopeNodes.get(node.parent!.id)!, "unsupported-pattern");
      }
    if (node.type === "let_declaration") {
      const pattern = field(node, "pattern");
      if (pattern?.type === "identifier")
        add(pattern, scope, "local", "value", node.endIndex);
      else if (pattern?.type !== "_") omit(scope, "unsupported-pattern");
    }
    if (["let_condition", "for_expression", "match_arm"].includes(node.type))
      omit(scope, "unsupported-pattern");
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "call_expression") {
      const fn = field(node, "function");
      const name = qualified(fn);
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        name,
        unsupported: name === null,
      });
    }
    if (
      !["identifier", "scoped_identifier"].includes(node.type) ||
      ignored.has(node.id)
    )
      continue;
    if (node.parent?.type === "scoped_identifier") continue;
    const name = qualified(node);
    if (name === null) continue;
    let skip = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        [
          "use_declaration",
          "macro_invocation",
          "macro_definition",
          "attribute_item",
          "inner_attribute_item",
          "lifetime",
          "label",
        ].includes(parent.type)
      ) {
        skip = true;
        break;
      }
      if (
        parent.type === "call_expression" &&
        field(parent, "function") &&
        node.startIndex >= field(parent, "function")!.startIndex &&
        node.endIndex <= field(parent, "function")!.endIndex
      ) {
        skip = true;
        break;
      }
      if (
        parent.type.endsWith("type") ||
        parent.type.includes("pattern") ||
        (parent.type === "parameter" &&
          field(parent, "pattern") &&
          node.startIndex >= field(parent, "pattern")!.startIndex &&
          node.endIndex <= field(parent, "pattern")!.endIndex)
      ) {
        skip = true;
        break;
      }
    }
    if (skip || node.parent?.type === "field_expression") continue;
    let owner: string | null = null;
    for (let parent = node.parent; parent; parent = parent.parent)
      if (declarations.has(parent.id)) {
        owner = declarations.get(parent.id)!.id;
        break;
      }
    result.references.push({
      ...range(node),
      scope,
      caller: caller(scope),
      owner,
      name,
    });
  }
  return result;
}
export function validateRustCrateRoots(roots: string[]): void {
  try {
    validatePythonModuleRoots(roots);
    if (
      roots.some(
        (root) =>
          !root.endsWith(".rs") ||
          root === "." ||
          path.posix.normalize(root) !== root,
      )
    )
      throw Error();
  } catch {
    throw new Error("Invalid operator-selected Rust crate entry roots");
  }
}
