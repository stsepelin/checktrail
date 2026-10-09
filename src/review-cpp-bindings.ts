import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
export const validateCppModuleRoots = validatePythonModuleRoots;
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type CppBinding = {
  name: string;
  scope: string;
  kind: "function" | "constant" | "local" | "prototype";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  literal: boolean;
  unsupported: boolean;
};
export type CppSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  scopes: {
    id: string;
    parent: string | null;
    caller: string | null;
    unknown: boolean;
  }[];
  bindings: CppBinding[];
  aliases: {
    name: string;
    target: string | null;
    scope: string;
    visibleFrom: number;
    unsupported: boolean;
  }[];
  imports: (Range & { specifier: string | null; unsupported: boolean })[];
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
const ascii = (node: Node | null) =>
  node?.type === "identifier" &&
  node.text.length <= 256 &&
  /^[A-Za-z_][A-Za-z_0-9]*$/.test(node.text)
    ? node.text
    : null;
/** Follow declarators, never parameter lists, expression operands or arbitrary identifier descendants. */
function declaratorName(node: Node | null): Node | null {
  if (!node) return null;
  if (node.type === "identifier") return node;
  if (
    ![
      "init_declarator",
      "function_declarator",
      "pointer_declarator",
      "parenthesized_declarator",
      "array_declarator",
    ].includes(node.type)
  )
    return null;
  return declaratorName(
    field(node, "declarator") ??
      (node.type === "parenthesized_declarator"
        ? (node.namedChildren[0] ?? null)
        : null),
  );
}
function functionDeclarator(node: Node | null): Node | null {
  if (!node) return null;
  if (
    node.type === "function_declarator" &&
    ascii(field(node, "declarator")) !== null
  )
    return node;
  if (
    ![
      "function_declarator",
      "pointer_declarator",
      "parenthesized_declarator",
    ].includes(node.type)
  )
    return null;
  return functionDeclarator(
    field(node, "declarator") ??
      (node.type === "parenthesized_declarator"
        ? (node.namedChildren[0] ?? null)
        : null),
  );
}
export function cppFunctionName(node: Node): string | null {
  return ascii(declaratorName(field(node, "declarator")));
}
function namespaceName(node: Node): string | null {
  const name = field(node, "name");
  return name?.type === "namespace_identifier" &&
    /^[A-Za-z_][A-Za-z_0-9]*$/.test(name.text) &&
    node.parent?.type === "translation_unit" &&
    !node.children.some((child) => child.text === "inline")
    ? name.text
    : null;
}
function qualified(
  node: Node | null,
): { name: string; qualifier: string | null } | null {
  const name = ascii(node);
  if (name !== null) return { name, qualifier: null };
  if (node?.type !== "qualified_identifier") return null;
  const member = ascii(field(node, "name")),
    scope = field(node, "scope");
  if (member === null) return null;
  if (scope === null && node.text === "::" + member)
    return { name: member, qualifier: "" };
  if (
    scope?.type !== "namespace_identifier" ||
    !/^[A-Za-z_][A-Za-z_0-9]*$/.test(scope.text)
  )
    return null;
  return node.text === scope.text + "::" + member
    ? { name: member, qualifier: scope.text }
    : null;
}
export function cppSourceOmissions(
  file: string,
  source: string,
): (
  "non-cpp-source" | "preprocessor-source-unknown" | "line-splicing-unknown"
)[] {
  const values: (
    "non-cpp-source" | "preprocessor-source-unknown" | "line-splicing-unknown"
  )[] = [];
  if (!/\.(?:cc|cpp|cxx|h|hpp|hh|hxx)$/.test(file))
    values.push("non-cpp-source");
  const preprocessing = source.replace(
    /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g,
    (token) => (token.startsWith("/") ? token.replace(/[^\r\n]/g, " ") : token),
  );
  // Digraph/trigraph directives and continued lines may change lexical spelling before parsing.
  if (
    /^\s*(?:#|%:|\?\?=)(?!\s*include\s+"[A-Za-z_0-9./-]+"\s*(?:\/\/[^\n]*)?$)/m.test(
      preprocessing,
    )
  )
    values.push("preprocessor-source-unknown");
  if (/\\\r?\n|\?\?\//.test(source)) values.push("line-splicing-unknown");
  return values;
}
/** Fixed C++ syntax over captured strings: no preprocessor, compiler, initializer or build execution. */
export function captureCppBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): CppSyntaxUnit {
  const root = nodes[0]!,
    address = range(root),
    scopeIds = new Map<number, string>();
  for (const node of nodes)
    if (fnIds.has(node.id)) scopeIds.set(node.id, fnIds.get(node.id)!);
  for (const node of nodes)
    if (
      node.type === "compound_statement" &&
      node.parent?.type !== "function_definition"
    )
      scopeIds.set(node.id, "block:" + node.startIndex);
  const defaultExpressions = new Map<number, Node>(),
    defaultScopes = new Map<number, string>();
  for (const node of nodes)
    if (node.type === "namespace_definition" && namespaceName(node) !== null)
      scopeIds.set(node.id, "namespace:" + namespaceName(node));
  for (const node of nodes)
    if (node.type === "optional_parameter_declaration") {
      const value = field(node, "default_value");
      if (value) {
        defaultExpressions.set(value.id, value);
        defaultScopes.set(node.id, "default:" + node.startIndex);
      }
    }
  const scopeFor = (node: Node): string => {
    for (let p = node.parent; p; p = p.parent) {
      const value =
        p.type === "optional_parameter_declaration"
          ? field(p, "default_value")
          : null;
      if (
        value &&
        node.startIndex >= value.startIndex &&
        node.endIndex <= value.endIndex
      )
        return defaultScopes.get(p.id)!;
      if (scopeIds.has(p.id)) return scopeIds.get(p.id)!;
    }
    return "file";
  };
  const callerFor = (node: Node): string | null => {
    for (let p = node.parent; p; p = p.parent)
      if (fnIds.has(p.id)) return fnIds.get(p.id)!;
    return null;
  };
  const scopes: CppSyntaxUnit["scopes"] = [
    { id: "file", parent: null, caller: null, unknown: false },
  ];
  for (const node of nodes)
    if (
      scopeIds.has(node.id) &&
      !scopes.some((s) => s.id === scopeIds.get(node.id))
    )
      scopes.push({
        id: scopeIds.get(node.id)!,
        parent: scopeFor(node),
        caller: fnIds.get(node.id) ?? callerFor(node),
        unknown:
          node.type !== "function_definition" &&
          node.type !== "compound_statement" &&
          node.type !== "namespace_definition",
      });
  for (const node of nodes)
    if (defaultScopes.has(node.id)) {
      let owner: Node | null = node.parent;
      while (owner && !fnIds.has(owner.id)) owner = owner.parent;
      scopes.push({
        id: defaultScopes.get(node.id)!,
        parent: owner ? scopeFor(owner) : "file",
        caller: owner ? fnIds.get(owner.id)! : null,
        unknown: owner === null,
      });
    }
  const map = new Map(scopes.map((s) => [s.id, s]));
  const result: CppSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    scopes,
    bindings: [],
    aliases: [],
    imports: [],
    calls: [],
    references: [],
    omissions: [],
  };
  const omit = (scope: string, reason: string, unknown = true) => {
    if (unknown) map.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  for (const reason of cppSourceOmissions(address.file, root.text))
    omit("file", reason);
  const ignored = new Set<number>();
  function ignore(node: Node | null) {
    if (!node || defaultExpressions.has(node.id)) return;
    ignored.add(node.id);
    for (const child of node.namedChildren) ignore(child);
  }
  function add(
    node: Node | null,
    scope: string,
    kind: CppBinding["kind"],
    extra: Partial<CppBinding> = {},
  ) {
    const name = ascii(node);
    ignore(node);
    if (name === null) {
      omit(scope, "unsupported-binding");
      return;
    }
    result.bindings.push({
      name,
      scope,
      kind,
      visibleFrom: node!.endIndex,
      functionId: null,
      declarationId: null,
      literal: false,
      unsupported: false,
      ...extra,
    });
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "function_definition" && fnIds.has(node.id)) {
      const id = fnIds.get(node.id)!,
        dec = field(node, "declarator"),
        fn = functionDeclarator(dec),
        name = declaratorName(dec),
        body = field(node, "body"),
        type = field(node, "type");
      const supported =
        fn !== null &&
        ascii(name) !== null &&
        body?.type === "compound_statement" &&
        type?.type === "primitive_type" &&
        (node.parent?.type === "translation_unit" ||
          (node.parent?.type === "declaration_list" &&
            node.parent.parent?.type === "namespace_definition" &&
            namespaceName(node.parent.parent) !== null)) &&
        !node.namedChildren.some((child) =>
          [
            "attribute_specifier",
            "attribute_declaration",
            "ms_declspec_modifier",
          ].includes(child.type),
        );
      add(name, scope, "function", {
        visibleFrom: dec?.endIndex ?? node.endIndex,
        functionId: id,
        unsupported: !supported,
      });
      if (!supported) omit(id, "unsupported-function");
      for (const child of node.namedChildren)
        if (child.id !== body?.id) ignore(child);
      if (fn) {
        const params = field(fn, "parameters");
        for (const parameter of params?.namedChildren ?? []) {
          if (
            ![
              "parameter_declaration",
              "optional_parameter_declaration",
            ].includes(parameter.type)
          ) {
            omit(id, "unsupported-parameters");
            continue;
          }
          const p = field(parameter, "declarator"),
            pname = declaratorName(p);
          if (pname) {
            add(pname, id, "local", { visibleFrom: 0 });
            for (const later of params?.namedChildren ?? [])
              if (
                later.startIndex > parameter.startIndex &&
                defaultScopes.has(later.id)
              )
                add(pname, defaultScopes.get(later.id)!, "local", {
                  visibleFrom: 0,
                });
          } else if (p !== null || field(parameter, "type")?.text !== "void")
            omit(id, "unsupported-parameters");
        }
      }
    } else if (node.type === "declaration") {
      const top = scope === "file" || scope.startsWith("namespace:"),
        type = field(node, "type");
      if (
        type?.type !== "primitive_type" ||
        node.namedChildren.some((c) =>
          [
            "attribute_specifier",
            "attribute_declaration",
            "ms_declspec_modifier",
          ].includes(c.type),
        )
      )
        omit(scope, "unsupported-binding");
      for (const child of node.namedChildren) {
        if (
          [
            "primitive_type",
            "type_qualifier",
            "storage_class_specifier",
          ].includes(child.type)
        ) {
          ignore(child);
          continue;
        }
        if (child.type === "function_declarator") {
          add(declaratorName(child), scope, "prototype", { unsupported: true });
          ignore(child);
          omit(scope, "prototype-linkage-unknown", false);
          continue;
        }
        const dec =
            child.type === "init_declarator"
              ? field(child, "declarator")
              : child,
          name = declaratorName(dec),
          value =
            child.type === "init_declarator" ? field(child, "value") : null;
        const literal =
          value !== null &&
          [
            "number_literal",
            "char_literal",
            "string_literal",
            "true",
            "false",
          ].includes(value.type);
        const constant =
          top &&
          node.namedChildren.some(
            (c) =>
              c.type === "type_qualifier" &&
              ["const", "constexpr"].includes(c.text),
          ) &&
          dec?.type === "identifier";
        add(name, scope, constant ? "constant" : "local", {
          literal: constant && literal,
          visibleFrom: dec?.endIndex ?? node.endIndex,
          declarationId: declarations.get(child.id)?.id ?? null,
        });
        // A declarator is a declaration, while its initializer may contain real reads/calls.
        ignore(dec);
        if (constant && !literal)
          omit(scope, "nonliteral-global-unknown", false);
      }
    } else if (node.type === "namespace_definition") {
      if (namespaceName(node) === null) omit(scope, "unsupported-namespace");
      ignore(field(node, "name"));
    } else if (node.type === "namespace_alias_definition") {
      const name = field(node, "name"),
        target = node.namedChildren.find((child) => child.id !== name?.id),
        plain = (n: Node | null | undefined) =>
          n?.type === "namespace_identifier" &&
          /^[A-Za-z_][A-Za-z_0-9]*$/.test(n.text)
            ? n.text
            : null;
      const alias = plain(name),
        destination = plain(target),
        supported = alias !== null && destination !== null && scope === "file";
      if (alias)
        result.aliases.push({
          name: alias,
          target: destination,
          scope,
          visibleFrom: node.endIndex,
          unsupported: !supported,
        });
      ignore(node);
      if (!supported) omit(scope, "unsupported-namespace-alias");
    } else if (
      [
        "class_specifier",
        "template_declaration",
        "using_declaration",
        "alias_declaration",
        "linkage_specification",
        "lambda_expression",
        "concept_definition",
        "requires_expression",
        "coroutine_return_statement",
      ].includes(node.type)
    ) {
      omit(scope, "unsupported-scope");
    } else if (node.type === "array_declarator") {
      omit(scope, "unsupported-scope");
      ignore(node);
    } else if (
      node.type === "sizeof_expression" ||
      (node.type === "pointer_expression" &&
        node.children.some((child) => child.text === "&"))
    ) {
      ignore(node);
    } else if (node.type === "preproc_include") {
      const p = field(node, "path"),
        text = p?.text ?? "",
        match = text.match(/^"([A-Za-z_0-9./-]+\.(?:h|hpp|hh|hxx))"$/);
      const supported =
        match !== null && node.parent?.type === "translation_unit";
      result.imports.push({
        ...range(node),
        specifier: match?.[1] ?? null,
        unsupported: !supported,
      });
      ignore(node);
      if (!supported) omit("file", "unsupported-import");
    } else if (node.type.startsWith("preproc_")) {
      omit("file", "preprocessor-source-unknown");
      ignore(node);
    } else if (
      [
        "type_definition",
        "enum_specifier",
        "struct_specifier",
        "union_specifier",
        "for_statement",
        "while_statement",
        "do_statement",
        "goto_statement",
        "labeled_statement",
        "case_statement",
        "attribute_specifier",
        "attribute_declaration",
        "asm_statement",
        "generic_expression",
        "compound_literal_expression",
      ].includes(node.type)
    ) {
      omit(scope, "unsupported-scope");
      if (
        [
          "type_definition",
          "enum_specifier",
          "struct_specifier",
          "union_specifier",
        ].includes(node.type)
      )
        ignore(node);
    }
  }
  for (const node of nodes) {
    const scope = scopeFor(node),
      caller = callerFor(node);
    if (["call_expression", "new_expression"].includes(node.type)) {
      let target = field(node, "function");
      while (
        target?.type === "parenthesized_expression" &&
        target.namedChildCount === 1
      )
        target = target.namedChildren[0]!;
      const symbol = node.type === "new_expression" ? null : qualified(target);
      ignore(target);
      result.calls.push({
        ...range(node),
        scope,
        caller,
        name: symbol?.name ?? null,
        qualifier: symbol?.qualifier ?? null,
        unsupported: symbol === null,
      });
    }
  }
  for (const node of nodes)
    if (
      !ignored.has(node.id) &&
      node.type === "identifier" &&
      node.text.length > 256
    )
      omit(scopeFor(node), "unsupported-binding");
  for (const node of nodes)
    if (
      !ignored.has(node.id) &&
      (ascii(node) !== null || node.type === "qualified_identifier")
    ) {
      if (
        [
          "field_expression",
          "field_declaration",
          "type_descriptor",
          "labeled_statement",
          "goto_statement",
          "qualified_identifier",
        ].includes(node.parent?.type ?? "")
      )
        continue;
      const symbol = qualified(node);
      if (!symbol) continue;
      const address = range(node),
        owners = [...declarations.values()]
          .filter(
            (d) =>
              d.initializer &&
              d.initializer.start <= address.start &&
              d.initializer.end >= address.end,
          )
          .sort((a, b) => a.end - a.start - (b.end - b.start));
      result.references.push({
        ...address,
        scope: scopeFor(node),
        caller: callerFor(node),
        declaration: owners[0]?.id ?? null,
        name: symbol.name,
        qualifier: symbol.qualifier,
      });
    }
  for (const binding of result.bindings)
    if (binding.functionId !== null && map.get(binding.functionId)?.unknown)
      binding.unsupported = true;
  return result;
}
