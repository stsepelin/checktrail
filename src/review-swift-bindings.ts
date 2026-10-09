import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
export type SwiftModuleRoot = { directory: string; module: string };
export function validateSwiftModuleRoots(roots: SwiftModuleRoot[]): void {
  validatePythonModuleRoots(roots.map((root) => root.directory));
  if (
    roots.some(
      (root) =>
        !/^[A-Za-z_][A-Za-z_0-9]*$/.test(root.module) ||
        root.module.length > 256 ||
        ["Swift", "Self", "self", "true", "false", "nil"].includes(root.module),
    ) ||
    new Set(roots.map((root) => root.module)).size !== roots.length
  )
    throw Error(
      "Swift module labels must be unique plain declared identifiers",
    );
}
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type SwiftScope = {
  id: string;
  parent: string | null;
  caller: string | null;
  unknown: boolean;
};
export type SwiftBinding = {
  name: string;
  scope: string;
  kind: "function" | "constant" | "local";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  literal: boolean;
  access: "public" | "internal" | "file";
  unsupported: boolean;
};
export type SwiftSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  scopes: SwiftScope[];
  bindings: SwiftBinding[];
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
  node?.type === "simple_identifier" &&
  /^[A-Za-z_][A-Za-z_0-9]*$/.test(node.text)
    ? node.text
    : null;
const within = (node: Node, body: Node | null) =>
  body !== null &&
  node.startIndex >= body.startIndex &&
  node.endIndex <= body.endIndex;
