import { NuxtAssemblyUnsupported } from "./nuxt-assembly-error.js";
import ts from "typescript";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import type {
  NuxtHandler,
  NuxtAssemblyConfig,
} from "./nuxt-assembly-schema.js";

/** Parse the module Nitro actually generated; do not reconstruct its scanner policy. */
export function nativeHandlerModule(
  code: string,
  sourceLabel: (source: string) => string,
): NuxtHandler[] {
  if (Buffer.byteLength(code) > 512 * 1024)
    throw new NuxtAssemblyUnsupported("Generated handlers exceed 512 KiB");
  const file = ts.createSourceFile(
    "native-handlers.mjs",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  if (
    (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length
  )
    throw new NuxtAssemblyUnsupported("Malformed generated handlers");
  const imports = new Map<string, string>();
  let rows: ts.ArrayLiteralExpression | undefined;
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.name &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      imports.set(
        statement.importClause.name.text,
        sourceLabel(statement.moduleSpecifier.text),
      );
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer)
          throw new NuxtAssemblyUnsupported(
            "Unsupported generated handler declaration",
          );
        const value = declaration.initializer;
        if (
          declaration.name.text === "handlers" &&
          ts.isArrayLiteralExpression(value)
        ) {
          if (rows) throw new NuxtAssemblyUnsupported("Repeated handlers");
          rows = value;
        } else if (
          ts.isArrowFunction(value) &&
          ts.isCallExpression(value.body) &&
          value.body.expression.kind === ts.SyntaxKind.ImportKeyword &&
          value.body.arguments.length === 1 &&
          ts.isStringLiteral(value.body.arguments[0]!)
        )
          imports.set(
            declaration.name.text,
            sourceLabel(value.body.arguments[0]!.text),
          );
        else
          throw new NuxtAssemblyUnsupported(
            "Opaque generated handler declaration",
          );
      }
    else
      throw new NuxtAssemblyUnsupported("Opaque generated handler statement");
  }
  if (!rows || !rows.elements.length || rows.elements.length > 2048)
    throw new NuxtAssemblyUnsupported("Empty or oversized generated handlers");
  return rows.elements.map((row, position) => {
    if (!ts.isObjectLiteralExpression(row) || row.properties.length !== 5)
      throw new NuxtAssemblyUnsupported("Opaque generated handler row");
    const fields = new Map<string, ts.Expression>();
    for (const property of row.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !ts.isIdentifier(property.name) ||
        fields.has(property.name.text)
      )
        throw new NuxtAssemblyUnsupported(
          "Unsupported generated handler property",
        );
      fields.set(property.name.text, property.initializer);
    }
    if (
      [...fields.keys()].some(
        (key) =>
          !["route", "handler", "lazy", "middleware", "method"].includes(key),
      )
    )
      throw new NuxtAssemblyUnsupported("Unknown generated handler property");
    const route = fields.get("route")!,
      handler = fields.get("handler")!,
      method = fields.get("method")!;
    const flag = (key: string) => {
      const v = fields.get(key)!;
      if (
        v.kind !== ts.SyntaxKind.TrueKeyword &&
        v.kind !== ts.SyntaxKind.FalseKeyword
      )
        throw new NuxtAssemblyUnsupported("Opaque handler flag");
      return v.kind === ts.SyntaxKind.TrueKeyword;
    };
    if (
      !ts.isStringLiteral(route) ||
      !ts.isIdentifier(handler) ||
      !imports.has(handler.text) ||
      !(
        ts.isStringLiteral(method) ||
        (ts.isIdentifier(method) && method.text === "undefined")
      )
    )
      throw new NuxtAssemblyUnsupported("Opaque generated handler identity");
    return {
      position,
      route: route.text,
      method: ts.isStringLiteral(method)
        ? (method.text as NuxtHandler["method"])
        : null,
      source: imports.get(handler.text)!,
      lazy: flag("lazy"),
      middleware: flag("middleware"),
    };
  });
}

