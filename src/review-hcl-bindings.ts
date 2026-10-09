import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
export const validateHclModuleRoots = validatePythonModuleRoots;
type Declaration = ReviewBehavior["declarations"][number];
type Range = Pick<
  Declaration,
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
const identifier = (node: Node | undefined) =>
  node?.type === "identifier" &&
  node.text.length <= 256 &&
  /^[A-Za-z_][A-Za-z_0-9-]*$/.test(node.text)
    ? node.text
    : null;
const child = (node: Node, type: string) =>
  node.namedChildren.find((child) => child.type === type);
function literalString(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "expression" || node.type === "literal_value")
    return node.namedChildCount === 1
      ? literalString(node.namedChildren[0])
      : null;
  if (
    node.type !== "string_lit" ||
    node.namedChildren.some(
      (c) =>
        ![
          "quoted_template_start",
          "template_literal",
          "quoted_template_end",
        ].includes(c.type),
    )
  )
    return null;
  try {
    const value: unknown = JSON.parse(node.text);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}
export function hclDeclaration(node: Node):
  | {
      kind: Declaration["kind"];
      name: string | null;
      initializer: Node | undefined;
    }
  | undefined {
  if (node.type === "attribute")
    return {
      kind: "property",
      name: identifier(child(node, "identifier")),
      initializer: child(node, "expression"),
    };
  if (node.type !== "block") return undefined;
  const kind = identifier(node.namedChildren[0]),
    labels = node.namedChildren.filter((c) => c.type === "string_lit");
  const name =
    labels.length === 1
      ? literalString(labels[0])
      : labels.length === 0
        ? kind
        : null;
  const field =
    kind === "variable"
      ? "default"
      : kind === "output"
        ? "value"
        : kind === "module"
          ? "source"
          : null;
  const attribute = child(node, "body")?.namedChildren.find(
    (c) =>
      c.type === "attribute" && identifier(child(c, "identifier")) === field,
  );
  return {
    kind:
      kind === "variable"
        ? "parameter"
        : kind === "module"
          ? "import"
          : "property",
    name: name !== null && name.length <= 256 ? name : null,
    initializer: attribute ? child(attribute, "expression") : undefined,
  };
}
export type HclSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  bindings: {
    name: string;
    kind: "var" | "local" | "output";
    declarationId: string;
  }[];
  imports: (Range & {
    name: string | null;
    specifier: string | null;
    unsupported: boolean;
  })[];
  references: (Range & {
    ownerDeclarationId: string | null;
    segments: string[];
    unsupported: boolean;
  })[];
  omissions: string[];
};
export function hclSourceOmissions(
  file: string,
): ("non-hcl-source" | "input-override-source-unknown")[] {
  return /\.(?:tf|hcl)$/.test(file)
    ? []
    : file.endsWith(".tfvars")
      ? ["input-override-source-unknown"]
      : ["non-hcl-source"];
}
/** Fixed grammar nodes only: project evaluation and HCL application configuration never execute here. */
export function captureHclBindings(
  nodes: Node[],
  declarations: Map<number, Declaration>,
  range: (node: Node) => Range,
): HclSyntaxUnit {
  const root = nodes[0]!,
    address = range(root),
    result: HclSyntaxUnit = {
      file: address.file,
      revision: address.revision,
      bindings: [],
      imports: [],
      references: [],
      omissions: hclSourceOmissions(address.file),
    };
  const omit = (reason: string) => {
    if (!result.omissions.includes(reason)) result.omissions.push(reason);
  };
  const outerBlock = (node: Node) => {
    for (let p = node.parent; p; p = p.parent) if (p.type === "block") return p;
    return null;
  };
  const top = (node: Node) =>
    node.parent?.type === "body" && node.parent.parent?.type === "config_file";
  const complex = new Set<number>();
  for (const node of nodes) {
    if (
      ["for_expr", "splat", "index", "template_directive"].includes(node.type)
    ) {
      complex.add(node.id);
      omit("unsupported-expression");
    }
    if (node.type === "block") {
      const kind = identifier(node.namedChildren[0]),
        decl = declarations.get(node.id),
        labels = node.namedChildren.filter((c) => c.type === "string_lit");
      if (
        !top(node) ||
        !["variable", "locals", "output", "module"].includes(kind ?? "")
      )
        omit("application-block-unknown");
      if (!top(node) || !decl) continue;
      if (
        (kind === "variable" || kind === "output") &&
        decl.name !== null &&
        labels.length === 1 &&
        /^[A-Za-z_][A-Za-z_0-9-]*$/.test(decl.name)
      )
        result.bindings.push({
          name: decl.name,
          kind: kind === "variable" ? "var" : "output",
          declarationId: decl.id,
        });
      if ((kind === "variable" || kind === "output") && decl.name === null)
        omit("unsupported-expression");
      if (kind === "module") {
        const attributes =
            child(node, "body")?.namedChildren.filter(
              (c) => c.type === "attribute",
            ) ?? [],
          source = attributes.filter(
            (c) => identifier(child(c, "identifier")) === "source",
          );
        const unsupported =
          labels.length !== 1 ||
          decl.name === null ||
          source.length !== 1 ||
          attributes.some((c) =>
            ["count", "for_each", "providers", "version"].includes(
              identifier(child(c, "identifier")) ?? "",
            ),
          );
        result.imports.push({
          ...range(node),
          name: decl.name,
          specifier:
            source.length === 1
              ? literalString(child(source[0]!, "expression"))
              : null,
          unsupported,
        });
        if (unsupported) omit("unsupported-import");
      }
    } else if (node.type === "attribute") {
      const block = outerBlock(node),
        decl = declarations.get(node.id),
        name = identifier(child(node, "identifier"));
      if (
        block &&
        top(block) &&
        identifier(block.namedChildren[0]) === "locals" &&
        decl
      ) {
        if (name === null) omit("unsupported-expression");
        else
          result.bindings.push({ name, kind: "local", declarationId: decl.id });
      }
    }
  }
  for (const node of nodes) {
    if (node.type !== "variable_expr") continue;
    let parent: Node | null = node;
    let unsupported = false;
    const owners: Declaration[] = [];
    while (parent) {
      unsupported ||= complex.has(parent.id);
      const declared = declarations.get(parent.id);
      if (declared) owners.push(declared);
      parent = parent.parent;
    }
    const siblings = node.parent?.namedChildren ?? [],
      position = siblings.findIndex((c) => c.id === node.id),
      parts = [identifier(node.namedChildren[0])];
    let end = node;
    for (
      let i = position + 1;
      i < siblings.length && siblings[i]!.type === "get_attr";
      i++
    ) {
      const attr = siblings[i]!;
      parts.push(identifier(attr.namedChildren[0]));
      end = attr;
    }
    const next = siblings[siblings.findIndex((c) => c.id === end.id) + 1];
    unsupported ||=
      parts.some((value) => value === null) ||
      parts.length > 3 ||
      ["index", "splat"].includes(next?.type ?? "");
    const scope = outerBlock(node);
    unsupported ||=
      scope === null ||
      !top(scope) ||
      !["variable", "locals", "output", "module"].includes(
        identifier(scope.namedChildren[0]) ?? "",
      );
    const attribute = (() => {
      for (let p = node.parent; p; p = p.parent)
        if (p.type === "attribute") return p;
      return null;
    })();
    if (
      scope &&
      identifier(scope.namedChildren[0]) === "variable" &&
      attribute &&
      identifier(attribute.namedChildren[0]) === "type"
    )
      continue;
    const outputOwner =
      scope && identifier(scope.namedChildren[0]) === "output"
        ? declarations.get(scope.id)
        : undefined;
    const owner =
      outputOwner ?? owners.find((d) => d.kind === "property") ?? owners[0];
    result.references.push({
      ...range(node),
      end: range(end).end,
      endLine: range(end).endLine,
      ownerDeclarationId: owner?.id ?? null,
      segments: parts.filter((value): value is string => value !== null),
      unsupported,
    });
    if (unsupported) omit("unsupported-expression");
  }
  return result;
}