function qualified(
  node: Node | null,
): { name: string; qualifier: string | null } | null {
  const name = ascii(node);
  if (name !== null) return { name, qualifier: null };
  if (node?.type !== "navigation_expression") return null;
  const receiver = ascii(field(node, "target")),
    member = ascii(field(node, "suffix")?.namedChildren[0] ?? null);
  return receiver !== null &&
    member !== null &&
    node.text === receiver + "." + member
    ? { name: member, qualifier: receiver }
    : null;
}
export function swiftSourceOmissions(
  file: string,
  source: string,
): (
  "non-swift-source" | "manifest-source-unknown" | "conditional-source-unknown"
)[] {
  const values: (
    | "non-swift-source"
    | "manifest-source-unknown"
    | "conditional-source-unknown"
  )[] = [];
  if (!file.endsWith(".swift")) values.push("non-swift-source");
  if (file.split("/").at(-1) === "Package.swift")
    values.push("manifest-source-unknown");
  if (/^\s*#(?:if|elseif|else|endif|sourceLocation)\b/m.test(source))
    values.push("conditional-source-unknown");
  return values;
}
/** Captured strings and fixed AST only; no compiler, manifest, initializer or module loading. */
export function captureSwiftBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): SwiftSyntaxUnit {
  const root = nodes[0]!,
    address = range(root);
  // Default expressions are outside the function body and use its enclosing scope.
  const scopeFor = (node: Node): string => {
    for (let p = node.parent; p; p = p.parent)
      if (fnIds.has(p.id) && within(node, field(p, "body")))
        return fnIds.get(p.id)!;
    return "file";
  };
  const callerFor = (node: Node): string | null => {
    for (let p = node.parent; p; p = p.parent)
      if (fnIds.has(p.id)) return fnIds.get(p.id)!;
    return null;
  };
  const scopes: SwiftScope[] = [
    { id: "file", parent: null, caller: null, unknown: false },
  ];
  for (const node of nodes)
    if (fnIds.has(node.id))
      scopes.push({
        id: fnIds.get(node.id)!,
        parent: scopeFor(node),
        caller: fnIds.get(node.id)!,
        unknown: node.type !== "function_declaration",
      });
  const byScope = new Map(scopes.map((scope) => [scope.id, scope]));
  const result: SwiftSyntaxUnit = {
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
    if (unknown) byScope.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  for (const reason of swiftSourceOmissions(address.file, root.text))
    omit("file", reason);
  const ignored = new Set<number>();
  function ignore(node: Node | null) {
    if (!node) return;
    ignored.add(node.id);
    for (const child of node.namedChildren) ignore(child);
  }
  const access = (node: Node): SwiftBinding["access"] => {
    const value =
      node.namedChildren.find((child) => child.type === "modifiers")?.text ??
      "";
    return /\b(?:private|fileprivate)\b/.test(value)
      ? "file"
      : /\bpublic\b/.test(value)
        ? "public"
        : "internal";
  };
  function add(
    node: Node | null,
    scope: string,
    kind: SwiftBinding["kind"],
    visibleFrom: number,
    extra: Partial<SwiftBinding> = {},
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
      visibleFrom,
      functionId: null,
      declarationId: null,
      literal: false,
      access: "internal",
      unsupported: false,
      ...extra,
    });
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "function_declaration" && fnIds.has(node.id)) {
      const id = fnIds.get(node.id)!,
        name = field(node, "name"),
        body = field(node, "body"),
        header = node.text.slice(
          0,
          body ? body.startIndex - node.startIndex : node.text.length,
        ),
        modifiers = node.namedChildren.find(
          (child) => child.type === "modifiers",
        );
      const supported =
        ascii(name) !== null &&
        body !== null &&
        !/[<@]|\b(?:async|throws|rethrows|where|some|isolated|nonisolated)\b/.test(
          header,
        ) &&
        (!modifiers ||
          /^(?:(?:public|private|fileprivate|internal)\s*)+$/.test(
            modifiers.text,
          )) &&
        (node.parent?.type === "source_file" ||
          node.parent?.type === "statements");
      add(name, scope, "function", 0, {
        functionId: id,
        declarationId: declarations.get(node.id)?.id ?? null,
        access: access(node),
        unsupported: !supported,
      });
      if (!supported) omit(id, "unsupported-function");
      for (const child of node.namedChildren) {
        if (child.type === "parameter") {
          const param = field(child, "name"),
            external = field(child, "external_name");
          ignore(external);
          ignore(
            child.namedChildren.find(
              (value) => value.type !== "simple_identifier",
            ) ?? null,
          );
          if (
            ascii(param) === null ||
            /\b(?:inout|borrowing|consuming|isolated|sending)\b|\.\.\./.test(
              child.text,
            )
          ) {
            ignore(child);
            omit(id, "unsupported-parameters");
          } else
            add(param, id, "local", 0, {
              declarationId: declarations.get(child.id)?.id ?? null,
            });
        } else if (
          !["function_body", "simple_identifier", "parameter"].includes(
            child.type,
          ) &&
          child.id !== field(node, "default_value")?.id
        )
          ignore(child);
      }
      ignore(name);
    }
    if (node.type === "property_declaration") {
      const pattern = field(node, "name"),
        name =
          pattern?.type === "pattern"
            ? field(pattern, "bound_identifier")
            : null,
        value = field(node, "value"),
        mutability = node.namedChildren.find(
          (child) => child.type === "value_binding_pattern",
        )?.text,
        decl = declarations.get(node.id),
        plain = ascii(name) !== null && pattern?.namedChildren.length === 1;
      const top = node.parent?.type === "source_file";
      const literal =
        value !== null &&
        (["integer_literal", "real_literal", "boolean_literal", "nil"].includes(
          value.type,
        ) ||
          (value.type === "line_string_literal" &&
            value.namedChildren.every(
              (child) => child.type === "line_str_text",
            )));
      if (!plain) {
        ignore(pattern ?? null);
        omit(scope, "unsupported-binding");
      } else
        add(name, scope, top ? "constant" : "local", top ? 0 : node.endIndex, {
          declarationId: decl?.id ?? null,
          access: access(node),
          literal,
          unsupported:
            mutability !== "let" ||
            (!top && node.parent?.type !== "statements") ||
            (top && !literal),
        });
      for (const child of node.namedChildren)
        if (child.id !== pattern?.id && child.id !== value?.id) ignore(child);
      if (top && (mutability !== "let" || !value || !literal))
        omit("file", "nonliteral-global-unknown", false);
    }
    if (
      node.type === "value_binding_pattern" &&
      node.parent?.type !== "property_declaration"
    )
      omit(scope, "unsupported-binding");
    if (node.type === "import_declaration") {
      const specifier =
        node.text.match(/^import\s+([A-Za-z_][A-Za-z_0-9]*)$/)?.[1] ?? null;
      result.imports.push({
        ...range(node),
        specifier,
        unsupported: node.parent?.type !== "source_file" || specifier === null,
      });
      ignore(node);
      if (specifier === null) omit("file", "unsupported-import");
    }
    if (
      [
        "class_declaration",
        "protocol_declaration",
        "extension_declaration",
        "enum_declaration",
        "typealias_declaration",
        "init_declaration",
        "deinit_declaration",
      ].includes(node.type)
    ) {
      ignore(field(node, "name"));
      omit(scope, "type-or-member-dispatch-unknown");
    }
    if (
      [
        "lambda_literal",
        "for_statement",
        "while_statement",
        "repeat_while_statement",
        "switch_statement",
        "do_statement",
        "catch_block",
        "guard_statement",
        "defer_statement",
        "try_expression",
        "await_expression",
        "macro_invocation",
        "attribute",
        "directly_assignable_expression",
        "assignment",
      ].includes(node.type)
    )
      omit(scope, "unsupported-scope");
    if (
      node.type === "function_declaration" ||
      node.type === "property_declaration"
    ) {
      for (
        let p = node.parent;
        p && p.type !== "function_body" && p.type !== "source_file";
        p = p.parent
      )
        if (
          [
            "if_statement",
            "else",
            "switch_statement",
            "lambda_literal",
          ].includes(p.type)
        )
          omit(scope, "unsupported-scope");
    }
    if (node.type === "call_expression") {
      const callee = node.namedChildren[0] ?? null,
        target = qualified(callee);
      if (target !== null) ignore(callee);
      result.calls.push({
        ...range(node),
        scope,
        caller: callerFor(node),
        name: target?.name ?? null,
        qualifier: target?.qualifier ?? null,
        unsupported: target === null,
      });
      // Ignore labels, retain argument values and their nested calls/reads.
      for (const argument of node.namedChildren
        .find((child) => child.type === "call_suffix")
        ?.namedChildren.find((child) => child.type === "value_arguments")
        ?.namedChildren ?? []) {
        const value = field(argument, "value");
        for (const child of argument.namedChildren)
          if (child.id !== value?.id) ignore(child);
      }
    }
  }
  for (const binding of result.bindings)
    if (binding.functionId !== null && byScope.get(binding.functionId)?.unknown)
      binding.unsupported = true;
  for (const node of nodes) {
    if (
      ignored.has(node.id) ||
      !["simple_identifier", "navigation_expression"].includes(node.type)
    )
      continue;
    if (
      node.parent?.type === "navigation_expression" ||
      node.parent?.type === "navigation_suffix"
    )
      continue;
    const value = qualified(node);
    if (!value) continue;
    const owners = [...declarations.values()]
      .filter(
        (decl) =>
          decl.initializer &&
          decl.initializer.start <= node.startIndex &&
          decl.initializer.end >= node.endIndex,
      )
      .sort((a, b) => a.end - a.start - (b.end - b.start));
    result.references.push({
      ...range(node),
      scope: scopeFor(node),
      caller: callerFor(node),
      declaration: owners[0]?.id ?? null,
      ...value,
    });
  }
  return result;
}
