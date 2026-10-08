import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateRubyModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type RubyScope = {
  id: string;
  parent: string | null;
  kind: "file" | "function";
  caller: string | null;
  unknown: boolean;
};
export type RubyBinding = {
  name: string;
  scope: string;
  kind: "function" | "constant" | "local";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  literal: boolean;
  unsupported: boolean;
};
export type RubySyntaxUnit = {
  file: string;
  revision: "base" | "current";
  moduleName: string | null;
  scopes: RubyScope[];
  bindings: RubyBinding[];
  imports: (Range & { specifier: string | null; unsupported: boolean })[];
  calls: (Range & {
    scope: string;
    caller: string | null;
    name: string | null;
    qualifier: string | null;
    absolute: boolean;
    bare: boolean;
    unsupported: boolean;
  })[];
  references: (Range & {
    scope: string;
    caller: string | null;
    declaration: string | null;
    name: string;
    qualifier: string | null;
    absolute: boolean;
  })[];
  omissions: string[];
};
const field = (node: Node, name: string) => node.childForFieldName(name);
const methodName = (text: string) =>
  /^[a-z_][A-Za-z_0-9]*[!?]?$/.test(text) ? text : null;
const constantName = (text: string) =>
  /^[A-Z][A-Za-z_0-9]*$/.test(text) ? text : null;
