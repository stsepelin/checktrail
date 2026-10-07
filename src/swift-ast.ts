export interface SwiftAstNode {
  kind: string;
  header: string;
  children: SwiftAstNode[];
}

// This is a bounded parser for the pinned compiler's declaration dump. It never
// reads project source as a substitute for native declaration identity.
export function swiftAst(text: string): SwiftAstNode {
  if (!text || Buffer.byteLength(text) > 4 * 1024 * 1024 || text.includes("\0"))
    throw new Error("Swift compiler declaration artifact is unavailable");
  let index = 0;
  let nodes = 0;
  const kindPattern = /[a-z_][a-z0-9_]*/y;
  const space = () => {
    while (/\s/.test(text[index] || "") && index < text.length) index++;
  };
  const quoted = () => {
    index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index++] === '"') return;
    }
    throw new Error("Swift compiler string is incomplete");
  };
  const bracket = () => {
    let depth = 1;
    index++;
    while (index < text.length) {
      if (text[index] === '"') quoted();
      else if (text[index] === "[") {
        if (++depth > 32)
          throw new Error("Swift compiler brackets exceed limits");
        index++;
      } else if (text[index++] === "]" && --depth === 0) return;
    }
    throw new Error("Swift compiler bracket is incomplete");
  };
  const captures = () => {
    let depth = 1;
    index++;
    while (index < text.length) {
      if (text[index] === '"') quoted();
      else if (text[index] === "[") bracket();
      else if (text[index] === "(") {
        if (++depth > 32)
          throw Error("Swift compiler capture depth exceeds limits");
        index++;
      } else if (text[index++] === ")" && --depth === 0) return;
    }
    throw Error("Swift compiler captures are incomplete");
  };
  const node = (depth: number): SwiftAstNode => {
    if (depth > 256 || ++nodes > 50000 || text[index++] !== "(")
      throw new Error("Swift compiler structure exceeds limits");
    kindPattern.lastIndex = index;
    const kind = kindPattern.exec(text)?.[0];
    if (!kind) throw new Error("Swift compiler node kind is unknown");
    index += kind.length;
    const headers: string[] = [];
    const children: SwiftAstNode[] = [];
    while (index < text.length && text[index] !== ")") {
      const begin = index;
      while (index < text.length) {
        const value = text[index];
        if (value === '"') quoted();
        else if (value === "[") bracket();
        else if (
          value === "(" &&
          text.slice(index - 9, index) === "captures=" &&
          /\s/.test(text[index - 10] ?? "")
        )
          captures();
        else if (value === "(" || value === ")") break;
        else index++;
      }
      headers.push(text.slice(begin, index));
      if (text[index] === "(") children.push(node(depth + 1));
    }
    if (text[index++] !== ")")
      throw new Error("Swift compiler node is incomplete");
    return { kind, header: headers.join(" "), children };
  };
  space();
  const result = node(0);
  space();
  if (index !== text.length || result.kind !== "source_file")
    throw new Error("Swift compiler source roots do not reconcile");
  return result;
}

export interface SwiftAstMethod {
  className: string;
  methodName: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

function sourceRange(header: string, file: string) {
  const prefix = `range=[${file}:`;
  const begin = header.indexOf(prefix);
  if (begin < 0 || header.indexOf(prefix, begin + prefix.length) >= 0)
    throw new Error("Swift declaration source identity differs");
  const value = /^(\d+):(\d+) - line:(\d+):(\d+)\]/.exec(
    header.slice(begin + prefix.length),
  );
  if (!value) throw new Error("Swift declaration range is unavailable");
  const [line, column, endLine, endColumn] = value.slice(1).map(Number);
  if (
    [line, column, endLine, endColumn].some(
      (n) => !Number.isSafeInteger(n) || n! < 1 || n! > 1000000,
    ) ||
    endLine! < line! ||
    (endLine === line && endColumn! < column!)
  )
    throw new Error("Swift declaration range is invalid");
  return {
    line: line!,
    column: column!,
    endLine: endLine!,
    endColumn: endColumn!,
  };
}

