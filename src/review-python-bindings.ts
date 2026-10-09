import path from "node:path";
import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type Binding = {
  name: string;
  scope: string;
  kind: "function" | "other" | "module" | "import";
  functionId: string | null;
  declarationId: string | null;
  module: string | null;
  imported: string | null;
  receiver: string | null;
};
export type Scope = {
  id: string;
  parent: string | null;
  kind: "module" | "class" | "function";
  unknown: boolean;
};
type Import = Range & { specifier: string | null };
export type PythonSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  scopes: Scope[];
  bindings: Binding[];
  imports: Import[];
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
const moduleName = (value: string) =>
  /^(?:\.*[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*|\.+)$/.test(
    value,
  );
const field = (node: Node, key: string) => node.childForFieldName(key);
const within = (node: Node, body: Node | null) =>
  body !== null &&
  body.startIndex <= node.startIndex &&
  body.endIndex >= node.endIndex;
const unparenthesized = (node: Node): Node =>
  node.type === "parenthesized_expression" && node.namedChildren.length === 1
    ? unparenthesized(node.namedChildren[0]!)
    : node;
const qualified = (node: Node): string | null => {
  const current = unparenthesized(node);
  if (current.type === "identifier")
    return ascii(current.text) ? current.text : null;
  if (current.type === "attribute") {
    const object = field(current, "object"),
      member = field(current, "attribute");
    const prefix = object ? qualified(object) : null;
    return prefix && member && ascii(member.text)
      ? prefix + "." + member.text
      : null;
  }
  return null;
};
const literalModule = (node: Node): string | null => {
  if (node.type === "dotted_name") {
    const parts = node.namedChildren.filter(
      (child) => child.type === "identifier",
    );
    return parts.length && parts.every((part) => ascii(part.text))
      ? parts.map((part) => part.text).join(".")
      : null;
  }
  if (node.type === "relative_import") {
    const prefix = node.namedChildren.find(
      (child) => child.type === "import_prefix",
    );
    const dots =
      prefix?.children.filter((child) => child.text === ".").length ?? 0;
    const named = node.namedChildren.find(
      (child) => child.type === "dotted_name",
    );
    const value = named ? literalModule(named) : "";
    return dots && value !== null ? ".".repeat(dots) + value : null;
  }
  return node.type === "identifier" && ascii(node.text) ? node.text : null;
};
/** Extract only captured AST metadata while its native tree is alive. */
export function capturePythonBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): PythonSyntaxUnit {
  const root = nodes[0]!;
  const address = range(root);
  const scopes: Scope[] = [
    { id: "module", parent: null, kind: "module", unknown: false },
  ];
  const scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (node.type === "function_definition" && fnIds.has(node.id))
      scopeNodes.set(node.id, fnIds.get(node.id)!);
    if (node.type === "class_definition")
      scopeNodes.set(node.id, "class:" + node.startIndex);
  }
  const scopeFor = (node: Node): string => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const scope = scopeNodes.get(parent.id);
      if (scope && within(node, field(parent, "body"))) return scope;
    }
    return "module";
  };
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (id)
      scopes.push({
        id,
        parent: scopeFor(node),
        kind: node.type === "class_definition" ? "class" : "function",
        unknown: false,
      });
  }
  const byScope = new Map(scopes.map((scope) => [scope.id, scope]));
  const caller = (scope: string) => {
    for (
      let next: Scope | undefined = byScope.get(scope);
      next;
      next = next.parent === null ? undefined : byScope.get(next.parent)
    )
      if (next.kind === "function") return next.id;
    return null;
  };
  const result: PythonSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    scopes,
    bindings: [],
    imports: [],
    calls: [],
    references: [],
    omissions: [],
  };
  const omit = (scope: string, reason: string) => {
    byScope.get(scope)!.unknown = true;
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  const ignored = new Set<number>();
  const descendants = (node: Node) => {
    const all: Node[] = [],
      stack = [node];
    while (stack.length) {
      const next = stack.pop()!;
      all.push(next);
      stack.push(...next.namedChildren);
    }
    return all;
  };
  const add = (
    node: Node,
    scope: string,
    kind: Binding["kind"],
    extra: Partial<Binding> = {},
  ) => {
    if (!ascii(node.text)) {
      omit(scope, "unsupported-binding");
      return;
    }
    ignored.add(node.id);
    result.bindings.push({
      name: node.text,
      scope,
      kind,
      functionId: null,
      declarationId: declarations.get(node.id)?.id ?? null,
      module: null,
      imported: null,
      receiver: null,
      ...extra,
    });
  };
  const bindPattern = (
    node: Node | null,
    scope: string,
    owner: string | null,
  ) => {
    if (!node) return;
    if (node.type === "identifier") {
      add(node, scope, "other", { declarationId: owner });
      return;
    }
    if (["attribute", "subscript"].includes(node.type)) return;
    if (
      [
        "pattern_list",
        "tuple_pattern",
        "list_pattern",
        "list_splat_pattern",
        "dictionary_splat_pattern",
        "as_pattern_target",
      ].includes(node.type)
    ) {
      for (const part of node.namedChildren) bindPattern(part, scope, owner);
      return;
    }
    omit(scope, "unsupported-binding");
  };
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (
      node.type === "function_definition" ||
      node.type === "class_definition"
    ) {
      const name = field(node, "name");
      if (name)
        add(
          name,
          scope,
          node.type === "function_definition" &&
            node.parent?.type !== "decorated_definition"
            ? "function"
            : "other",
          {
            functionId:
              node.type === "function_definition" &&
              node.parent?.type !== "decorated_definition"
                ? (fnIds.get(node.id) ?? null)
                : null,
            declarationId: declarations.get(node.id)?.id ?? null,
          },
        );
      if (node.type === "function_definition") {
        const own = scopeNodes.get(node.id)!;
        for (const parameter of field(node, "parameters")?.namedChildren ??
          []) {
          if (
            ["keyword_separator", "positional_separator"].includes(
              parameter.type,
            )
          )
            continue;
          if (parameter.type === "identifier") add(parameter, own, "other");
          else if (
            [
              "default_parameter",
              "typed_default_parameter",
              "typed_parameter",
            ].includes(parameter.type)
          )
            bindPattern(
              field(parameter, "name") ?? parameter.namedChildren[0] ?? null,
              own,
              declarations.get(parameter.id)?.id ?? null,
            );
          else bindPattern(parameter, own, null);
        }
      }
    }
    if (
      [
        "assignment",
        "augmented_assignment",
        "named_expression",
        "for_statement",
      ].includes(node.type)
    ) {
      const left = field(node, "left") ?? field(node, "name");
      // A module annotation without a value does not rebind an existing object.
      if (
        node.type !== "assignment" ||
        field(node, "right") ||
        scope !== "module"
      )
        bindPattern(left, scope, declarations.get(node.id)?.id ?? null);
    }
    if (node.type === "as_pattern")
      bindPattern(
        field(node, "alias"),
        scope,
        declarations.get(node.id)?.id ?? null,
      );
    if (
      [
        "global_statement",
        "nonlocal_statement",
        "delete_statement",
        "case_clause",
      ].includes(node.type)
    )
      omit(scope, "unsupported-scope-mutation");
    if (["import_statement", "import_from_statement"].includes(node.type)) {
      for (const part of descendants(node)) ignored.add(part.id);
      const from = node.type === "import_from_statement";
      const prefixNode = from ? field(node, "module_name") : null;
      const prefix = prefixNode ? literalModule(prefixNode) : null;
      const names = node.children.filter(
        (_, index) => node.fieldNameForChild(index) === "name",
      );
      if (from)
        result.imports.push({
          ...range(node),
          specifier: prefix && moduleName(prefix) ? prefix : null,
        });
      if (node.namedChildren.some((child) => child.type === "wildcard_import"))
        omit(scope, "wildcard-import");
      for (const part of names) {
        const original =
          part.type === "aliased_import" ? field(part, "name") : part;
        const alias =
          part.type === "aliased_import" ? field(part, "alias") : null;
        const specifier = original ? (literalModule(original) ?? "") : "";
        if (!moduleName(specifier) || (from && specifier.includes("."))) {
          omit(scope, "unsupported-import");
          continue;
        }
        if (!from) result.imports.push({ ...range(node), specifier });
        const local = alias ?? original!;
        const localName =
          alias?.text ?? (from ? specifier : specifier.split(".")[0]!);
        if (!ascii(localName)) {
          omit(scope, "unsupported-binding");
          continue;
        }
        result.bindings.push({
          name: localName,
          scope,
          kind: from ? "import" : "module",
          functionId: null,
          declarationId: declarations.get(node.id)?.id ?? null,
          module: from ? prefix : specifier,
          imported: from ? specifier : null,
          receiver: from ? null : (alias?.text ?? specifier),
        });
        ignored.add(local.id);
      }
    }
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    const unsupported = (() => {
      for (let parent = node.parent; parent; parent = parent.parent)
        if (
          (parent.type === "function_definition" &&
            field(parent, "type_parameters") !== null) ||
          [
            "lambda",
            "list_comprehension",
            "dictionary_comprehension",
            "set_comprehension",
            "generator_expression",
            "case_clause",
          ].includes(parent.type)
        )
          return true;
      return false;
    })();
    if (node.type === "call") {
      const originalFunction = field(node, "function");
      const fn = originalFunction ? unparenthesized(originalFunction) : null;
      let callee: string | null = null,
        receiver: string | null = null;
      if (fn?.type === "identifier" && ascii(fn.text)) callee = fn.text;
      else if (fn?.type === "attribute") {
        const member = field(fn, "attribute"),
          object = field(fn, "object");
        const prefix = object ? qualified(object) : null;
        if (member && ascii(member.text) && prefix) {
          callee = member.text;
          receiver = prefix;
        }
      }
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        callee,
        receiver,
        unsupported,
      });
    }
    if (
      node.type !== "identifier" ||
      ignored.has(node.id) ||
      !ascii(node.text) ||
      unsupported
    )
      continue;
    if (
      node.parent?.type === "attribute" &&
      field(node.parent, "attribute")?.id === node.id
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
export function validatePythonModuleRoots(roots: string[]): void {
  if (
    roots.length < 1 ||
    roots.length > 16 ||
    new Set(roots).size !== roots.length
  )
    throw new Error("Python module roots must be unique and bounded");
  for (const root of roots)
    if (
      root !== "." &&
      (root.includes("\\") ||
        [...root].some((character) => character.charCodeAt(0) < 32) ||
        path.posix.isAbsolute(root) ||
        path.posix.normalize(root) !== root ||
        root === ".." ||
        root.startsWith("../"))
    )
      throw new Error("Invalid Python module root");
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++)
      if (
        roots[i] === "." ||
        roots[j] === "." ||
        roots[i]!.startsWith(roots[j]! + "/") ||
        roots[j]!.startsWith(roots[i]! + "/")
      )
        throw new Error("Python module roots must not overlap");
}
