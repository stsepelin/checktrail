import { captureVbBindings, type VbSyntaxUnit } from "./review-vb-bindings.js";
import { resolveVbBindings } from "./review-vb-resolution.js";
import {
  captureSwiftBindings,
  type SwiftSyntaxUnit,
  type SwiftModuleRoot,
} from "./review-swift-bindings.js";
import { resolveSwiftBindings } from "./review-swift-resolution.js";
import {
  captureRubyBindings,
  type RubySyntaxUnit,
} from "./review-ruby-bindings.js";
import { resolveRubyBindings } from "./review-ruby-resolution.js";
import {
  captureFsharpBindings,
  type FsharpSyntaxUnit,
} from "./review-fsharp-bindings.js";
import { resolveFsharpBindings } from "./review-fsharp-resolution.js";
import {
  captureCsharpBindings,
  type CsharpSyntaxUnit,
} from "./review-csharp-bindings.js";
import { resolveCsharpBindings } from "./review-csharp-resolution.js";
import {
  captureScalaBindings,
  type ScalaSyntaxUnit,
} from "./review-scala-bindings.js";
import { resolveScalaBindings } from "./review-scala-resolution.js";
import {
  captureKotlinBindings,
  type KotlinSyntaxUnit,
} from "./review-kotlin-bindings.js";
import { resolveKotlinBindings } from "./review-kotlin-resolution.js";
import {
  captureJavaBindings,
  type JavaSyntaxUnit,
} from "./review-java-bindings.js";
import { resolveJavaBindings } from "./review-java-resolution.js";
import {
  captureRustBindings,
  type RustSyntaxUnit,
} from "./review-rust-bindings.js";
import { resolveRustBindings } from "./review-rust-resolution.js";
import {
  capturePhpBindings,
  type PhpSyntaxUnit,
} from "./review-php-bindings.js";
import { resolvePhpBindings } from "./review-php-resolution.js";
import {
  captureGoBindings,
  type GoSyntaxUnit,
  type GoModuleRoot,
} from "./review-go-bindings.js";
import { resolveGoBindings } from "./review-go-resolution.js";
import {
  capturePythonBindings,
  type PythonSyntaxUnit,
} from "./review-python-bindings.js";
import { resolvePythonBindings } from "./review-python-resolution.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { Parser, Language, Node, Tree } from "web-tree-sitter";
import { collectReviewBehavior } from "./review-behavior.js";
import { reviewChanges } from "./review-diff.js";
import {
  reviewPolyglotBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import {
  grammarManifestDigest,
  grammarRuntimeAssets,
} from "./review-grammar-assets.js";

type Source = { path: string; sha256: string; content: string };
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesHash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const languages = new Map<string, Promise<Language>>();
let initialization: Promise<typeof import("web-tree-sitter")> | undefined;
async function runtime() {
  initialization ??= (async () => {
    const moduleURL = import.meta.resolve("web-tree-sitter");
    const code = await readFile(new URL(moduleURL));
    const wasm = await readFile(
      new URL(import.meta.resolve("web-tree-sitter/web-tree-sitter.wasm")),
    );
    for (const [bytes, expected] of [
      [code, grammarRuntimeAssets["web-tree-sitter.js"]],
      [wasm, grammarRuntimeAssets["web-tree-sitter.wasm"]],
    ] as const) {
      if (
        bytes.length !== expected.bytes ||
        bytesHash(bytes) !== expected.sha256
      )
        throw new Error("Syntax runtime identity differs");
    }
    const module = await import("web-tree-sitter");
    await module.Parser.init({ wasmBinary: wasm });
    return module;
  })();
  return initialization;
}
const functions = new Set([
  "function_definition",
  "function_declaration",
  "method_declaration",
  "function_item",
  "method",
  "singleton_method",
  "local_function_statement",
  "constructor_declaration",
  "init_declaration",
  "anonymous_function",
  "arrow_function",
  "lambda",
  "closure_expression",
  "lambda_literal",
  "lambda_expression",
  "function_or_value_defn",
]);
const declarations = new Map<
  string,
  ReviewBehavior["declarations"][number]["kind"]
>([
  ...[
    "class_definition",
    "class_declaration",
    "class",
    "struct_item",
    "struct_declaration",
    "record_declaration",
    "trait_declaration",
  ].map((t) => [t, "class"] as const),
  ...["interface_declaration", "trait_item", "protocol_declaration"].map(
    (t) => [t, "interface"] as const,
  ),
  ...[
    "type_alias_declaration",
    "typealias_declaration",
    "type_item",
    "type_definition",
    "type_declaration",
  ].map((t) => [t, "type"] as const),
  ...["enum_declaration", "enum_item"].map((t) => [t, "enum"] as const),
  ...[
    "assignment",
    "let_declaration",
    "variable_declarator",
    "property_declaration",
    "val_definition",
    "var_definition",
    "val_declaration",
    "var_declaration",
    "short_var_declaration",
    "const_spec",
    "var_spec",
    "init_declarator",
    "value_declaration",
    "const_item",
    "static_item",
    "const_element",
    "function_or_value_defn",
  ].map((t) => [t, "variable"] as const),
  ...[
    "field_declaration",
    "attribute",
    "block_mapping_pair",
    "flow_pair",
    "block",
  ].map((t) => [t, "property"] as const),
  ...[
    "parameter",
    "default_parameter",
    "typed_default_parameter",
    "simple_parameter",
    "property_promotion_parameter",
    "optional_parameter",
    "keyword_parameter",
    "parameter_declaration",
    "formal_parameter",
    "class_parameter",
    "optional_parameter_declaration",
    "optional_parameter",
    "parameter_with_optional_type",
  ].map((t) => [t, "parameter"] as const),
  ...[
    "import_statement",
    "import_from_statement",
    "import_declaration",
    "import_header",
    "use_declaration",
    "namespace_use_declaration",
    "preproc_include",
  ].map((t) => [t, "import"] as const),
]);
const calls = new Set([
  "call",
  "call_expression",
  "function_call_expression",
  "member_call_expression",
  "nullsafe_member_call_expression",
  "scoped_call_expression",
  "method_invocation",
  "invocation_expression",
  "function_call",
  "application_expression",
]);
const decisions = new Set([
  "if_statement",
  "if_expression",
  "conditional_expression",
  "conditional",
  "ternary_expression",
  "match_expression",
  "match_statement",
  "switch_statement",
  "switch_expression",
  "when_expression",
  "case_statement",
  "binary_operator",
  "binary_expression",
  "comparison_operator",
  "boolean_operator",
  "attribute",
  "block_mapping_pair",
  "flow_pair",
  "block",
]);

export { selectedGrammar } from "./review-grammar-profile.js";
import { selectedGrammar } from "./review-grammar-profile.js";
async function language(
  grammar: NonNullable<ReturnType<typeof selectedGrammar>>,
) {
  let loaded = languages.get(grammar.grammar);
  if (!loaded) {
    loaded = (async () => {
      const { Language } = await runtime();
      const bytes = await readFile(
        new URL(
          "../../assets/" +
            (grammar.grammar === "vbnet"
              ? "context-vb-grammar"
              : "context-grammars") +
            "/" +
            grammar.file,
          import.meta.url,
        ),
      );
      if (bytes.length !== grammar.bytes || bytesHash(bytes) !== grammar.sha256)
        throw new Error("Grammar asset identity differs");
      return Language.load(bytes);
    })();
    languages.set(grammar.grammar, loaded);
    loaded.catch(() => languages.delete(grammar.grammar));
  }
  return loaded;
}
const field = (node: Node, ...names: string[]) =>
  names
    .map((name) => node.childForFieldName(name))
    .find((node): node is Node => node !== null);
const nameNode = (node: Node): Node | undefined => {
  const named = field(node, "name", "left", "pattern", "declarator", "key");
  if (named) {
    if (
      named.type.endsWith("declarator") ||
      named.type.endsWith("declaration_left")
    )
      return nameNode(named);
    return named;
  }
  const nested = node.namedChildren.find((child) =>
    [
      "function_declaration_left",
      "value_declaration_left",
      "variable_declaration",
    ].includes(child.type),
  );
  if (nested) return nameNode(nested);
  return node.namedChildren.find((child) =>
    [
      "identifier",
      "simple_identifier",
      "name",
      "variable_name",
      "property_identifier",
      "type_identifier",
      "function_declaration_left",
      "value_declaration_left",
    ].includes(child.type),
  );
};
const name = (node: Node): string | null => {
  const value = nameNode(node)?.text;
  return value && value.length <= 256 ? value : null;
};
const isFunction = (node: Node) =>
  functions.has(node.type) &&
  (node.type !== "function_or_value_defn" ||
    node.namedChildren.some(
      (child) =>
        child.type === "function_declaration_left" &&
        child.namedChildren.some((part) => part.type === "argument_patterns"),
    ));
function initializer(node: Node, kind: string) {
  if (kind === "function") return undefined;
  const explicit = field(
    node,
    "value",
    "default",
    "default_value",
    "right",
    ...(kind === "variable" && node.type === "function_or_value_defn"
      ? ["body"]
      : []),
  );
  if (explicit) return explicit;
  const equal = node.children.findIndex((child) => child.text === "=");
  if (equal >= 0)
    return node.children.slice(equal + 1).find((child) => child.isNamed);
  if (kind === "parameter" && node.nextSibling?.text === "=")
    return node.nextSibling.nextNamedSibling ?? undefined;
  return undefined;
}
const importTypes = new Set([
  "import_statement",
  "import_from_statement",
  "import_declaration",
  "import_header",
  "use_declaration",
  "namespace_use_declaration",
  "preproc_include",
]);
function importSpecifier(node: Node): string | null {
  const part =
    field(node, "module_name", "path", "source") ??
    node.namedChildren.find((child) =>
      [
        "string_literal",
        "interpreted_string_literal",
        "raw_string_literal",
        "dotted_name",
        "scoped_identifier",
        "scoped_use_list",
        "identifier",
        "system_lib_string",
      ].includes(child.type),
    );
  if (!part || part.text.length > 1024) return null;
  const text = part.text;
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  }
  if (text.startsWith("'") && text.endsWith("'") && !text.includes("\\"))
    return text.slice(1, -1);
  return [
    "dotted_name",
    "scoped_identifier",
    "scoped_use_list",
    "identifier",
  ].includes(part.type)
    ? text
    : null;
}
function lineTable(content: string) {
  const starts = [
    0,
    ...[...content.matchAll(/\r\n|\r|\n|\u2028|\u2029/g)].map(
      (match) => match.index + match[0].length,
    ),
  ];
  return (offset: number) => {
    let lower = 0,
      upper = starts.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (starts[middle]! <= offset) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  };
}

