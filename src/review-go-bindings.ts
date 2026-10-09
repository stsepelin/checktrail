import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type GoModuleRoot = string;
export type GoScope = {
  id: string;
  parent: string | null;
  functionId: string | null;
  unknown: boolean;
};
export type GoBinding = {
  name: string;
  scope: string;
  visibleFrom: number;
  kind: "function" | "other";
  functionId: string | null;
  declarationId: string | null;
};
export type GoSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  packageName: string | null;
  scopes: GoScope[];
  bindings: GoBinding[];
  imports: (Range & { specifier: string | null; alias: string | null })[];
  calls: (Range & {
    scope: string;
    caller: string | null;
    callee: string | null;
    receiver: string | null;
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
const ascii = (value: string) => /^[A-Za-z_][A-Za-z_0-9]*$/.test(value);
const field = (node: Node, name: string) => node.childForFieldName(name);
const fields = (node: Node, name: string) =>
  node.children.filter(
    (_, index) =>
      node.fieldNameForChild(index) === name && node.children[index]!.isNamed,
  );
const unparenthesized = (node: Node): Node =>
  node.type === "parenthesized_expression" && node.namedChildren.length === 1
    ? unparenthesized(node.namedChildren[0]!)
    : node;
const literal = (node: Node | null): string | null => {
  if (!node) return null;
  if (node.type === "raw_string_literal")
    return node.text.slice(1, -1).replaceAll("\r", "");
  if (node.type === "interpreted_string_literal") {
    try {
      const value: unknown = JSON.parse(node.text);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  return null;
};
/** Retain only metadata from a captured tree, never invoke a Go host or project. */
export function captureGoBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): GoSyntaxUnit {
  const address = range(nodes[0]!);
  const scopeNodes = new Map<number, string>();
  const controls = new Set([
    "block",
    "if_statement",
    "for_statement",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
    "expression_case",
    "type_case",
    "communication_case",
    "default_case",
  ]);
  for (const node of nodes) {
    if (
      ["function_declaration", "method_declaration"].includes(node.type) &&
      fnIds.has(node.id)
    )
      scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (controls.has(node.type))
      scopeNodes.set(node.id, "scope:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const id = scopeNodes.get(parent.id);
      if (!id) continue;
      if (
        ["function_declaration", "method_declaration"].includes(parent.type)
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
  const scopes: GoScope[] = [
    { id: "file", parent: null, functionId: null, unknown: false },
  ];
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (id)
      scopes.push({
        id,
        parent: scopeFor(node),
        functionId: fnIds.get(node.id) ?? null,
        unknown: false,
      });
  }
  const byScope = new Map(scopes.map((scope) => [scope.id, scope]));
  const caller = (id: string) => {
    for (
      let scope = byScope.get(id);
      scope;
      scope = scope.parent === null ? undefined : byScope.get(scope.parent)
    )
      if (scope.functionId) return scope.functionId;
    return null;
  };
  const result: GoSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    packageName: null,
    scopes,
    bindings: [],
    imports: [],
    calls: [],
    references: [],
    omissions: [],
  };
  const ignored = new Set<number>();
  const omit = (scope: string, reason: string) => {
    byScope.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  const add = (
    node: Node,
    scope: string,
    visibleFrom: number,
    kind: GoBinding["kind"],
    functionId: string | null = null,
    owner: string | null = null,
  ) => {
    ignored.add(node.id);
    if (node.text === "_") return;
    if (!ascii(node.text)) {
      omit(scope, "unsupported-binding");
      return;
    }
    result.bindings.push({
      name: node.text,
      scope,
      visibleFrom,
      kind,
      functionId,
      declarationId: owner,
    });
  };
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "package_clause") {
      const name = node.namedChildren.find(
        (child) => child.type === "package_identifier",
      );
      if (name && ascii(name.text)) result.packageName = name.text;
      else omit("file", "unsupported-binding");
    }
    if (["function_declaration", "method_declaration"].includes(node.type)) {
      const id = scopeNodes.get(node.id)!;
      const name = field(node, "name");
      if (node.type === "function_declaration" && name && name.text !== "init")
        add(
          name,
          "file",
          0,
          field(node, "type_parameters") ? "other" : "function",
          field(node, "type_parameters") ? null : (fnIds.get(node.id) ?? null),
          declarations.get(node.id)?.id ?? null,
        );
      if (name) ignored.add(name.id);
      for (const list of [
        field(node, "receiver"),
        field(node, "parameters"),
        field(node, "result"),
      ]) {
        if (list?.type !== "parameter_list") continue;
        for (const parameter of list.namedChildren)
          for (const parameterName of fields(parameter, "name"))
            add(
              parameterName,
              id,
              0,
              "other",
              null,
              declarations.get(parameter.id)?.id ?? null,
            );
      }
    }
    if (
      ["var_spec", "const_spec", "type_spec", "type_alias"].includes(node.type)
    ) {
      for (const name of fields(node, "name"))
        add(
          name,
          scope,
          scope === "file" ? 0 : node.endIndex,
          "other",
          null,
          declarations.get(node.id)?.id ?? null,
        );
    }
    if (node.type === "short_var_declaration") {
      const left = field(node, "left");
      for (const name of left?.namedChildren ?? []) {
        if (name.type === "identifier")
          add(
            name,
            scope,
            node.endIndex,
            "other",
            null,
            declarations.get(node.id)?.id ?? null,
          );
        else omit(scope, "unsupported-binding");
      }
    }
    if (
      ["range_clause", "type_switch_statement", "receive_statement"].includes(
        node.type,
      )
    )
      omit(scope, "unsupported-scope-mutation");
    if (node.type === "assignment_statement") {
      // Do not infer assignment targets through member/index expressions.
      for (const name of field(node, "left")?.namedChildren ?? [])
        if (name.type === "identifier")
          add(name, scope, node.endIndex, "other");
    }
    if (node.type === "import_spec") {
      const name = field(node, "name");
      const specifier = literal(field(node, "path"));
      result.imports.push({
        ...range(node),
        specifier,
        alias: name?.text ?? null,
      });
      if (name) ignored.add(name.id);
      if (name?.type === "dot") omit("file", "unsupported-import");
      if (
        specifier === null ||
        (name &&
          !["dot", "blank_identifier"].includes(name.type) &&
          !ascii(name.text))
      )
        omit("file", "unsupported-import");
    }
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    let unsupported = false;
    for (let parent = node.parent; parent; parent = parent.parent)
      if (
        parent.type === "func_literal" ||
        (parent.type === "function_declaration" &&
          field(parent, "type_parameters"))
      ) {
        unsupported = true;
        break;
      }
    if (node.type === "call_expression") {
      const original = field(node, "function"),
        fn = original ? unparenthesized(original) : null;
      let callee: string | null = null,
        receiver: string | null = null;
      if (fn?.type === "identifier" && ascii(fn.text)) callee = fn.text;
      else if (fn?.type === "selector_expression") {
        const member = field(fn, "field"),
          operand = field(fn, "operand");
        const object = operand ? unparenthesized(operand) : null;
        if (
          member &&
          ascii(member.text) &&
          object?.type === "identifier" &&
          ascii(object.text)
        ) {
          callee = member.text;
          receiver = object.text;
        }
      }
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        callee,
        receiver,
        unsupported: unsupported || field(node, "type_arguments") !== null,
      });
    }
    if (
      node.type !== "identifier" ||
      ignored.has(node.id) ||
      !ascii(node.text) ||
      unsupported
    )
      continue;
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
      name: node.text,
    });
  }
  return result;
}
export function validateGoModuleRoots(roots: GoModuleRoot[]): void {
  try {
    validatePythonModuleRoots(roots);
  } catch {
    throw new Error("Invalid selected Go module roots");
  }
}