function qualified(
  node: Node | null,
): { name: string; absolute: boolean } | null {
  if (
    !node ||
    !["constant", "scope_resolution"].includes(node.type) ||
    !/^(?:::)?[A-Z][A-Za-z_0-9]*(?:::[A-Z][A-Za-z_0-9]*)*$/.test(node.text)
  )
    return null;
  return {
    name: node.text.replace(/^::/, ""),
    absolute: node.text.startsWith("::"),
  };
}
export function rubySourceOmissions(
  file: string,
  source: string,
): ("non-ruby-source" | "data-tail-unknown" | "source-encoding-unknown")[] {
  const values: (
    "non-ruby-source" | "data-tail-unknown" | "source-encoding-unknown"
  )[] = [];
  if (!file.endsWith(".rb")) values.push("non-ruby-source");
  if (/^__END__\s*$/m.test(source)) values.push("data-tail-unknown");
  if (
    source
      .split(/\r?\n/)
      .slice(0, 2)
      .some((line) =>
        /#.*(?:coding|encoding)\s*[:=]\s*(?!utf-?8\b)[A-Za-z0-9_-]+/i.test(
          line,
        ),
      )
  )
    values.push("source-encoding-unknown");
  return values;
}
/** Fixed captured strings only; no Ruby interpreter, require, gem or module initializer is invoked. */
export function captureRubyBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): RubySyntaxUnit {
  const root = nodes[0]!,
    address = range(root),
    scopeFor = (node: Node) => {
      for (let p = node.parent; p; p = p.parent)
        if (fnIds.has(p.id)) return fnIds.get(p.id)!;
      return "file";
    };
  const scopes: RubyScope[] = [
    { id: "file", parent: null, kind: "file", caller: null, unknown: false },
  ];
  for (const node of nodes)
    if (fnIds.has(node.id))
      scopes.push({
        id: fnIds.get(node.id)!,
        parent: scopeFor(node),
        kind: "function",
        caller: fnIds.get(node.id)!,
        unknown:
          node.type !== "singleton_method" ||
          field(node, "object")?.type !== "self" ||
          scopeFor(node) !== "file",
      });
  const byScope = new Map(scopes.map((scope) => [scope.id, scope])),
    modules = nodes.filter((node) => node.type === "module"),
    moduleName =
      modules.length === 1 && field(modules[0]!, "name")?.type === "constant"
        ? constantName(field(modules[0]!, "name")!.text)
        : null;
  const result: RubySyntaxUnit = {
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
  if (moduleName === null || modules[0]?.parent?.id !== root.id)
    omit("file", "unsupported-module");
  for (const reason of rubySourceOmissions(address.file, root.text))
    omit("file", reason);
  const ignored = new Set<number>();
  function ignore(node: Node | null) {
    if (!node) return;
    ignored.add(node.id);
    for (const child of node.namedChildren) ignore(child);
  }
  const caller = (scope: string) => byScope.get(scope)?.caller ?? null;
  function add(
    node: Node | null,
    scope: string,
    kind: RubyBinding["kind"],
    visibleFrom: number,
    extra: Partial<RubyBinding> = {},
  ) {
    if (!node) return;
    ignore(node);
    const name =
      kind === "constant" ? constantName(node.text) : methodName(node.text);
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
      unsupported: false,
      ...extra,
    });
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "module") ignore(field(node, "name"));
    if (node.type === "singleton_method" || node.type === "method") {
      const fn = fnIds.get(node.id)!,
        name = field(node, "name"),
        params = field(node, "parameters"),
        supported =
          node.type === "singleton_method" &&
          field(node, "object")?.type === "self" &&
          scope === "file" &&
          node.parent?.parent?.type === "module";
      ignore(name);
      ignore(field(node, "object"));
      if (!supported) omit(fn, "instance-or-dynamic-method-unknown");
      else
        add(name, "file", "function", 0, {
          functionId: fn,
          declarationId: declarations.get(node.id)?.id ?? null,
          unsupported: methodName(name?.text ?? "") === null,
        });
      if (params)
        for (const param of params.namedChildren) {
          if (param.type === "identifier") add(param, fn, "local", 0);
          else if (
            param.type === "optional_parameter" &&
            field(param, "name")?.type === "identifier"
          )
            add(field(param, "name"), fn, "local", 0);
          else {
            ignore(param);
            omit(fn, "unsupported-parameters");
          }
        }
      if (scope !== "file") omit("file", "nested-method-unknown");
    }
    if (node.type === "assignment") {
      const left = field(node, "left"),
        right = field(node, "right"),
        decl = declarations.get(node.id);
      if (
        left?.type === "constant" &&
        scope === "file" &&
        node.parent?.parent?.type === "module"
      )
        add(left, scope, "constant", 0, {
          declarationId: decl?.id ?? null,
          literal:
            (!!right &&
              ["integer", "float", "true", "false", "nil", "symbol"].includes(
                right.type,
              )) ||
            (right?.type === "string" &&
              right.namedChildren.every(
                (child) =>
                  child.type === "string_content" ||
                  child.type === "escape_sequence",
              )),
        });
      else if (left?.type === "identifier")
        add(left, scope, "local", left.endIndex, {
          declarationId: decl?.id ?? null,
        });
      else {
        ignore(left);
        omit(scope, "unsupported-binding");
      }
    }
    if (
      [
        "block",
        "do_block",
        "lambda",
        "for",
        "while",
        "until",
        "while_modifier",
        "until_modifier",
        "ensure",
        "yield",
        "super",
        "case",
        "case_match",
        "rescue",
        "rescue_modifier",
        "if_modifier",
        "unless_modifier",
        "operator_assignment",
        "left_assignment_list",
        "destructured_parameter",
      ].includes(node.type)
    )
      omit(scope, "unsupported-scope");
    if (["class", "singleton_class"].includes(node.type))
      omit("file", "class-dispatch-unknown");
    if (["alias", "undef", "begin", "end"].includes(node.type))
      omit("file", "metaprogramming-unknown");
    if (node.type === "call") {
      const name = field(node, "method")?.text ?? "",
        receiver = field(node, "receiver");
      if (
        scope === "file" &&
        !(name === "require_relative" && receiver === null)
      )
        omit("file", "module-initialization-unknown");
      if (
        [
          "eval",
          "class_eval",
          "module_eval",
          "instance_eval",
          "define_method",
          "define_singleton_method",
          "const_set",
          "remove_const",
          "include",
          "extend",
          "prepend",
          "refine",
          "using",
          "private",
          "protected",
          "private_class_method",
          "public_class_method",
          "module_function",
          "autoload",
        ].includes(name)
      )
        omit("file", "metaprogramming-unknown");
      if (name === "require_relative" && !receiver) {
        const args = field(node, "arguments")?.namedChildren ?? [],
          arg = args[0],
          specifier =
            args.length === 1 &&
            arg?.type === "string" &&
            arg.namedChildren.length === 1 &&
            arg.namedChildren[0]?.type === "string_content"
              ? arg.namedChildren[0].text
              : null;
        result.imports.push({
          ...range(node),
          specifier,
          unsupported: specifier === null || scope !== "file",
        });
        ignore(arg ?? null);
        if (specifier === null || scope !== "file")
          omit(scope, "unsupported-import");
      } else if (["require", "load"].includes(name))
        omit("file", "unsupported-import");
    }
  }
  for (const child of root.namedChildren)
    if (
      child.type !== "module" &&
      child.type !== "comment" &&
      !(
        child.type === "call" &&
        field(child, "method")?.text === "require_relative"
      )
    )
      omit("file", "unsupported-module");
  for (const binding of result.bindings)
    if (binding.functionId !== null && byScope.get(binding.functionId)?.unknown)
      binding.unsupported = true;
  const local = (scope: string, name: string, offset: number) =>
    result.bindings.some(
      (binding) =>
        binding.scope === scope &&
        binding.kind === "local" &&
        binding.name === name &&
        binding.visibleFrom <= offset,
    );
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "call") {
      const receiver = field(node, "receiver"),
        name = field(node, "method"),
        qualifier = qualified(receiver);
      ignore(name);
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        name: methodName(name?.text ?? ""),
        qualifier:
          receiver === null || receiver.type === "self"
            ? null
            : (qualifier?.name ?? null),
        absolute: qualifier?.absolute ?? false,
        bare: false,
        unsupported:
          (receiver !== null &&
            receiver.type !== "self" &&
            qualifier === null) ||
          field(node, "operator")?.text === "&." ||
          scope === "file",
      });
      if (
        receiver?.type === "constant" ||
        receiver?.type === "scope_resolution"
      )
        ignore(receiver);
    }
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (ignored.has(node.id)) continue;
    if (
      node.type === "identifier" &&
      methodName(node.text) !== null &&
      !local(scope, node.text, node.startIndex) &&
      scope !== "file"
    )
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        name: node.text,
        qualifier: null,
        absolute: false,
        bare: true,
        unsupported: false,
      });
    if (
      !["constant", "scope_resolution"].includes(node.type) ||
      node.parent?.type === "scope_resolution"
    )
      continue;
    const value = qualified(node);
    if (!value) continue;
    const parts = value.name.split("::"),
      name = parts.pop()!;
    let declaration: string | null = null;
    for (let p = node.parent; p; p = p.parent)
      if (declarations.has(p.id)) {
        declaration = declarations.get(p.id)!.id;
        break;
      }
    result.references.push({
      ...range(node),
      scope,
      caller: caller(scope),
      declaration,
      name,
      qualifier: parts.length ? parts.join("::") : null,
      absolute: value.absolute,
    });
  }
  return result;
}
