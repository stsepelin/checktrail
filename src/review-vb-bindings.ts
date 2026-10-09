import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateVbModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type VbScope = {
  id: string;
  parent: string | null;
  kind: "file" | "module" | "function";
  unknown: boolean;
};
export type VbModule = {
  scope: string;
  name: string | null;
  namespace: string | null;
  qualifiedName: string | null;
  unsupported: boolean;
};
export type VbBinding = {
  name: string;
  scope: string;
  kind: "method" | "constant" | "local";
  functionId: string | null;
  declarationId: string | null;
  literal: boolean;
  access: "public" | "friend" | "private";
  unsupported: boolean;
};
export type VbSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  scopes: VbScope[];
  modules: VbModule[];
  bindings: VbBinding[];
  imports: (Range & {
    alias: string | null;
    specifier: string | null;
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
const field = (n: Node, k: string) => n.childForFieldName(k);
export const vbName = (n: Node | null): string | null =>
  n !== null &&
  /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(n.text) &&
  n.text.length <= 1024
    ? n.text.toLowerCase()
    : null;
const simple = (n: Node | null) =>
  n?.type === "identifier" && vbName(n) !== null && !n.text.includes(".")
    ? n.text.toLowerCase()
    : null;
function qualified(
  n: Node | null,
): { name: string; qualifier: string | null } | null {
  const value = simple(n);
  if (value !== null) return { name: value, qualifier: null };
  if (n?.type !== "member_access_expression") return null;
  const receiver = field(n, "object"),
    member = simple(field(n, "member")),
    path = vbName(receiver);
  return path !== null &&
    member !== null &&
    n.text.toLowerCase() === path + "." + member
    ? { name: member, qualifier: path }
    : null;
}
export function vbSourceOmissions(
  file: string,
  source: string,
): (
  "non-vb-source" | "conditional-source-unknown" | "compiler-options-unknown"
)[] {
  const out: (
    "non-vb-source" | "conditional-source-unknown" | "compiler-options-unknown"
  )[] = [];
  if (!file.endsWith(".vb")) out.push("non-vb-source");
  if (/^\s*#/m.test(source)) out.push("conditional-source-unknown");
  if (
    /^\s*Option\s+(?!(?:Explicit\s+On|Strict\s+On|Compare\s+Binary|Infer\s+Off)\s*(?:'[^\n]*)?$)/im.test(
      source,
    )
  )
    out.push("compiler-options-unknown");
  return out;
}
/** Parse fixed captured strings only. No vbc, MSBuild, source initializer or project configuration executes here. */
export function captureVbBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): VbSyntaxUnit {
  const root = nodes[0]!,
    address = range(root),
    moduleIds = new Map(
      nodes
        .filter((n) => n.type === "module_declaration")
        .map((n) => [n.id, "module:" + n.startIndex]),
    );
  const scopeFor = (n: Node): string => {
    let defaultValue = false;
    for (let p = n.parent; p; p = p.parent) {
      if (p.type === "parameter") defaultValue = true;
      if (fnIds.has(p.id) && !defaultValue) return fnIds.get(p.id)!;
      if (moduleIds.has(p.id)) return moduleIds.get(p.id)!;
    }
    return "file";
  };
  const callerFor = (n: Node): string | null => {
    for (let p = n.parent; p; p = p.parent)
      if (fnIds.has(p.id)) return fnIds.get(p.id)!;
    return null;
  };
  const scopes: VbScope[] = [
    { id: "file", parent: null, kind: "file", unknown: false },
  ];
  for (const n of nodes)
    if (moduleIds.has(n.id) || fnIds.has(n.id))
      scopes.push({
        id: moduleIds.get(n.id) ?? fnIds.get(n.id)!,
        parent: scopeFor(n),
        kind: moduleIds.has(n.id) ? "module" : "function",
        unknown: fnIds.has(n.id) && n.type !== "method_declaration",
      });
  const map = new Map(scopes.map((s) => [s.id, s]));
  const result: VbSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    scopes,
    modules: [],
    bindings: [],
    imports: [],
    calls: [],
    references: [],
    omissions: [],
  };
  const omit = (scope: string, reason: string, unknown = true) => {
    if (unknown) map.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  for (const reason of vbSourceOmissions(address.file, root.text))
    omit("file", reason);
  const ignored = new Set<number>();
  function ignore(n: Node | null) {
    if (!n) return;
    ignored.add(n.id);
    for (const child of n.namedChildren) ignore(child);
  }
  const modifiers = (n: Node) =>
    n.namedChildren
      .filter((c) => c.type === "member_modifier")
      .map((c) => c.text.toLowerCase());
  const access = (n: Node): VbBinding["access"] =>
    modifiers(n).includes("private")
      ? "private"
      : modifiers(n).includes("friend")
        ? "friend"
        : "public";
  function add(
    n: Node | null,
    scope: string,
    kind: VbBinding["kind"],
    extra: Partial<VbBinding> = {},
  ) {
    const name = simple(n);
    ignore(n);
    if (name === null) {
      omit(scope, "unsupported-binding");
      return;
    }
    result.bindings.push({
      name,
      scope,
      kind,
      functionId: null,
      declarationId: null,
      literal: false,
      access: "public",
      unsupported: false,
      ...extra,
    });
  }
  for (const n of nodes) {
    const scope = scopeFor(n);
    if (n.type === "namespace_declaration") {
      ignore(field(n, "name"));
      if (n.parent?.type !== "source_file" || vbName(field(n, "name")) === null)
        omit("file", "unsupported-namespace");
    }
    if (n.type === "module_declaration") {
      const id = moduleIds.get(n.id)!,
        name = simple(field(n, "name")),
        parent = n.parent,
        namespace =
          parent?.type === "namespace_declaration"
            ? vbName(field(parent, "name"))
            : parent?.type === "source_file"
              ? ""
              : null;
      const supported =
        name !== null &&
        namespace !== null &&
        !field(n, "attributes") &&
        modifiers(n).every((v) => ["public", "friend"].includes(v));
      result.modules.push({
        scope: id,
        name,
        namespace,
        qualifiedName:
          name !== null && namespace !== null
            ? (namespace ? namespace + "." : "") + name
            : null,
        unsupported: !supported,
      });
      ignore(field(n, "name"));
      if (!supported) omit(id, "unsupported-module");
    }
    if (n.type === "method_declaration" && fnIds.has(n.id)) {
      const id = fnIds.get(n.id)!,
        name = field(n, "name"),
        parameters = field(n, "parameters");
      const supported =
        n.parent?.type === "module_declaration" &&
        simple(name) !== null &&
        !field(n, "attributes") &&
        !field(n, "type_parameters") &&
        !n.namedChildren.some((c) =>
          ["handles_clause", "implements_member_clause"].includes(c.type),
        ) &&
        modifiers(n).every((v) => ["public", "friend", "private"].includes(v));
      add(name, scope, "method", {
        functionId: id,
        declarationId: declarations.get(n.id)?.id ?? null,
        access: access(n),
        unsupported: !supported,
      });
      if (!supported) omit(id, "unsupported-function");
      for (const param of parameters?.namedChildren ?? []) {
        const name = field(param, "name"),
          value = field(param, "default_value"),
          prefix = name
            ? param.text.slice(0, name.startIndex - param.startIndex)
            : param.text;
        const plain =
          simple(name) !== null &&
          !/\b(?:ByRef|ParamArray)\b/i.test(prefix) &&
          !field(param, "attributes") &&
          !param.namedChildren.some((c) =>
            ["array_rank_specifier", "attribute_list"].includes(c.type),
          );
        add(name, id, "local", {
          declarationId: declarations.get(param.id)?.id ?? null,
          unsupported: !plain,
        });
        for (const child of param.namedChildren)
          if (child.id !== name?.id && child.id !== value?.id) ignore(child);
        if (!plain) omit(id, "unsupported-parameters");
      }
      for (const c of n.namedChildren)
        if (
          [
            "as_clause",
            "member_modifier",
            "attribute_list",
            "type_parameter_list",
            "handles_clause",
            "implements_member_clause",
          ].includes(c.type)
        )
          ignore(c);
    }
    if (n.type === "variable_declarator") {
      const parent = n.parent!,
        top =
          parent.type === "field_declaration" &&
          parent.parent?.type === "module_declaration",
        local = parent.type === "declaration_statement",
        name = field(n, "name"),
        value = field(n, "initializer"),
        decl = declarations.get(n.id),
        literal =
          value !== null &&
          [
            "integer_literal",
            "floating_point_literal",
            "boolean_literal",
            "string_literal",
            "nothing_literal",
          ].includes(value.type),
        constant = modifiers(parent).includes("const"),
        plain =
          simple(name) !== null &&
          !n.namedChildren.some((c) =>
            [
              "array_rank_specifier",
              "argument_list",
              "object_initializer",
            ].includes(c.type),
          ) &&
          parent.namedChildren.filter((c) => c.type === "variable_declarator")
            .length === 1;
      add(name, scope, top ? "constant" : "local", {
        declarationId: decl?.id ?? null,
        literal,
        access: access(parent),
        unsupported:
          !plain || !(top || local) || (top && (!constant || !literal)),
      });
      for (const c of n.namedChildren)
        if (c.id !== name?.id && c.id !== value?.id) ignore(c);
      if (!plain || !(top || local)) omit(scope, "unsupported-binding");
      if (top && (!constant || !literal))
        omit(scope, "nonliteral-global-unknown", false);
      if (local && parent.parent?.type !== "method_declaration")
        omit(scope, "unsupported-scope");
    }
    if (n.type === "imports_statement") {
      const alias = field(n, "alias"),
        target = field(n, "namespace"),
        specifier = vbName(target);
      result.imports.push({
        ...range(n),
        alias: simple(alias),
        specifier,
        unsupported:
          n.parent?.type !== "source_file" ||
          specifier === null ||
          (alias !== null && simple(alias) === null),
      });
      if (
        n.parent?.type !== "source_file" ||
        specifier === null ||
        (alias !== null && simple(alias) === null)
      )
        omit("file", "unsupported-import");
      ignore(n);
    }
    if (
      [
        "class_declaration",
        "structure_declaration",
        "interface_declaration",
        "enum_declaration",
        "delegate_declaration",
        "type_declaration_in_type",
        "property_declaration",
        "event_declaration",
        "operator_declaration",
        "constructor_declaration",
      ].includes(n.type)
    ) {
      ignore(field(n, "name"));
      omit(scope, "type-or-member-dispatch-unknown");
    }
    if (
      [
        "lambda_expression",
        "query_expression",
        "for_statement",
        "for_each_statement",
        "while_statement",
        "do_statement",
        "using_statement",
        "with_statement",
        "try_statement",
        "catch_block",
        "finally_block",
        "select_statement",
        "synclock_statement",
        "await_expression",
        "assignment_statement",
        "assignment_expression",
        "yield_statement",
        "goto_statement",
        "on_error_statement",
        "resume_statement",
        "redim_statement",
        "erase_statement",
        "raiseevent_statement",
        "add_handler_statement",
        "remove_handler_statement",
        "attribute_list",
        "generic_invocation_expression",
        "object_creation_expression",
        "array_creation_expression",
      ].includes(n.type) ||
      (n.type === "unary_expression" && /^AddressOf\b/i.test(n.text))
    )
      omit(scope, "unsupported-scope");
    if (n.type === "option_statement") ignore(n);
    if (["invocation_expression", "array_access_expression"].includes(n.type)) {
      const callee = field(
          n,
          n.type === "invocation_expression" ? "function" : "array",
        ),
        target = qualified(callee);
      if (target !== null) ignore(callee);
      result.calls.push({
        ...range(n),
        scope,
        caller: callerFor(n),
        name: target?.name ?? null,
        qualifier: target?.qualifier ?? null,
        unsupported: target === null,
      });
      for (const arg of field(n, "arguments")?.namedChildren ?? [])
        if (arg.type === "named_argument") ignore(field(arg, "name"));
    }
    if (
      n.type === "as_clause" ||
      n.type === "comment" ||
      n.type === "preprocessor_directive"
    )
      ignore(n);
  }
  for (const binding of result.bindings)
    if (binding.functionId !== null && map.get(binding.functionId)?.unknown)
      binding.unsupported = true;
  for (const n of nodes) {
    if (
      ignored.has(n.id) ||
      !["identifier", "member_access_expression"].includes(n.type) ||
      n.parent?.type === "member_access_expression"
    )
      continue;
    const value = qualified(n);
    if (!value) continue;
    const owners = [...declarations.values()]
      .filter(
        (d) =>
          d.initializer &&
          d.initializer.start <= n.startIndex &&
          d.initializer.end >= n.endIndex,
      )
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    result.references.push({
      ...range(n),
      scope: scopeFor(n),
      caller: callerFor(n),
      declaration: owners[0]?.id ?? null,
      ...value,
    });
  }
  return result;
}
