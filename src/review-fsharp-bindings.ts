import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateFsharpModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type FsharpScope = {
  id: string;
  parent: string | null;
  kind: "file" | "function" | "block";
  caller: string | null;
  unknown: boolean;
};
export type FsharpBinding = {
  name: string;
  scope: string;
  visibleFrom: number;
  kind: "function" | "value";
  functionId: string | null;
  declarationId: string | null;
  literal: boolean;
  private: boolean;
  unsupported: boolean;
};
export type FsharpSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  moduleName: string | null;
  scopes: FsharpScope[];
  bindings: FsharpBinding[];
  imports: (Range & {
    scope: string;
    kind: "open" | "alias";
    alias: string | null;
    specifier: string | null;
    visibleFrom: number;
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
const field = (node: Node, name: string) => node.childForFieldName(name),
  plain = (text: string) =>
    /^[A-Za-z_][A-Za-z_0-9]*$/.test(text) ? text : null;
function qualified(node: Node | null): string | null {
  if (
    !node ||
    ![
      "identifier",
      "identifier_pattern",
      "long_identifier",
      "long_identifier_or_op",
    ].includes(node.type)
  )
    return null;
  return /^[A-Za-z_][A-Za-z_0-9]*(?:\.[A-Za-z_][A-Za-z_0-9]*)*$/.test(node.text)
    ? node.text
    : null;
}
function unsupportedFsharpHeader(node: Node): boolean {
  const body = field(node, "body");
  return /\b(?:rec|inline|mutable|internal|and)\b/.test(
    node.text.slice(
      0,
      body ? body.startIndex - node.startIndex : node.text.length,
    ),
  );
}
export function fsharpSourceOmissions(
  file: string,
  source: string,
): (
  | "script-source-unknown"
  | "signature-source-unknown"
  | "conditional-source-unknown"
  | "attributes-unknown"
)[] {
  const output: (
    | "script-source-unknown"
    | "signature-source-unknown"
    | "conditional-source-unknown"
    | "attributes-unknown"
  )[] = [];
  if (file.endsWith(".fsx")) output.push("script-source-unknown");
  if (file.endsWith(".fsi")) output.push("signature-source-unknown");
  if (/^\s*#/m.test(source)) output.push("conditional-source-unknown");
  if (source.includes("[<")) output.push("attributes-unknown");
  return output;
}
/** Fixed captured strings only. Module initialization, FSI, project evaluation and native compilation are never invoked. */
export function captureFsharpBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): FsharpSyntaxUnit {
  const address = range(nodes[0]!),
    root = nodes[0]!,
    scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (fnIds.has(node.id)) scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (
      (node.type === "declaration_expression" && field(node, "in") !== null) ||
      [
        "fun_expression",
        "function_expression",
        "match_expression",
        "for_expression",
        "while_expression",
        "computation_expression",
        "ce_expression",
        "try_expression",
        "object_expression",
      ].includes(node.type)
    )
      scopeNodes.set(node.id, "scope:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const id = scopeNodes.get(parent.id);
      if (!id) continue;
      if (fnIds.has(parent.id)) {
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
  const scopes: FsharpScope[] = [
    { id: "file", parent: null, kind: "file", caller: null, unknown: false },
  ];
  for (const node of nodes) {
    const id = scopeNodes.get(node.id);
    if (!id) continue;
    const fn = fnIds.has(node.id),
      left = node.namedChildren.find(
        (child) => child.type === "function_declaration_left",
      ),
      args = left?.namedChildren.find(
        (child) => child.type === "argument_patterns",
      ),
      unsupported = fn
        ? left === undefined ||
          args === undefined ||
          args.namedChildren.length !== 1 ||
          left.namedChildren.some((child) => child.type === "type_arguments") ||
          unsupportedFsharpHeader(node) ||
          node.text.includes("[<")
        : node.type !== "declaration_expression";
    scopes.push({
      id,
      parent: scopeFor(node),
      kind: fn ? "function" : "block",
      caller: fn ? fnIds.get(node.id)! : null,
      unknown: unsupported,
    });
  }
  const byScope = new Map(scopes.map((scope) => [scope.id, scope])),
    caller = (scope: string) => {
      for (
        let s = byScope.get(scope);
        s;
        s = s.parent === null ? undefined : byScope.get(s.parent)
      )
        if (s.caller !== null) return s.caller;
      return null;
    };
  const modules = nodes.filter((node) => node.type === "named_module"),
    moduleName =
      modules.length === 1 ? qualified(field(modules[0]!, "name")) : null;
  const result: FsharpSyntaxUnit = {
    file: address.file,
    revision: address.revision,
    moduleName,
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
  if (
    moduleName === null ||
    root.namedChildren.some(
      (child) =>
        child.type !== "named_module" &&
        !["comment", "line_comment", "block_comment"].includes(child.type),
    ) ||
    modules.some((node) =>
      /^module\s+(?:rec|private|internal)\b/.test(node.text),
    )
  )
    omit("file", "unsupported-module");
  for (const module of modules)
    for (const child of module.namedChildren)
      if (
        child.id !== field(module, "name")?.id &&
        ![
          "declaration_expression",
          "import_decl",
          "module_defn",
          "comment",
          "line_comment",
          "block_comment",
        ].includes(child.type)
      )
        omit("file", "unsupported-type-or-pattern");
  for (const reason of fsharpSourceOmissions(address.file, root.text))
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
    kind: FsharpBinding["kind"],
    visibleFrom: number,
    extra: Partial<FsharpBinding> = {},
  ) {
    if (!node) return;
    ignore(node);
    const name = plain(node.text);
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
      private: false,
      unsupported: false,
      ...extra,
    });
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "named_module") ignore(field(node, "name"));
    if (node.type === "function_or_value_defn") {
      if (
        node.namedChildren.filter(
          (child) =>
            child.type === "function_declaration_left" ||
            child.type === "value_declaration_left",
        ).length !== 1
      )
        omit(scope, "unsupported-binding");
      const fn = fnIds.get(node.id),
        left = node.namedChildren.find((child) =>
          ["function_declaration_left", "value_declaration_left"].includes(
            child.type,
          ),
        );
      if (!left) {
        omit(scope, "unsupported-binding");
        continue;
      }
      const nameNode =
          left.namedChildren.find(
            (child) =>
              child.type === "identifier" ||
              child.type === "identifier_pattern",
          ) ?? null,
        name = nameNode === null ? null : plain(nameNode.text),
        body = field(node, "body"),
        unsupported =
          byScope.get(fn ?? scope)?.unknown === true ||
          unsupportedFsharpHeader(node) ||
          name === null;
      const declaration = declarations.get(node.id);
      if (declaration && name !== null) declaration.name = name;
      add(nameNode, scope, fn ? "function" : "value", node.endIndex, {
        functionId: fn ?? null,
        declarationId: declaration?.id ?? null,
        literal: fn === undefined && body?.type === "const",
        private: /^let\s+private\b/.test(node.text),
        unsupported,
      });
      if (unsupported)
        omit(
          fn ?? scope,
          "unsupported-binding",
          fn === undefined && name === null,
        );
      if (fn) {
        const patterns = left.namedChildren.find(
          (child) => child.type === "argument_patterns",
        );
        if (patterns) {
          ignore(patterns);
          for (const pattern of patterns.namedChildren) {
            if (pattern.type === "const" && pattern.text === "()") continue;
            const param =
              pattern.type === "typed_pattern"
                ? (pattern.namedChildren.find(
                    (child) => child.type === "identifier_pattern",
                  ) ?? null)
                : pattern;
            if (
              param === null ||
              !["long_identifier", "identifier_pattern", "identifier"].includes(
                param.type,
              ) ||
              plain(param.text) === null
            ) {
              omit(fn, "unsupported-binding");
              continue;
            }
            add(param, fn, "value", 0);
          }
        }
      }
    }
    if (node.type === "module_defn") {
      const block = field(node, "block"),
        alias =
          node.namedChildren.find((child) => child.type === "identifier") ??
          null,
        specifier = qualified(block);
      ignore(alias);
      if (specifier === null) {
        omit("file", "unsupported-module");
        continue;
      }
      result.imports.push({
        ...range(node),
        scope,
        kind: "alias",
        alias: alias === null ? null : plain(alias.text),
        specifier,
        visibleFrom: node.endIndex,
        unsupported: alias === null || plain(alias.text) === null,
      });
      ignore(block);
    }
    if (node.type === "import_decl") {
      const target =
          node.namedChildren.find(
            (child) => child.type === "long_identifier",
          ) ?? null,
        specifier = qualified(target),
        unsupported = specifier === null || /^open\s+type\b/.test(node.text);
      result.imports.push({
        ...range(node),
        scope,
        kind: "open",
        alias: null,
        specifier,
        visibleFrom: node.endIndex,
        unsupported,
      });
      ignore(target);
      if (unsupported) omit(scope, "unsupported-import");
    }
    if (
      [
        "type_definition",
        "member_defn",
        "member_definition",
        "exception_definition",
        "active_pattern",
        "active_pattern_op",
        "and_function_or_value_defn",
      ].includes(node.type)
    )
      omit("file", "unsupported-type-or-pattern");
  }
  for (const scope of scopes)
    if (scope.unknown && scope.id !== "file")
      omit(
        scope.id,
        scope.kind === "function"
          ? "unsupported-binding"
          : "unsupported-pattern",
        false,
      );
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "application_expression") {
      const expression = qualified(node.namedChildren[0] ?? null),
        parts = expression?.split(".") ?? [],
        name = parts.pop() ?? null;
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        name,
        qualifier: parts.length ? parts.join(".") : null,
        unsupported: expression === null,
      });
    }
    if (
      !["long_identifier_or_op", "long_identifier", "identifier"].includes(
        node.type,
      ) ||
      ignored.has(node.id) ||
      [
        "long_identifier_or_op",
        "long_identifier",
        "identifier_pattern",
      ].includes(node.parent?.type ?? "")
    )
      continue;
    const expression = qualified(node);
    if (expression === null) continue;
    let skip = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        [
          "simple_type",
          "type_arguments",
          "argument_patterns",
          "function_declaration_left",
          "value_declaration_left",
          "attributes",
          "attribute",
        ].includes(parent.type)
      ) {
        skip = true;
        break;
      }
      if (
        parent.type === "application_expression" &&
        parent.namedChildren[0]?.id === node.id
      ) {
        skip = true;
        break;
      }
    }
    if (skip) continue;
    let declaration: string | null = null;
    for (let parent = node.parent; parent; parent = parent.parent)
      if (declarations.has(parent.id)) {
        declaration = declarations.get(parent.id)!.id;
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
