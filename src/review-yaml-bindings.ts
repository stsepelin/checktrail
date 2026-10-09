import type { Node } from "web-tree-sitter";
import type { ReviewBehavior } from "./review-behavior-schema.js";
import { validatePythonModuleRoots } from "./review-python-bindings.js";
export const validateYamlModuleRoots = validatePythonModuleRoots;
type Declaration = ReviewBehavior["declarations"][number];
type Range = Pick<
  Declaration,
  "revision" | "file" | "start" | "end" | "startLine" | "endLine"
>;
const child = (node: Node, type: string) =>
  node.namedChildren.find((c) => c.type === type);
const plainName = (node: Node | undefined) =>
  node && node.text.length <= 256 && /^[A-Za-z_][A-Za-z_0-9-]*$/.test(node.text)
    ? node.text
    : null;
function keyName(node: Node | undefined): string | null {
  if (!node) return null;
  if (node.type === "flow_node" && node.namedChildCount === 1)
    return keyName(node.namedChildren[0]);
  if (node.type === "plain_scalar" && node.namedChildCount === 1)
    return keyName(node.namedChildren[0]);
  if (node.type === "string_scalar")
    return node.text.length <= 256 ? node.text : null;
  if (node.type === "double_quote_scalar")
    try {
      const value: unknown = JSON.parse(node.text);
      return typeof value === "string" && value.length <= 256 ? value : null;
    } catch {
      return null;
    }
  return null;
}
export function yamlDeclaration(node: Node):
  | {
      kind: Declaration["kind"];
      name: string | null;
      initializer: Node | undefined;
    }
  | undefined {
  if (["block_mapping_pair", "flow_pair"].includes(node.type))
    return {
      kind: "property",
      name: keyName(node.childForFieldName("key") ?? undefined),
      initializer: node.childForFieldName("value") ?? undefined,
    };
  if (["block_node", "flow_node"].includes(node.type)) {
    const anchor = child(node, "anchor");
    if (anchor)
      return {
        kind: "variable",
        name: plainName(child(anchor, "anchor_name")),
        initializer: node.namedChildren.find(
          (c) => !["anchor", "tag"].includes(c.type),
        ),
      };
  }
  return undefined;
}
export type YamlSyntaxUnit = {
  file: string;
  revision: "base" | "current";
  anchors: (Range & {
    name: string | null;
    declarationId: string;
    documentStart: number;
    documentEnd: number;
    tagged: boolean;
  })[];
  aliases: (Range & {
    name: string | null;
    ownerDeclarationId: string | null;
    documentStart: number;
    documentEnd: number;
    unsupported: boolean;
  })[];
  omissions: string[];
};
export function yamlSourceOmissions(file: string): "non-yaml-source"[] {
  return /\.(?:yaml|yml)$/.test(file) ? [] : ["non-yaml-source"];
}
/** Parse captured strings only. Tags, merge handling and consuming applications never execute here. */
export function captureYamlBindings(
  nodes: Node[],
  declarations: Map<number, Declaration>,
  range: (node: Node) => Range,
): YamlSyntaxUnit {
  const address = range(nodes[0]!),
    result: YamlSyntaxUnit = {
      file: address.file,
      revision: address.revision,
      anchors: [],
      aliases: [],
      omissions: yamlSourceOmissions(address.file),
    };
  const omit = (value: string) => {
    if (!result.omissions.includes(value)) result.omissions.push(value);
  };
  const document = (node: Node) => {
    for (let p: Node | null = node; p; p = p.parent)
      if (p.type === "document") return p;
    return null;
  };
  const anchored = new Map<number, Declaration>();
  for (const node of nodes) {
    if (node.type === "tag") omit("tag-semantics-unknown");
    if (
      ["block_mapping_pair", "flow_pair"].includes(node.type) &&
      keyName(node.childForFieldName("key") ?? undefined) === "<<"
    )
      omit("merge-semantics-unknown");
    if (!["block_node", "flow_node"].includes(node.type)) continue;
    const anchor = child(node, "anchor"),
      decl = declarations.get(node.id),
      doc = document(node);
    if (!anchor || !decl || !doc) continue;
    anchored.set(node.id, decl);
    const name = plainName(child(anchor, "anchor_name")),
      tagged = node.namedChildren.some((c) => c.type === "tag");
    result.anchors.push({
      ...range(node),
      name,
      declarationId: decl.id,
      documentStart: doc.startIndex,
      documentEnd: doc.endIndex,
      tagged,
    });
    if (name === null) omit("unsupported-anchor-name");
  }
  for (const node of nodes) {
    if (node.type !== "alias") continue;
    const doc = document(node);
    if (!doc) continue;
    const name = plainName(child(node, "alias_name"));
    let owner: Declaration | undefined,
      anchorOwner: Declaration | undefined,
      unsupported = name === null;
    for (let p = node.parent; p; p = p.parent) {
      owner ??= declarations.get(p.id);
      anchorOwner ??= anchored.get(p.id);
      unsupported ||= p.namedChildren.some((c) => c.type === "tag");
      if (
        ["block_mapping_pair", "flow_pair"].includes(p.type) &&
        keyName(p.childForFieldName("key") ?? undefined) === "<<"
      )
        unsupported = true;
    }
    result.aliases.push({
      ...range(node),
      name,
      ownerDeclarationId: (anchorOwner ?? owner)?.id ?? null,
      documentStart: doc.startIndex,
      documentEnd: doc.endIndex,
      unsupported,
    });
    if (unsupported) omit("unsupported-alias");
  }
  return result;
}
