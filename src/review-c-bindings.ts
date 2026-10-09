import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
export const validateCModuleRoots = validatePythonModuleRoots;
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type CBinding = {
  name: string;
  scope: string;
  kind: "function" | "constant" | "local" | "prototype";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  literal: boolean;
  unsupported: boolean;
};
export type CSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  scopes: {
    id: string;
    parent: string | null;
    caller: string | null;
    unknown: boolean;
  }[];
  bindings: CBinding[];
  imports: (Range & { specifier: string | null; unsupported: boolean })[];
  calls: (Range & {
    scope: string;
    caller: string | null;
    name: string | null;
    unsupported: boolean;
  })[];
  references: (Range & {
    scope: string;
    caller: string | null;
    declaration: string | null;
    name: string;
  })[];
  omissions: string[];
};
const field = (node: Node, name: string) => node.childForFieldName(name);
const ascii = (node: Node | null) =>
  node?.type === "identifier" && /^[A-Za-z_][A-Za-z_0-9]*$/.test(node.text)
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
export function cFunctionName(node: Node): string | null {
  return ascii(declaratorName(field(node, "declarator")));
}
export function cSourceOmissions(
  file: string,
  source: string,
): (
  "non-c-source" | "preprocessor-source-unknown" | "line-splicing-unknown"
)[] {
  const values: (
    "non-c-source" | "preprocessor-source-unknown" | "line-splicing-unknown"
  )[] = [];
  if (!/\.(?:c|h)$/.test(file)) values.push("non-c-source");
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
/** Fixed syntax over captured strings: no preprocessor, compiler, initializer or build execution. */
export function captureCBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): CSyntaxUnit {
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
  const scopeFor = (node: Node): string => {
    for (let p = node.parent; p; p = p.parent)
      if (scopeIds.has(p.id)) return scopeIds.get(p.id)!;
    return "file";
  };
  const callerFor = (node: Node): string | null => {
    for (let p = node.parent; p; p = p.parent)
      if (fnIds.has(p.id)) return fnIds.get(p.id)!;
    return null;
  };
  const scopes: CSyntaxUnit["scopes"] = [
    { id: "file", parent: null, caller: null, unknown: false },
  ];
  for (const node of nodes)
    if (scopeIds.has(node.id))
      scopes.push({
        id: scopeIds.get(node.id)!,
        parent: scopeFor(node),
        caller: fnIds.get(node.id) ?? callerFor(node),
        unknown:
          node.type !== "function_definition" &&
          node.type !== "compound_statement",
      });
  const map = new Map(scopes.map((s) => [s.id, s]));
  const result: CSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    scopes,
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
  for (const reason of cSourceOmissions(address.file, root.text))
    omit("file", reason);
  const ignored = new Set<number>();
  function ignore(node: Node | null) {
    if (!node) return;
    ignored.add(node.id);
    for (const child of node.namedChildren) ignore(child);
  }
  function add(
    node: Node | null,
    scope: string,
    kind: CBinding["kind"],
    extra: Partial<CBinding> = {},
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
        node.parent?.type === "translation_unit" &&
        !node.namedChildren.some((child) =>
          [
            "attribute_specifier",
            "attribute_declaration",
            "ms_declspec_modifier",
          ].includes(child.type),
        );
      add(name, scope, "function", { functionId: id, unsupported: !supported });
      if (!supported) omit(id, "unsupported-function");
      for (const child of node.namedChildren)
        if (child.id !== body?.id) ignore(child);
      if (fn) {
        const params = field(fn, "parameters");
        for (const parameter of params?.namedChildren ?? []) {
          if (parameter.type !== "parameter_declaration") {
            omit(id, "unsupported-parameters");
            continue;
          }
          const p = field(parameter, "declarator"),
            pname = declaratorName(p);
          if (pname) add(pname, id, "local", { visibleFrom: 0 });
          else if (p !== null || field(parameter, "type")?.text !== "void")
            omit(id, "unsupported-parameters");
        }
      }
    } else if (node.type === "declaration") {
      const top = node.parent?.type === "translation_unit",
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
            (c) => c.type === "type_qualifier" && c.text === "const",
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
        match = text.match(/^"([A-Za-z_0-9./-]+\.h)"$/);
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
    if (node.type === "call_expression") {
      let target = field(node, "function");
      while (
        target?.type === "parenthesized_expression" &&
        target.namedChildCount === 1
      )
        target = target.namedChildren[0]!;
      const name = ascii(target);
      ignore(target);
      result.calls.push({
        ...range(node),
        scope,
        caller,
        name,
        unsupported: name === null,
      });
    }
  }
  for (const node of nodes)
    if (!ignored.has(node.id) && ascii(node) !== null) {
      // Member labels, types, fields and goto labels are not ordinary identifier reads.
      if (
        [
          "field_expression",
          "field_declaration",
          "type_descriptor",
          "labeled_statement",
          "goto_statement",
        ].includes(node.parent?.type ?? "")
      )
        continue;
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
        name: node.text,
      });
    }
  for (const binding of result.bindings)
    if (binding.functionId !== null && map.get(binding.functionId)?.unknown)
      binding.unsupported = true;
  return result;
}