export function nativeMiddlewareModule(
  code: string,
  sourceLabel: (source: string) => string,
) {
  if (Buffer.byteLength(code) > 512 * 1024)
    throw new NuxtAssemblyUnsupported(
      "Generated app middleware exceed 512 KiB",
    );
  const file = ts.createSourceFile(
      "middleware.mjs",
      code,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    ),
    imports = new Map<string, string>();
  if (
    (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length
  )
    throw new NuxtAssemblyUnsupported("Malformed app middleware");
  let global: string[] | undefined,
    named: { name: string; source: string }[] | undefined;
  function imported(node: ts.Expression): string {
    const calls: string[] = [];
    function visit(n: ts.Node) {
      if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        n.arguments.length === 1 &&
        ts.isStringLiteral(n.arguments[0]!)
      )
        calls.push(n.arguments[0]!.text);
      ts.forEachChild(n, visit);
    }
    visit(node);
    if (calls.length !== 1)
      throw new NuxtAssemblyUnsupported("Opaque named middleware import");
    return sourceLabel(calls[0]!);
  }
  for (const statement of file.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      statement.importClause?.name &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      imports.set(
        statement.importClause.name.text,
        sourceLabel(statement.moduleSpecifier.text),
      );
    else if (ts.isVariableStatement(statement))
      for (const d of statement.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer)
          throw new NuxtAssemblyUnsupported("Opaque middleware declaration");
        if (
          d.name.text === "globalMiddleware" &&
          ts.isArrayLiteralExpression(d.initializer)
        ) {
          if (global)
            throw new NuxtAssemblyUnsupported("Repeated global middleware");
          global = d.initializer.elements.map((e) => {
            if (!ts.isIdentifier(e) || !imports.has(e.text))
              throw new NuxtAssemblyUnsupported("Opaque global middleware");
            return imports.get(e.text)!;
          });
        } else if (
          d.name.text === "namedMiddleware" &&
          ts.isObjectLiteralExpression(d.initializer)
        ) {
          if (named)
            throw new NuxtAssemblyUnsupported("Repeated named middleware");
          named = d.initializer.properties.map((p) => {
            if (
              !ts.isPropertyAssignment(p) ||
              !(ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ||
              !ts.isArrowFunction(p.initializer)
            )
              throw new NuxtAssemblyUnsupported("Opaque named middleware");
            return { name: p.name.text, source: imported(p.initializer) };
          });
        } else
          throw new NuxtAssemblyUnsupported("Opaque app middleware export");
      }
    else throw new NuxtAssemblyUnsupported("Opaque app middleware statement");
  }
  if (
    !global ||
    !named ||
    global.length + named.length > 2048 ||
    new Set(named.map((n) => n.name)).size !== named.length
  )
    throw new NuxtAssemblyUnsupported("Incomplete app middleware");
  return { global, named };
}

