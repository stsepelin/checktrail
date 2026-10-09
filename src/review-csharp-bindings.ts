import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateCsharpModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type CsharpScope = {
  id: string;
  parent: string | null;
  kind: "file" | "class" | "function" | "lambda" | "block";
  owner: string | null;
  caller: string | null;
  unknown: boolean;
};
export type CsharpType = Range & {
  name: string | null;
  qualifiedName: string | null;
  scope: string;
  parent: string;
  unsupported: boolean;
  public: boolean;
};
export type CsharpBinding = {
  name: string;
  scope: string;
  kind: "method" | "field" | "local" | "type" | "local-function";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  static: boolean;
  final: boolean;
  visibility: "public" | "private" | "package";
  unsupported: boolean;
};
export type CsharpSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  packageName: string | null;
  scopes: CsharpScope[];
  types: CsharpType[];
  bindings: CsharpBinding[];
  imports: (Range & {
    specifier: string | null;
    kind: "namespace" | "static" | "alias";
    alias: string | null;
    unsupported: boolean;
  })[];
  calls: (Range & {
    scope: string;
    caller: string | null;
    owner: string | null;
    name: string | null;
    qualifier: string | null;
    unsupported: boolean;
  })[];
  references: (Range & {
    scope: string;
    caller: string | null;
    owner: string | null;
    declaration: string | null;
    name: string;
    qualifier: string | null;
  })[];
  omissions: string[];
};
export function csharpSourceOmissions(
  source: string,
): (
  | "unicode-escapes-unknown"
  | "global-using-unknown"
  | "conditional-source-unknown"
)[] {
  const result: (
    | "unicode-escapes-unknown"
    | "global-using-unknown"
    | "conditional-source-unknown"
  )[] = [];
  if (source.includes("\\u") || source.includes("\\U"))
    result.push("unicode-escapes-unknown");
  if (/\bglobal\s+using\b/.test(source)) result.push("global-using-unknown");
  if (/^\s*#/m.test(source)) result.push("conditional-source-unknown");
  return result;
}
const field = (node: Node, name: string) => node.childForFieldName(name),
  named = (node: Node | null) =>
    node && /^[A-Za-z_][A-Za-z_0-9]*$/.test(node.text) ? node.text : null;
function qualified(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return named(node);
  if (node.type === "qualified_name") {
    const prefix = qualified(field(node, "qualifier")),
      suffix = named(field(node, "name"));
    return prefix && suffix ? prefix + "." + suffix : null;
  }
  if (node.type === "member_access_expression") {
    const prefix = qualified(field(node, "expression")),
      suffix = named(field(node, "name"));
    return prefix && suffix ? prefix + "." + suffix : null;
  }
  return null;
}
const modifiers = (node: Node) =>
  new Set(
    node.namedChildren.filter((n) => n.type === "modifier").map((n) => n.text),
  );
const annotated = (node: Node) =>
  node.namedChildren.some((n) => n.type === "attribute_list");
const typeKinds = [
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "struct_declaration",
  "delegate_declaration",
];
/** Capture only immutable C# lexical candidates; no compilation, assembly loading or project configuration. */
export function captureCsharpBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): CsharpSyntaxUnit {
  const address = range(nodes[0]!),
    scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (typeKinds.includes(node.type))
      scopeNodes.set(node.id, "class:" + node.startIndex);
    else if (fnIds.has(node.id)) scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (
      [
        "block",
        "for_statement",
        "foreach_statement",
        "catch_clause",
        "switch_expression",
        "switch_statement",
        "using_statement",
        "query_expression",
        "anonymous_method_expression",
      ].includes(node.type)
    )
      scopeNodes.set(node.id, "scope:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) {
      const id = scopeNodes.get(p.id);
      if (!id) continue;
      if (typeKinds.includes(p.type) || fnIds.has(p.id)) {
        const body = field(p, "body");
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
  const scopes: CsharpScope[] = [
    {
      id: "file",
      parent: null,
      kind: "file",
      owner: null,
      caller: null,
      unknown: false,
    },
  ];
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (!id) continue;
    const type = typeKinds.includes(node.type),
      fn = fnIds.has(node.id),
      m = modifiers(node);
    scopes.push({
      id,
      parent: scopeFor(node),
      kind: type
        ? "class"
        : fn
          ? node.type === "lambda_expression"
            ? "lambda"
            : "function"
          : "block",
      owner: type ? id : null,
      caller: fn ? fnIds.get(node.id)! : null,
      unknown: type
        ? node.type !== "class_declaration" ||
          node.namedChildren.some((n) =>
            [
              "base_list",
              "type_parameter_list",
              "primary_constructor_base_type",
            ].includes(n.type),
          ) ||
          annotated(node) ||
          [...m].some(
            (v) =>
              !["public", "private", "internal", "static", "sealed"].includes(
                v,
              ),
          )
        : fn
          ? node.type === "lambda_expression" ||
            annotated(node) ||
            node.namedChildren.some((n) => n.type === "type_parameter_list") ||
            (node.type === "method_declaration" && !m.has("static")) ||
            [...m].some(
              (value) => !["public", "private", "static"].includes(value),
            )
          : node.type !== "block",
    });
  }
  const byScope = new Map(scopes.map((s) => [s.id, s]));
  const ancestry = (scope: string) => {
    const values: CsharpScope[] = [];
    for (
      let s = byScope.get(scope);
      s;
      s = s.parent === null ? undefined : byScope.get(s.parent)
    )
      values.push(s);
    return values;
  };
  const owner = (scope: string) =>
      ancestry(scope).find((s) => s.kind === "class")?.id ?? null,
    caller = (scope: string) =>
      ancestry(scope).find((s) => s.caller !== null)?.caller ?? null;
  const namespaces = nodes.filter((n) =>
      ["namespace_declaration", "file_scoped_namespace_declaration"].includes(
        n.type,
      ),
    ),
    packageName =
      namespaces.length === 0
        ? ""
        : namespaces.length === 1
          ? qualified(field(namespaces[0]!, "name"))
          : null;
  const result: CsharpSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    packageName,
    scopes,
    types: [],
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
  if (
    packageName === null ||
    namespaces.some(
      (ns) =>
        ns.type === "namespace_declaration" &&
        nodes.some(
          (n) => typeKinds.includes(n.type) && n.parent?.id === nodes[0]!.id,
        ),
    )
  )
    omit("file", "unsupported-namespace");
  for (const reason of csharpSourceOmissions(nodes[0]!.text))
    omit("file", reason);
  const ignored = new Set<number>();
  function add(
    node: Node | null,
    scope: string,
    kind: CsharpBinding["kind"],
    visibleFrom = 0,
    extra: Partial<CsharpBinding> = {},
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
      static: false,
      final: false,
      visibility: "private",
      unsupported: false,
      ...extra,
    });
  }
  const visibility = (m: Set<string>): CsharpBinding["visibility"] =>
    m.has("public") ? "public" : "private";
  for (const node of nodes) {
    const scope = scopeFor(node),
      m = modifiers(node);
    if (typeKinds.includes(node.type)) {
      const name = named(field(node, "name")),
        id = scopeNodes.get(node.id)!,
        parent = owner(scope),
        parentType =
          parent === null
            ? undefined
            : result.types.find((t) => t.scope === parent),
        qualifiedName =
          name === null || packageName === null
            ? null
            : parentType?.qualifiedName
              ? parentType.qualifiedName + "." + name
              : scope === "file"
                ? (packageName ? packageName + "." : "") + name
                : null;
      result.types.push({
        ...range(node),
        name,
        qualifiedName,
        scope: id,
        parent: scope,
        unsupported: byScope.get(id)!.unknown || qualifiedName === null,
        public: m.has("public"),
      });
      add(field(node, "name"), scope, "type", 0, {
        unsupported: byScope.get(id)!.unknown,
      });
      if (byScope.get(id)!.unknown) omit(id, "unsupported-type", false);
    }
    if (
      node.type === "method_declaration" ||
      node.type === "local_function_statement"
    )
      add(
        field(node, "name"),
        scope,
        node.type === "local_function_statement" ? "local-function" : "method",
        0,
        {
          functionId: fnIds.get(node.id) ?? null,
          declarationId: declarations.get(node.id)?.id ?? null,
          static: node.type === "local_function_statement" || m.has("static"),
          visibility: visibility(m),
          unsupported:
            annotated(node) ||
            node.namedChildren.some((n) => n.type === "type_parameter_list") ||
            field(node, "body") === null ||
            [...m].some((v) => !["public", "private", "static"].includes(v)),
        },
      );
    if (node.type === "constructor_declaration") {
      const name = field(node, "name");
      if (name) ignored.add(name.id);
      omit(scope, "constructor-dispatch-unknown", false);
    }
    if (node.type === "variable_declarator") {
      const parent = node.parent?.parent;
      if (parent?.type === "field_declaration") {
        const flags = modifiers(parent);
        add(field(node, "name"), scope, "field", 0, {
          declarationId: declarations.get(node.id)?.id ?? null,
          static: flags.has("static") || flags.has("const"),
          final: flags.has("const"),
          visibility: visibility(flags),
          unsupported:
            annotated(parent) ||
            [...flags].some(
              (v) =>
                !["public", "private", "const", "static", "readonly"].includes(
                  v,
                ),
            ),
        });
      } else add(field(node, "name"), scope, "local", 0);
    }
    if (node.type === "parameter") {
      let fn = node.parent;
      while (fn && !fnIds.has(fn.id)) fn = fn.parent;
      if (fn) add(field(node, "name"), scopeNodes.get(fn.id)!, "local");
    }
    if (node.type === "using_directive") {
      const alias = named(field(node, "name")),
        expression =
          node.namedChildren.find(
            (n) =>
              n.id !== field(node, "name")?.id &&
              [
                "identifier",
                "qualified_name",
                "alias_qualified_name",
                "generic_name",
              ].includes(n.type),
          ) ?? null,
        specifier = qualified(expression),
        isStatic = node.children.some((n) => n.type === "static"),
        global = node.children.some((n) => n.type === "global");
      const unsupported =
        specifier === null ||
        global ||
        (field(node, "name") !== null && alias === null);
      result.imports.push({
        ...range(node),
        specifier,
        kind: isStatic ? "static" : alias !== null ? "alias" : "namespace",
        alias,
        unsupported,
      });
      if (unsupported)
        omit("file", global ? "global-using-unknown" : "unsupported-import");
    }
    if (node.type.startsWith("preproc_"))
      omit("file", "conditional-source-unknown");
    if (
      [
        "declaration_pattern",
        "recursive_pattern",
        "var_pattern",
        "is_pattern_expression",
        "declaration_expression",
        "tuple_pattern",
        "property_declaration",
        "indexer_declaration",
        "event_declaration",
      ].includes(node.type)
    )
      omit(scope, "unsupported-pattern");
    if (node.type === "global_statement")
      omit("file", "top-level-statements-unknown");
    if (annotated(node)) omit(scope, "attributes-unknown", false);
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (
      [
        "object_creation_expression",
        "implicit_object_creation_expression",
      ].includes(node.type)
    ) {
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        owner: owner(scope),
        name: null,
        qualifier: null,
        unsupported: true,
      });
      omit(scope, "constructor-dispatch-unknown", false);
    }
    if (node.type === "invocation_expression") {
      const expression = qualified(field(node, "function")),
        parts = expression?.split(".") ?? [],
        name = parts.pop() ?? null;
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        owner: owner(scope),
        name,
        qualifier: parts.length ? parts.join(".") : null,
        unsupported: expression === null,
      });
    }
    if (
      !["identifier", "member_access_expression"].includes(node.type) ||
      ignored.has(node.id) ||
      node.parent?.type === "member_access_expression"
    )
      continue;
    const expression = qualified(node);
    if (expression === null) continue;
    let skip = false;
    for (let p = node.parent; p; p = p.parent) {
      if (
        [
          "file_scoped_namespace_declaration",
          "using_directive",
          "type_parameter_list",
          "type_argument_list",
          "attribute_list",
          "qualified_name",
          "alias_qualified_name",
          "generic_name",
        ].includes(p.type)
      ) {
        skip = true;
        break;
      }
      if (
        (p.type === "invocation_expression" &&
          field(p, "function")?.id === node.id) ||
        (p.type === "argument" && field(p, "name")?.id === node.id)
      ) {
        skip = true;
        break;
      }
      if (
        p.type === "namespace_declaration" &&
        field(p, "name") !== null &&
        node.startIndex >= field(p, "name")!.startIndex &&
        node.endIndex <= field(p, "name")!.endIndex
      ) {
        skip = true;
        break;
      }
      if (
        (p.type === "parameter" && field(p, "type")?.id === node.id) ||
        (p.type === "variable_declaration" && field(p, "type")?.id === node.id)
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
      owner: owner(scope),
      declaration,
      name,
      qualifier: parts.length ? parts.join(".") : null,
    });
  }
  return result;
}
