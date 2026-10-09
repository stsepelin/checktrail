import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type PhpNamespace = {
  id: string;
  name: string | null;
  start: number;
  end: number;
};
export type PhpImport = Range & {
  scope: string;
  kind: "function" | "constant" | "namespace";
  name: string | null;
  alias: string | null;
  visibleFrom: number;
};
export type PhpSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  namespaces: PhpNamespace[];
  bindings: {
    scope: string;
    name: string;
    kind: "function" | "constant";
    functionId: string | null;
    declarationId: string | null;
    conditional: boolean;
  }[];
  imports: PhpImport[];
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
  requires: (Range & { specifier: string | null; anchored: boolean })[];
  omissions: string[];
};
const field = (node: Node, name: string) => node.childForFieldName(name);
const ascii = (value: string) =>
  /^[A-Za-z_][A-Za-z_0-9]*(?:\\[A-Za-z_][A-Za-z_0-9]*)*$/.test(value);
const named = (node: Node | null) =>
  node && ascii(node.text.replace(/^\\/, "")) ? node.text : null;
const unwrapped = (node: Node): Node =>
  node.type === "parenthesized_expression" && node.namedChildren.length === 1
    ? unwrapped(node.namedChildren[0]!)
    : node;
function literal(node: Node | null): string | null {
  if (!node || !["string", "encapsed_string"].includes(node.type)) return null;
  const text = node.text;
  if (text.startsWith("'") && text.endsWith("'"))
    return text.slice(1, -1).replace(/\\([\\'])/g, "$1");
  if (text.startsWith('"') && text.endsWith('"') && !text.includes("$")) {
    // PHP does not share JSON's unicode, slash, backspace or form-feed escapes.
    for (let index = 1; index < text.length - 1; index++) {
      if (text[index] !== "\\") continue;
      if (!["\\", '"', "n", "r", "t"].includes(text[++index] ?? ""))
        return null;
    }
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}
/** Retain literal namespace metadata from captured trees without loading PHP or source. */
export function capturePhpBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  decls: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): PhpSyntaxUnit {
  const root = nodes[0]!,
    address = range(root);
  const definitions = nodes.filter(
    (node) => node.type === "namespace_definition",
  );
  const namespaces: PhpNamespace[] = [
    { id: "global", name: "", start: 0, end: root.endIndex },
  ];
  for (let i = 0; i < definitions.length; i++) {
    const node = definitions[i]!,
      body = field(node, "body"),
      name = field(node, "name");
    namespaces.push({
      id: "namespace:" + node.startIndex,
      name: name ? named(name) : "",
      start: node.startIndex,
      end: body
        ? node.endIndex
        : (definitions[i + 1]?.startIndex ?? root.endIndex),
    });
  }
  const namespaceFor = (node: Node) =>
    namespaces
      .slice(1)
      .find(
        (scope) => node.startIndex >= scope.start && node.endIndex <= scope.end,
      ) ?? namespaces[0]!;
  const caller = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (fnIds.has(parent.id)) return fnIds.get(parent.id)!;
    return null;
  };
  const owner = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent)
      if (decls.has(parent.id)) return decls.get(parent.id)!.id;
    return null;
  };
  const result: PhpSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    namespaces,
    bindings: [],
    imports: [],
    calls: [],
    references: [],
    requires: [],
    omissions: [],
  };
  const ignored = new Set<number>();
  const omit = (reason: string) => {
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  const top = (node: Node) => {
    let parent = node.parent;
    if (node.type === "const_element") parent = parent?.parent ?? null;
    return (
      parent?.type === "program" ||
      (parent?.type === "compound_statement" &&
        parent.parent?.type === "namespace_definition")
    );
  };
  for (const node of nodes) {
    const scope = namespaceFor(node);
    if (node.type === "namespace_definition") {
      const name = field(node, "name");
      if (name) ignored.add(name.id);
      if (scope.name === null) omit("unsupported-binding");
    }
    if (node.type === "function_definition" || node.type === "const_element") {
      const name =
        node.type === "function_definition"
          ? field(node, "name")
          : (node.namedChildren.find((child) => child.type === "name") ?? null);
      if (name) ignored.add(name.id);
      if (node.type === "const_element") {
        let member = false;
        for (let parent = node.parent; parent; parent = parent.parent)
          if (
            [
              "class_declaration",
              "interface_declaration",
              "trait_declaration",
              "enum_declaration",
            ].includes(parent.type)
          ) {
            member = true;
            break;
          }
        if (member) {
          omit("unsupported-binding");
          continue;
        }
      }
      const value = named(name);
      if (value && scope.name !== null) {
        result.bindings.push({
          scope: scope.id,
          name: (scope.name ? scope.name + "\\" : "") + value,
          kind: node.type === "function_definition" ? "function" : "constant",
          functionId:
            node.type === "function_definition"
              ? (fnIds.get(node.id) ?? null)
              : null,
          declarationId: decls.get(node.id)?.id ?? null,
          conditional: !top(node),
        });
        if (!top(node)) omit("conditional-declaration");
      } else omit("unsupported-binding");
    }
    if (node.type === "namespace_use_declaration") {
      const group = field(node, "body"),
        prefix = group
          ? (node.namedChildren.find((child) => child.type === "namespace_name")
              ?.text ?? null)
          : null;
      const clauses = (group?.namedChildren ?? node.namedChildren).filter(
        (child) => child.type === "namespace_use_clause",
      );
      for (const clause of clauses) {
        const aliasNode = field(clause, "alias"),
          part =
            clause.namedChildren.find(
              (child) =>
                child.id !== aliasNode?.id &&
                ["name", "qualified_name"].includes(child.type),
            ) ?? null;
        const suffix = named(part),
          name =
            suffix !== null && (!group || prefix !== null)
              ? (prefix ? prefix + "\\" : "") + suffix.replace(/^\\/, "")
              : null;
        const type =
          field(clause, "type")?.text ??
          field(node, "type")?.text ??
          "namespace";
        const alias = aliasNode?.text ?? name?.split("\\").at(-1) ?? null;
        result.imports.push({
          ...range(clause),
          scope: scope.id,
          kind:
            type === "function"
              ? "function"
              : type === "const"
                ? "constant"
                : "namespace",
          name,
          alias: alias && ascii(alias) ? alias : null,
          visibleFrom: node.endIndex,
        });
        if (name === null || alias === null || !ascii(alias))
          omit("unsupported-import");
      }
    }
  }
  for (const node of nodes) {
    const scope = namespaceFor(node);
    if (
      [
        "require_expression",
        "require_once_expression",
        "include_expression",
        "include_once_expression",
      ].includes(node.type)
    ) {
      const value = node.namedChildren[0] ?? null;
      const left =
          value?.type === "binary_expression" ? field(value, "left") : null,
        right =
          value?.type === "binary_expression" ? field(value, "right") : null,
        operator =
          value?.type === "binary_expression" ? field(value, "operator") : null;
      const suffix = literal(right);
      const anchored =
        left?.text === "__DIR__" &&
        operator?.text === "." &&
        suffix !== null &&
        suffix.startsWith("/");
      result.requires.push({
        ...range(node),
        specifier: anchored ? suffix : literal(value),
        anchored,
      });
      if (!anchored) omit("unresolved-loading");
    }
    if (
      [
        "function_call_expression",
        "member_call_expression",
        "nullsafe_member_call_expression",
        "scoped_call_expression",
      ].includes(node.type)
    ) {
      const original = field(node, "function"),
        fn = original ? unwrapped(original) : null;
      const name =
        fn && ["name", "qualified_name", "relative_name"].includes(fn.type)
          ? named(fn)
          : null;
      // Parenthesized bare names are callable expressions in PHP, not ordinary namespace calls.
      result.calls.push({
        ...range(node),
        scope: scope.id,
        caller: caller(node),
        name,
        unsupported:
          node.type !== "function_call_expression" ||
          original !== fn ||
          name === null,
      });
    }
    if (
      !["name", "qualified_name", "relative_name"].includes(node.type) ||
      ignored.has(node.id) ||
      !named(node)
    )
      continue;
    if (
      node.parent &&
      ["qualified_name", "relative_name", "namespace_name"].includes(
        node.parent.type,
      )
    )
      continue;
    let skip = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type === "namespace_use_declaration") {
        skip = true;
        break;
      }
      if (
        parent.type === "namespace_definition" &&
        field(parent, "name") &&
        node.startIndex <= field(parent, "name")!.endIndex
      ) {
        skip = true;
        break;
      }
    }
    if (
      skip ||
      (node.parent?.type === "function_call_expression" &&
        field(node.parent, "function")?.id === node.id)
    )
      continue;
    if (
      node.parent &&
      (["goto_statement", "named_label_statement"].includes(node.parent.type) ||
        (node.parent.type === "argument" &&
          field(node.parent, "name")?.id === node.id))
    )
      continue;
    // Only constant-expression names have a supported declaration-reference contract here.
    if (
      node.parent?.type.endsWith("type") ||
      node.parent?.type.includes("call") ||
      node.parent?.type.includes("class") ||
      node.parent?.type.includes("member") ||
      node.parent?.type.includes("scoped") ||
      node.parent?.type.includes("variable") ||
      node.parent?.type.includes("attribute") ||
      node.parent?.type.includes("method") ||
      node.parent?.type.includes("trait") ||
      node.parent?.type.includes("interface") ||
      node.parent?.type.includes("enum")
    )
      continue;
    result.references.push({
      ...range(node),
      scope: scope.id,
      caller: caller(node),
      owner: owner(node),
      name: node.text,
    });
  }
  return result;
}
export function validatePhpModuleRoots(roots: string[]): void {
  try {
    validatePythonModuleRoots(roots);
  } catch {
    throw new Error("Invalid selected PHP module roots");
  }
}
export function phpSelectedPath(file: string, roots: string[]): boolean {
  return (
    roots.some((root) => root === "." || file.startsWith(root + "/")) &&
    path.posix.normalize(file) === file
  );
}