/** Native generated declarations plus explicit consumers; no claims about full Vue/client typing. */
export async function checkNativeApiTypes(
  root: string,
  buildDir: string,
  config: NuxtAssemblyConfig,
) {
  const nativePath = path.join(buildDir, "tsconfig.server.json"),
    generatedPath = path.join(buildDir, "types/nitro-routes.d.ts");
  const native = ts.readConfigFile(nativePath, ts.sys.readFile);
  if (native.error)
    throw new NuxtAssemblyUnsupported("Native server type config missing");
  const parsed = ts.parseJsonConfigFileContent(native.config, ts.sys, buildDir);
  if (parsed.errors.length)
    throw new NuxtAssemblyUnsupported("Native server type config malformed");
  const generated = await readFile(generatedPath, "utf8");
  if (!generated.includes("interface InternalApi"))
    throw new NuxtAssemblyUnsupported(
      "Generated native API declarations missing",
    );
  const queryPath = path.join(root, ".__checktrail_native_api_query.ts");
  const queryCollision = await lstat(queryPath).then(
    () => true,
    (error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return false;
      throw error;
    },
  );
  if (queryCollision)
    throw new NuxtAssemblyUnsupported(
      "Native API query path collides with project source",
    );
  const query =
    `import type {InternalApi} from 'nitropack/types';\n` +
    config.expectedApis
      .map(
        (a, i) =>
          `export type NativeContract${i}=InternalApi[${JSON.stringify(a.route)}][${JSON.stringify(a.method)}];`,
      )
      .join("\n");
  const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
  const read = host.readFile,
    exists = host.fileExists,
    source = host.getSourceFile;
  host.readFile = (f) => (f === queryPath ? query : read(f));
  host.fileExists = (f) => f === queryPath || exists(f);
  host.getSourceFile = (f, version, onError, fresh) =>
    f === queryPath
      ? ts.createSourceFile(
          f,
          query,
          typeof version === "object" ? version.languageVersion : version,
          true,
        )
      : source(f, version, onError, fresh);
  const program = ts.createProgram(
    [
      ...parsed.fileNames,
      ...config.consumers.map((f) => path.join(root, f)),
      generatedPath,
      queryPath,
    ],
    { ...parsed.options, noEmit: true },
    host,
  );
  if (program.getSourceFiles().length > 8192)
    throw new NuxtAssemblyUnsupported(
      "Native type program exceeds source limit",
    );
  const checker = program.getTypeChecker(),
    queryFile = program.getSourceFile(queryPath)!;
  let supported = true;
  function shape(
    type: ts.Type,
    depth = 0,
    budget = { remaining: 1024 },
    ancestors = new Set<ts.Type>(),
  ): unknown {
    if (depth > 8 || --budget.remaining < 0 || ancestors.has(type))
      throw new NuxtAssemblyUnsupported(
        "Native API type shape exceeds depth/node limits",
      );
    ancestors.add(type);
    try {
      if (
        type.flags &
        (ts.TypeFlags.Any |
          ts.TypeFlags.Unknown |
          ts.TypeFlags.Never |
          ts.TypeFlags.TypeParameter)
      )
        throw new NuxtAssemblyUnsupported("Native API type shape is opaque");
      const recur = (t: ts.Type) => shape(t, depth + 1, budget, ancestors);
      if (type.flags & ts.TypeFlags.Boolean) return { kind: "boolean" };
      if (
        type.isUnion() &&
        type.types.length === 2 &&
        type.types.every((t) => t.flags & ts.TypeFlags.BooleanLiteral)
      )
        return { kind: "boolean" };
      if (type.isUnionOrIntersection()) {
        if (type.types.length > 64)
          throw new NuxtAssemblyUnsupported(
            "Native API union exceeds member limit",
          );
        return {
          kind: type.isUnion() ? "union" : "intersection",
          members: type.types
            .map(recur)
            .sort((a, b) =>
              JSON.stringify(a) < JSON.stringify(b)
                ? -1
                : JSON.stringify(a) > JSON.stringify(b)
                  ? 1
                  : 0,
            ),
        };
      }
      for (const [flag, kind] of [
        [ts.TypeFlags.String, "string"],
        [ts.TypeFlags.Number, "number"],
        [ts.TypeFlags.Null, "null"],
        [ts.TypeFlags.Undefined, "undefined"],
        [ts.TypeFlags.Void, "void"],
      ] as const)
        if (type.flags & flag) return { kind };
      if (type.isStringLiteral() || type.isNumberLiteral())
        return { kind: "literal", value: type.value };
      if (type.flags & ts.TypeFlags.BooleanLiteral)
        return {
          kind: "literal",
          value: checker.typeToString(type) === "true",
        };
      if (checker.isTupleType(type))
        throw new NuxtAssemblyUnsupported(
          "Native API tuples are outside the selected shape profile",
        );
      if (checker.isArrayType(type)) {
        const arguments_ = checker.getTypeArguments(type as ts.TypeReference);
        if (arguments_.length !== 1)
          throw new NuxtAssemblyUnsupported("Opaque native array type");
        return { kind: "array", items: recur(arguments_[0]!) };
      }
      if (type.flags & ts.TypeFlags.Object) {
        const properties = checker.getPropertiesOfType(type),
          indexes = checker.getIndexInfosOfType(type);
        if (
          properties.length > 64 ||
          indexes.length > 2 ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Call).length ||
          checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length
        )
          throw new NuxtAssemblyUnsupported(
            "Opaque or oversized native object type",
          );
        return {
          kind: "object",
          properties: properties
            .map((p) => {
              if (p.name.length > 256 || p.name.startsWith("__@"))
                throw new NuxtAssemblyUnsupported(
                  "Opaque native property name",
                );
              return {
                name: p.name,
                optional: Boolean(p.flags & ts.SymbolFlags.Optional),
                type: recur(checker.getTypeOfSymbolAtLocation(p, queryFile)),
              };
            })
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
          indexes: indexes
            .map((i) => ({
              key: recur(i.keyType),
              readonly: i.isReadonly,
              type: recur(i.type),
            }))
            .sort((a, b) =>
              JSON.stringify(a) < JSON.stringify(b)
                ? -1
                : JSON.stringify(a) > JSON.stringify(b)
                  ? 1
                  : 0,
            ),
        };
      }
      throw new NuxtAssemblyUnsupported(
        "Native API type is outside the selected shape profile",
      );
    } finally {
      ancestors.delete(type);
    }
  }
  const apis = queryFile.statements
    .filter(ts.isTypeAliasDeclaration)
    .map((declaration, i) => {
      const type = checker.getTypeAtLocation(declaration);
      let formatted: string;
      try {
        formatted = JSON.stringify(shape(type));
      } catch (error) {
        if (!(error instanceof NuxtAssemblyUnsupported)) throw error;
        supported = false;
        formatted = "unsupported";
      }
      if (formatted.length > 4096) supported = false;
      return { ...config.expectedApis[i]!, type: formatted };
    });
  if (
    apis.length !== config.expectedApis.length ||
    !program.getSourceFile(generatedPath) ||
    config.consumers.some((f) => !program.getSourceFile(path.join(root, f)))
  )
    throw new NuxtAssemblyUnsupported("Native type roots were not loaded");
  const selected = new Set(
      config.expectedApis.map((a) => JSON.stringify([a.route, a.method])),
    ),
    consumed = new Set<string>();
  const queryAlias = queryFile.statements.find(ts.isTypeAliasDeclaration)!;
  const queryIndex = queryAlias.type as ts.IndexedAccessTypeNode;
  const queryBase = (queryIndex.objectType as ts.IndexedAccessTypeNode)
    .objectType as ts.TypeReferenceNode;
  const target = (node: ts.EntityName) => {
    const symbol = checker.getSymbolAtLocation(node);
    return (
      symbol &&
      (symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol)
    );
  };
  const nativeApi = target(queryBase.typeName);
  if (!nativeApi)
    throw new NuxtAssemblyUnsupported("Native API interface symbol missing");
  for (const consumer of config.consumers) {
    let reached = false;
    function visit(node: ts.Node) {
      if (
        ts.isIndexedAccessTypeNode(node) &&
        ts.isIndexedAccessTypeNode(node.objectType) &&
        ts.isTypeReferenceNode(node.objectType.objectType) &&
        target(node.objectType.objectType.typeName) === nativeApi &&
        ts.isLiteralTypeNode(node.indexType) &&
        ts.isStringLiteral(node.indexType.literal) &&
        ts.isLiteralTypeNode(node.objectType.indexType) &&
        ts.isStringLiteral(node.objectType.indexType.literal)
      ) {
        const key = JSON.stringify([
          node.objectType.indexType.literal.text,
          node.indexType.literal.text,
        ]);
        if (selected.has(key)) {
          consumed.add(key);
          reached = true;
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(program.getSourceFile(path.join(root, consumer))!);
    if (!reached)
      throw new NuxtAssemblyUnsupported(
        "Selected consumer does not reference a native generated API type",
      );
  }
  if (consumed.size !== selected.size)
    throw new NuxtAssemblyUnsupported(
      "Selected generated API consumer participation is incomplete",
    );
  const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => d.code);
  if (diagnostics.length > 256)
    throw new NuxtAssemblyUnsupported("Native type diagnostics exceed limit");
  return {
    compilerVersion: "6.0.3" as const,
    consumers: config.consumers,
    generated: true as const,
    supported,
    apis,
    diagnostics,
    sourceFiles: program.getSourceFiles().length,
  };
}