/** Fixed bundled parsers receive captured strings; no project host, imports or code is executed. */
async function collectReviewPolyglotCore(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  pythonRoots?: string[],
  goRoots?: GoModuleRoot[],
  phpRoots?: string[],
  rustRoots?: string[],
  javaRoots?: string[],
  kotlinRoots?: string[],
  scalaRoots?: string[],
  csharpRoots?: string[],
  fsharpRoots?: string[],
  rubyRoots?: string[],
  swiftRoots?: SwiftModuleRoot[],
  vbRoots?: string[],
): Promise<ReviewBehavior> {
  const result = reviewPolyglotBehaviorSchema.parse({
    ...(await collectReviewBehavior(current, base, primary, diff, 64)),
    profile: "selected-syntax-v1",
    parser: "typescript-and-tree-sitter-wasm",
    parserVersion: "6.0.3/0.27.0",
    grammarManifestDigest,
    grammarBindings: [],
    decisions: [],
  });
  const changes = diff
    ? reviewChanges(
        base,
        current,
        [...new Set([...base, ...current].map((source) => source.path))].sort(),
      )
    : [];
  const pythonUnits: PythonSyntaxUnit[] = [];
  const goUnits: GoSyntaxUnit[] = [];
  const phpUnits: PhpSyntaxUnit[] = [];
  const rustUnits: RustSyntaxUnit[] = [];
  const javaUnits: JavaSyntaxUnit[] = [];
  const kotlinUnits: KotlinSyntaxUnit[] = [];
  const scalaUnits: ScalaSyntaxUnit[] = [];
  const csharpUnits: CsharpSyntaxUnit[] = [];
  const fsharpUnits: FsharpSyntaxUnit[] = [];
  const rubyUnits: RubySyntaxUnit[] = [];
  const swiftUnits: SwiftSyntaxUnit[] = [];
  const vbUnits: VbSyntaxUnit[] = [];
  const bindings = new Set<string>();
  let nodesVisited = 0;
  for (const [revision, sources] of [
    ["base", base],
    ["current", current],
  ] as const)
    for (const source of sources) {
      const asset = selectedGrammar(source.path, vbRoots !== undefined);
      if (!asset) continue;
      const record = result.files.find(
        (record) => record.revision === revision && record.file === source.path,
      )!;
      let parser: Parser | undefined,
        tree: Tree | null = null;
      try {
        const loaded = await language(asset);
        const { Parser } = await runtime();
        parser = new Parser();
        parser.setLanguage(loaded);
        const started = performance.now();
        tree = parser.parse(source.content, null, {
          progressCallback: () => performance.now() - started > 1000,
        });
        if (!tree) {
          record.state = "budget-exhausted";
          continue;
        }
        if (tree.rootNode.hasError) {
          record.state = "malformed";
          continue;
        }
        const nodes: Node[] = [];
        const stack = [{ node: tree.rootNode, depth: 0 }];
        while (stack.length) {
          const { node, depth } = stack.pop()!;
          if (depth > 128 || ++nodesVisited > 20000) throw new Error("budget");
          nodes.push(node);
          for (const child of node.namedChildren.toReversed())
            stack.push({ node: child, depth: depth + 1 });
        }
        const line = lineTable(source.content);
        const range = (node: Node) => ({
          revision,
          file: source.path,
          start: node.startIndex,
          end: node.endIndex,
          startLine: line(node.startIndex),
          endLine: line(Math.max(node.startIndex, node.endIndex - 1)),
        });
        const output = {
          functions: [] as ReviewBehavior["functions"],
          declarations: [] as ReviewBehavior["declarations"],
          calls: [] as ReviewBehavior["calls"],
          decisions: [] as typeof result.decisions,
          modules: [] as ReviewBehavior["modules"],
        };
        const decls = new Map<number, ReviewBehavior["declarations"][number]>();
        for (const node of nodes) {
          const kind =
            vbRoots &&
            asset.grammar === "vbnet" &&
            node.type === "module_declaration"
              ? "class"
              : isFunction(node)
                ? "function"
                : (declarations.get(node.type) ??
                  (scalaRoots &&
                  asset.grammar === "scala" &&
                  node.type === "object_definition"
                    ? ("class" as const)
                    : undefined));
          if (!kind || node.startIndex >= node.endIndex) continue;
          const address = range(node),
            initial = initializer(node, kind);
          if (
            kind === "parameter" &&
            initial &&
            initial.endIndex > address.end
          ) {
            address.end = initial.endIndex;
            address.endLine = line(initial.endIndex - 1);
          }
          const declaration = {
            ...address,
            id: hash([
              "declaration",
              revision,
              source.path,
              address.start,
              address.end,
              kind,
            ]),
            name: name(node),
            kind,
            initializer: initial
              ? { start: initial.startIndex, end: initial.endIndex }
              : null,
          };
          output.declarations.push(declaration);
          decls.set(node.id, declaration);
        }
        const fnIds = new Map<number, string>();
        for (const node of nodes.filter(isFunction)) {
          const address = range(node),
            id = hash([
              "function",
              revision,
              source.path,
              address.start,
              address.end,
            ]);
          fnIds.set(node.id, id);
          const enclosingDeclarations = [];
          for (let parent = node.parent; parent; parent = parent.parent) {
            const decl = decls.get(parent.id);
            if (decl) enclosingDeclarations.push(decl.id);
          }
          const change = changes.find((change) => change.path === source.path);
          const overlapsChange = diff
            ? (change?.hunks.some((hunk) => {
                const start =
                  revision === "base"
                    ? hunk.beforeStartLine
                    : hunk.afterStartLine;
                const count =
                  revision === "base"
                    ? hunk.beforeLineCount
                    : hunk.afterLineCount;
                return (
                  count > 0 &&
                  address.startLine < start + count &&
                  address.endLine >= start
                );
              }) ?? false)
            : null;
          output.functions.push({
            ...address,
            id,
            name: name(node),
            kind:
              node.type.includes("constructor") ||
              node.type === "init_declaration"
                ? "constructor"
                : node.type.includes("method")
                  ? "method"
                  : node.type.includes("lambda") || node.type.includes("arrow")
                    ? "arrow"
                    : "function",
            declarationId: decls.get(node.id)?.id ?? null,
            enclosingDeclarations,
            overlapsChange,
          });
        }
        for (const node of nodes) {
          if (importTypes.has(node.type)) {
            const specifier = importSpecifier(node);
            output.modules.push({
              ...range(node),
              kind: "import",
              specifier,
              targetFile: null,
              resolution: specifier === null ? "dynamic" : "external",
            });
          }
          if (
            (decisions.has(node.type) ||
              (rubyRoots &&
                asset.grammar === "ruby" &&
                [
                  "if",
                  "elsif",
                  "unless",
                  "if_modifier",
                  "unless_modifier",
                  "conditional",
                  "binary",
                  "case",
                  "case_match",
                  "when",
                  "while",
                  "until",
                  "while_modifier",
                  "until_modifier",
                  "for",
                ].includes(node.type)) ||
              (fsharpRoots &&
                asset.grammar === "fsharp" &&
                node.type === "infix_expression") ||
              (scalaRoots &&
                asset.grammar === "scala" &&
                node.type === "infix_expression") ||
              (kotlinRoots &&
                asset.grammar === "kotlin" &&
                [
                  "comparison_expression",
                  "equality_expression",
                  "conjunction_expression",
                  "disjunction_expression",
                  "elvis_expression",
                ].includes(node.type))) &&
            node.startIndex < node.endIndex
          ) {
            const address = range(node);
            output.decisions.push({
              ...address,
              id: hash([
                "decision",
                revision,
                source.path,
                address.start,
                address.end,
                node.type,
              ]),
              nodeType: node.type,
            });
          }
          const javaConstructor =
            javaRoots !== undefined &&
            asset.grammar === "java" &&
            node.type === "object_creation_expression";
          const scalaConstructor =
            scalaRoots !== undefined &&
            asset.grammar === "scala" &&
            node.type === "instance_expression";
          const csharpConstructor =
            csharpRoots !== undefined &&
            asset.grammar === "c_sharp" &&
            [
              "object_creation_expression",
              "implicit_object_creation_expression",
            ].includes(node.type);
          if (
            (!calls.has(node.type) &&
              !(
                vbRoots &&
                asset.grammar === "vbnet" &&
                [
                  "array_access_expression",
                  "generic_invocation_expression",
                ].includes(node.type)
              ) &&
              !javaConstructor &&
              !scalaConstructor &&
              !csharpConstructor) ||
            node.startIndex >= node.endIndex
          )
            continue;
          let callerFunctionId: string | null = null;
          for (let parent = node.parent; parent; parent = parent.parent)
            if (fnIds.has(parent.id)) {
              callerFunctionId = fnIds.get(parent.id)!;
              break;
            }
          output.calls.push({
            ...range(node),
            callerFunctionId,
            targetFunctionId: null,
            kind:
              javaConstructor || scalaConstructor || csharpConstructor
                ? "construct"
                : "call",
            optional: node.type === "nullsafe_member_call_expression",
            resolution: "unsupported-dispatch",
          });
        }
        const vbUnit =
          vbRoots && asset.grammar === "vbnet"
            ? captureVbBindings(nodes, fnIds, decls, range)
            : undefined;
        const swiftUnit =
          swiftRoots && asset.grammar === "swift"
            ? captureSwiftBindings(nodes, fnIds, decls, range)
            : undefined;
        const rubyUnit =
          rubyRoots && asset.grammar === "ruby"
            ? captureRubyBindings(nodes, fnIds, decls, range)
            : undefined;
        if (rubyUnit)
          for (const call of rubyUnit.calls.filter((call) => call.bare))
            output.calls.push({
              revision: call.revision,
              file: call.file,
              start: call.start,
              end: call.end,
              startLine: call.startLine,
              endLine: call.endLine,
              callerFunctionId: call.caller,
              targetFunctionId: null,
              kind: "call",
              optional: false,
              resolution: "unsupported-dispatch",
            });
        if (
          result.functions.length + output.functions.length > 1024 ||
          result.declarations.length + output.declarations.length > 4096 ||
          result.calls.length + output.calls.length > 4096 ||
          result.decisions.length + output.decisions.length > 4096 ||
          result.modules.length + output.modules.length > 512 ||
          Buffer.byteLength(
            JSON.stringify({
              ...result,
              functions: [...result.functions, ...output.functions],
              declarations: [...result.declarations, ...output.declarations],
              calls: [...result.calls, ...output.calls],
              decisions: [...result.decisions, ...output.decisions],
              modules: [...result.modules, ...output.modules],
            }),
          ) >
            256 * 1024
        )
          throw new Error("budget");
        result.functions.push(...output.functions);
        result.declarations.push(...output.declarations);
        result.calls.push(...output.calls);
        result.decisions.push(...output.decisions);
        result.modules.push(...output.modules);
        record.state = "collected";
        if (rubyUnit) rubyUnits.push(rubyUnit);
        if (swiftUnit) swiftUnits.push(swiftUnit);
        if (vbUnit) vbUnits.push(vbUnit);
        if (pythonRoots && asset.grammar === "python")
          pythonUnits.push(capturePythonBindings(nodes, fnIds, decls, range));
        if (
          fsharpRoots &&
          ["fsharp", "fsharp_signature"].includes(asset.grammar)
        )
          fsharpUnits.push(captureFsharpBindings(nodes, fnIds, decls, range));
        if (csharpRoots && asset.grammar === "c_sharp")
          csharpUnits.push(captureCsharpBindings(nodes, fnIds, decls, range));
        if (scalaRoots && asset.grammar === "scala")
          scalaUnits.push(captureScalaBindings(nodes, fnIds, decls, range));
        if (kotlinRoots && asset.grammar === "kotlin")
          kotlinUnits.push(captureKotlinBindings(nodes, fnIds, decls, range));
        if (javaRoots && asset.grammar === "java")
          javaUnits.push(captureJavaBindings(nodes, fnIds, decls, range));
        if (rustRoots && asset.grammar === "rust")
          rustUnits.push(captureRustBindings(nodes, fnIds, decls, range));
        if (phpRoots && asset.grammar === "php")
          phpUnits.push(capturePhpBindings(nodes, fnIds, decls, range));
        if (goRoots && asset.grammar === "go")
          goUnits.push(captureGoBindings(nodes, fnIds, decls, range));
        if (!bindings.has(asset.grammar)) {
          result.grammarBindings.push({
            grammar: asset.grammar,
            sourceCommit: asset.sourceCommit,
            wasmSha256: asset.sha256,
          });
          bindings.add(asset.grammar);
        }
      } catch (error) {
        record.state =
          error instanceof Error && error.message === "budget"
            ? "budget-exhausted"
            : "error";
      } finally {
        tree?.delete();
        parser?.delete();
      }
    }
  result.state = result.files.every((file) => file.state === "collected")
    ? "collected"
    : "partial";
  result.grammarBindings.sort((a, b) =>
    a.grammar.localeCompare(b.grammar, "en"),
  );
  if (vbRoots) return resolveVbBindings(result, vbUnits, vbRoots, primary);
  if (swiftRoots)
    return resolveSwiftBindings(result, swiftUnits, swiftRoots, primary);
  if (rubyRoots)
    return resolveRubyBindings(result, rubyUnits, rubyRoots, primary);
  if (fsharpRoots)
    return resolveFsharpBindings(result, fsharpUnits, fsharpRoots, primary);
  if (csharpRoots)
    return resolveCsharpBindings(result, csharpUnits, csharpRoots, primary);
  if (scalaRoots)
    return resolveScalaBindings(result, scalaUnits, scalaRoots, primary);
  if (kotlinRoots)
    return resolveKotlinBindings(result, kotlinUnits, kotlinRoots, primary);
  if (javaRoots)
    return resolveJavaBindings(result, javaUnits, javaRoots, primary);
  if (rustRoots)
    return resolveRustBindings(result, rustUnits, rustRoots, primary);
  if (phpRoots) return resolvePhpBindings(result, phpUnits, phpRoots, primary);
  if (goRoots)
    return resolveGoBindings(
      result,
      goUnits,
      goRoots,
      primary,
      current,
      base,
      diff,
    );
  return pythonRoots
    ? resolvePythonBindings(result, pythonUnits, pythonRoots, primary)
    : reviewPolyglotBehaviorSchema.parse(result);
}

