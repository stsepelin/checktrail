import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
export { validatePythonModuleRoots as validateJavaModuleRoots } from "./review-python-bindings.js";
type Range = Pick<
  ReviewBehavior["calls"][number],
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
export type JavaScope = {
  id: string;
  parent: string | null;
  kind: "file" | "class" | "function" | "lambda" | "block";
  owner: string | null;
  caller: string | null;
  unknown: boolean;
};
export type JavaType = Range & {
  name: string | null;
  qualifiedName: string | null;
  scope: string;
  parent: string;
  unsupported: boolean;
  public: boolean;
};
export type JavaBinding = {
  name: string;
  scope: string;
  kind: "method" | "field" | "local" | "type";
  visibleFrom: number;
  functionId: string | null;
  declarationId: string | null;
  static: boolean;
  final: boolean;
  visibility: "public" | "private" | "package";
  unsupported: boolean;
};
export type JavaSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  packageName: string | null;
  scopes: JavaScope[];
  types: JavaType[];
  bindings: JavaBinding[];
  imports: (Range & {
    specifier: string | null;
    static: boolean;
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
const field = (node: Node, name: string) => node.childForFieldName(name);
const named = (node: Node | null) =>
  node && /^[A-Za-z_$][A-Za-z_$0-9]*$/.test(node.text) ? node.text : null;
function qualified(node: Node | null): string | null {
  if (!node) return null;
  if (["identifier", "type_identifier"].includes(node.type)) return named(node);
  if (node.type === "scoped_identifier") {
    const prefix = qualified(field(node, "scope")),
      suffix = named(field(node, "name"));
    return prefix && suffix ? prefix + "." + suffix : null;
  }
  if (node.type === "field_access") {
    const prefix = qualified(field(node, "object")),
      suffix = named(field(node, "field"));
    return prefix && suffix ? prefix + "." + suffix : null;
  }
  return null;
}
const modifiers = (node: Node) =>
  new Set(
    node.namedChildren
      .find((n) => n.type === "modifiers")
      ?.children.map((n) => n.type) ?? [],
  );
const annotated = (node: Node) =>
  node.namedChildren
    .find((n) => n.type === "modifiers")
    ?.namedChildren.some((n) => n.type.includes("annotation")) ?? false;
const typeKinds = [
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
];
/** Capture only Java source names and lexical scopes; no class loading, compiler or project configuration is invoked. */
export function captureJavaBindings(
  nodes: Node[],
  fnIds: Map<number, string>,
  declarations: Map<number, ReviewBehavior["declarations"][number]>,
  range: (node: Node) => Range,
): JavaSyntaxUnit {
  const address = range(nodes[0]!);
  const scopeNodes = new Map<number, string>();
  for (const node of nodes) {
    if (typeKinds.includes(node.type))
      scopeNodes.set(node.id, "class:" + node.startIndex);
    else if (fnIds.has(node.id)) scopeNodes.set(node.id, fnIds.get(node.id)!);
    else if (
      node.type === "class_body" &&
      node.parent?.type === "object_creation_expression"
    )
      scopeNodes.set(node.id, "anonymous:" + node.startIndex);
    else if (
      [
        "block",
        "enhanced_for_statement",
        "for_statement",
        "catch_clause",
        "try_with_resources_statement",
        "switch_expression",
      ].includes(node.type)
    )
      scopeNodes.set(node.id, "scope:" + node.startIndex + ":" + node.type);
  }
  const scopeFor = (node: Node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      const id = scopeNodes.get(parent.id);
      if (!id) continue;
      if (typeKinds.includes(parent.type) || fnIds.has(parent.id)) {
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
  const scopes: JavaScope[] = [
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
    const type = typeKinds.includes(node.type) || node.type === "class_body",
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
          field(node, "superclass") !== null ||
          field(node, "interfaces") !== null ||
          field(node, "type_parameters") !== null ||
          annotated(node) ||
          m.has("private") ||
          (scopeFor(node) !== "file" && !m.has("static"))
        : fn
          ? annotated(node) ||
            field(node, "type_parameters") !== null ||
            (node.type !== "lambda_expression" && !m.has("static"))
          : [
              "enhanced_for_statement",
              "for_statement",
              "catch_clause",
              "try_with_resources_statement",
              "switch_expression",
            ].includes(node.type),
    });
  }
  const byScope = new Map(scopes.map((scope) => [scope.id, scope]));
  const ancestry = (scope: string) => {
    const values: JavaScope[] = [];
    for (
      let current = byScope.get(scope);
      current;
      current =
        current.parent === null ? undefined : byScope.get(current.parent)
    )
      values.push(current);
    return values;
  };
  const owner = (scope: string) =>
    ancestry(scope).find((s) => s.kind === "class")?.id ?? null;
  const caller = (scope: string) =>
    ancestry(scope).find((s) => s.caller !== null)?.caller ?? null;
  const packages = nodes.filter((node) => node.type === "package_declaration");
  const packageName =
    packages.length === 0
      ? ""
      : packages.length === 1
        ? qualified(
            packages[0]!.namedChildren.find((n) =>
              ["identifier", "scoped_identifier"].includes(n.type),
            ) ?? null,
          )
        : null;
  const result: JavaSyntaxUnit = {
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
  if (nodes[0]!.text.includes("\\u")) omit("file", "unicode-escapes-unknown");
  if (packageName === null || packages.some(annotated))
    omit("file", "unsupported-package");
  const ignored = new Set<number>();
  function add(
    node: Node | null,
    scope: string,
    kind: JavaBinding["kind"],
    visibleFrom = 0,
    extra: Partial<JavaBinding> = {},
  ) {
    if (!node) return;
    ignored.add(node.id);
    if (node.text === "_") return;
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
      visibility: "package",
      unsupported: false,
      ...extra,
    });
  }
  const visibility = (m: Set<string>): JavaBinding["visibility"] =>
    m.has("public") ? "public" : m.has("private") ? "private" : "package";
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
            : result.types.find((t) => t.scope === parent);
      const qualifiedName =
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
      add(
        field(node, "name"),
        scope,
        "type",
        byScope.get(scope)?.kind === "block" ? node.startIndex : 0,
        {
          unsupported: byScope.get(id)!.unknown,
        },
      );
      if (byScope.get(id)!.unknown) omit(id, "unsupported-type", false);
    }
    if (node.type === "method_declaration")
      add(field(node, "name"), scope, "method", 0, {
        functionId: fnIds.get(node.id) ?? null,
        declarationId: declarations.get(node.id)?.id ?? null,
        static: m.has("static"),
        visibility: visibility(m),
        unsupported:
          annotated(node) ||
          field(node, "type_parameters") !== null ||
          field(node, "body") === null,
      });
    if (node.type === "constructor_declaration") {
      const name = field(node, "name");
      if (name) ignored.add(name.id);
      omit(scope, "constructor-dispatch-unknown", false);
    }
    if (node.type === "variable_declarator") {
      const parent = node.parent;
      if (parent?.type === "field_declaration") {
        const flags = modifiers(parent);
        add(field(node, "name"), scope, "field", 0, {
          declarationId: declarations.get(node.id)?.id ?? null,
          static: flags.has("static"),
          final: flags.has("final"),
          visibility: visibility(flags),
          unsupported: annotated(parent),
        });
      } else add(field(node, "name"), scope, "local", node.startIndex);
    }
    if (node.type === "formal_parameter" || node.type === "spread_parameter") {
      let fn = node.parent;
      while (fn && !fnIds.has(fn.id)) fn = fn.parent;
      const target = fn ? scopeNodes.get(fn.id) : null;
      if (target)
        add(
          field(node, "name") ??
            node.namedChildren
              .find((n) => n.type === "variable_declarator")
              ?.childForFieldName("name") ??
            null,
          target,
          "local",
        );
    }
    if (node.type === "lambda_expression") {
      const parameters = field(node, "parameters"),
        target = scopeNodes.get(node.id)!;
      if (parameters?.type === "identifier") add(parameters, target, "local");
      if (parameters?.type === "inferred_parameters")
        for (const parameter of parameters.namedChildren)
          if (parameter.type === "identifier") add(parameter, target, "local");
          else omit(target, "unsupported-pattern");
    }
    if (
      ["type_pattern", "record_pattern", "instanceof_expression"].includes(
        node.type,
      )
    )
      omit(scope, "unsupported-pattern");
    if (node.type === "import_declaration") {
      const imported =
          node.namedChildren.find((n) =>
            ["identifier", "scoped_identifier"].includes(n.type),
          ) ?? null,
        specifier = qualified(imported),
        isStatic = node.children.some((n) => n.type === "static");
      const unsupported =
        specifier === null ||
        node.namedChildren.some((n) => n.type === "asterisk") ||
        node.children.some((n) => n.type === "module");
      result.imports.push({
        ...range(node),
        specifier,
        static: isStatic,
        unsupported,
      });
      if (unsupported) omit("file", "unsupported-import");
    }
    if (annotated(node)) omit(scope, "annotations-unknown", false);
    if (node.type === "module_declaration")
      omit("file", "module-selection-unknown");
  }
  for (const node of nodes) {
    const scope = scopeFor(node);
    if (node.type === "object_creation_expression") {
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
    if (node.type === "method_invocation") {
      const object = field(node, "object"),
        name = named(field(node, "name")),
        qualifier = qualified(object);
      result.calls.push({
        ...range(node),
        scope,
        caller: caller(scope),
        owner: owner(scope),
        name,
        qualifier,
        unsupported:
          name === null ||
          (object !== null && qualifier === null) ||
          field(node, "type_arguments") !== null,
      });
    }
    if (
      !["identifier", "field_access"].includes(node.type) ||
      ignored.has(node.id) ||
      node.parent?.type === "field_access"
    )
      continue;
    const expression = qualified(node);
    if (expression === null) continue;
    let skip = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (
        [
          "package_declaration",
          "import_declaration",
          "modifiers",
          "type_parameters",
          "type_arguments",
        ].includes(parent.type) ||
        parent.type.endsWith("type") ||
        parent.type.includes("pattern")
      ) {
        skip = true;
        break;
      }
      if (
        (parent.type === "method_invocation" &&
          field(parent, "name")?.id === node.id) ||
        (parent.type === "method_reference" &&
          parent.namedChildren.at(-1)?.id === node.id) ||
        ["break_statement", "continue_statement"].includes(parent.type) ||
        (parent.type === "labeled_statement" &&
          parent.namedChildren[0]?.id === node.id)
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
      owner: owner(scope),
      declaration,
      name,
      qualifier: parts.length ? parts.join(".") : null,
    });
  }
  return result;
}