export function swiftAstMethods(
  text: string,
  moduleName: string,
  file: string,
): SwiftAstMethod[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(moduleName))
    throw new Error("Swift module identity is unsupported");
  const root = swiftAst(text);
  const source = /^\s*("(?:[^"\\]|\\.)*")\s*$/.exec(root.header);
  if (!source || JSON.parse(source[1]!) !== file)
    throw new Error("Swift physical compiler source differs");
  const methods: SwiftAstMethod[] = [];
  const visit = (node: SwiftAstNode, parents: string[]) => {
    if (node.kind !== "class_decl") {
      for (const child of node.children) visit(child, parents);
      return;
    }
    const name = /\]\s+"([A-Za-z_][A-Za-z0-9_]*)"(?:\s|$)/.exec(
      node.header,
    )?.[1];
    if (!name) throw new Error("Swift class identity is unsupported");
    const names = [...parents, name];
    const bases = /(?:^|\s)inherits="([^"\\]*)"(?:\s|$)/
      .exec(node.header)?.[1]
      ?.split(", ");
    if (
      bases?.some((base) => ["XCTestCase", "XCTest.XCTestCase"].includes(base))
    ) {
      const classRange = sourceRange(node.header, file);
      for (const child of node.children) {
        if (
          child.kind !== "func_decl" ||
          /(?:^|\s)implicit(?:\s|$)/.test(child.header)
        )
          continue;
        const methodName = /\]\s+"([A-Za-z_][A-Za-z0-9_]*)\(\)"(?:\s|$)/.exec(
          child.header,
        )?.[1];
        if (!methodName) continue;
        const range = sourceRange(child.header, file);
        if (
          range.line < classRange.line ||
          range.endLine > classRange.endLine ||
          (range.line === classRange.line &&
            range.column < classRange.column) ||
          (range.endLine === classRange.endLine &&
            range.endColumn > classRange.endColumn)
        )
          throw new Error("Swift callback range escaped its native class");
        methods.push({
          className: [moduleName, ...names].join("."),
          methodName,
          file,
          ...range,
        });
      }
    }
    for (const child of node.children)
      if (child.kind === "class_decl") visit(child, names);
  };
  visit(root, []);
  const identities = methods.map((method) =>
    JSON.stringify([method.className, method.methodName]),
  );
  if (new Set(identities).size !== identities.length)
    throw new Error("Swift compiler methods are ambiguous");
  return methods;
}

export interface SwiftTestingDeclaration {
  module: string;
  name: string;
  file: string;
  line: number;
  column: number;
  endLine: number;
}
/** Bind top-level Testing macros to physical compiler attribute addresses. */
export function swiftAstTesting(
  text: string,
  module: string,
  file: string,
): SwiftTestingDeclaration[] {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(module))
    throw Error("Swift module identity unsupported");
  const root = swiftAst(text),
    source = /^\s*("(?:[^"\\]|\\.)*")\s*$/.exec(root.header);
  if (!source || JSON.parse(source[1]!) !== file)
    throw Error("Swift physical compiler source differs");
  const declarations: SwiftTestingDeclaration[] = [];
  for (const node of root.children) {
    if (
      node.kind !== "func_decl" ||
      /(?:^|\s)implicit(?:\s|$)/.test(node.header)
    )
      continue;
    const attributes = node.children.filter(
      (n) =>
        n.kind === "custom_attr" &&
        /(?:^|\s)macro="Testing\.\(file\)\.Test(?:"|\()/.test(n.header),
    );
    if (!attributes.length) continue;
    if (attributes.length !== 1)
      throw Error("Swift native Testing attributes ambiguous");
    const name =
      /\]\s+"([A-Za-z_][A-Za-z0-9_]*\((?:[A-Za-z_][A-Za-z0-9_]*:)*\))"(?:\s|$)/.exec(
        node.header,
      )?.[1];
    if (!name)
      throw Error("Swift native Testing function identity unsupported");
    const functionRange = sourceRange(node.header, file),
      attributeRange = sourceRange(attributes[0]!.header, file);
    if (
      attributeRange.endLine > functionRange.line ||
      attributeRange.line > functionRange.endLine ||
      (attributeRange.endLine === functionRange.line &&
        attributeRange.endColumn >= functionRange.column)
    )
      throw Error("Swift native Testing attribute range differs");
    declarations.push({
      module,
      name,
      file,
      line: attributeRange.line,
      column: attributeRange.column + 1,
      endLine: functionRange.endLine,
    });
  }
  if (new Set(declarations.map((d) => d.name)).size !== declarations.length)
    throw Error("Swift native Testing names ambiguous");
  return declarations;
}