export async function collectReviewPolyglotBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
): Promise<Extract<ReviewBehavior, { profile: "selected-syntax-v1" }>> {
  return reviewPolyglotBehaviorSchema.parse(
    await collectReviewPolyglotCore(current, base, primary, diff),
  );
}
export async function collectReviewPythonBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<
  Extract<ReviewBehavior, { profile: "python-selected-bindings-v1" }>
> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewPythonBehaviorSchema.parse(
    await collectReviewPolyglotCore(current, base, primary, diff, roots),
  );
}

export async function collectReviewGoBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: GoModuleRoot[],
): Promise<Extract<ReviewBehavior, { profile: "go-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewGoBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewPhpBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<Extract<ReviewBehavior, { profile: "php-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewPhpBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewRustBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<Extract<ReviewBehavior, { profile: "rust-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewRustBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewJavaBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<Extract<ReviewBehavior, { profile: "java-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewJavaBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewKotlinBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<
  Extract<ReviewBehavior, { profile: "kotlin-selected-bindings-v1" }>
> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewKotlinBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewScalaBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<Extract<ReviewBehavior, { profile: "scala-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewScalaBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewCsharpBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<
  Extract<ReviewBehavior, { profile: "csharp-selected-bindings-v1" }>
> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewCsharpBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewFsharpBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<
  Extract<ReviewBehavior, { profile: "fsharp-selected-bindings-v1" }>
> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewFsharpBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewRubyBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<Extract<ReviewBehavior, { profile: "ruby-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewRubyBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewSwiftBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: SwiftModuleRoot[],
): Promise<Extract<ReviewBehavior, { profile: "swift-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewSwiftBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}

export async function collectReviewVbBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
  roots: string[],
): Promise<Extract<ReviewBehavior, { profile: "vb-selected-bindings-v1" }>> {
  return (
    await import("./review-behavior-schema.js")
  ).reviewVbBehaviorSchema.parse(
    await collectReviewPolyglotCore(
      current,
      base,
      primary,
      diff,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      roots,
    ),
  );
}
