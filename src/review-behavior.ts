import { createHash } from "node:crypto";
import path from "node:path";
import type ts from "typescript";
import {
  reviewBehaviorSchema,
  type ReviewBehavior,
} from "./review-behavior-schema.js";
import { reviewChanges } from "./review-diff.js";

type Source = { path: string; sha256: string; content: string };
type Revision = "base" | "current";
type FunctionNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;
const virtualRoot = "/checktrail-captured-source";
const supported = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const omissions: ReviewBehavior["omissions"] = [
  "unselected-files",
  "runtime-dispatch",
  "runtime-rebinding",
  "project-module-resolution",
  "framework-assembly",
  "non-js-ts-semantics",
];
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const empty = () =>
  ({
    functions: [],
    declarations: [],
    calls: [],
    references: [],
    modules: [],
  }) as Pick<
    ReviewBehavior,
    "functions" | "declarations" | "calls" | "references" | "modules"
  >;

export async function collectReviewBehavior(
  current: Source[],
  base: Source[],
  primary: string[],
  diff: boolean,
): Promise<ReviewBehavior> {
  // Only this explicit profile loads the bundled parser. No consumer parser,
  // config, plugin, filesystem host, emit or project code participates.
  const ts = (await import("typescript")).default;
  if (ts.version !== "6.0.3")
    throw new Error("Unsupported review parser version");
  const result: ReviewBehavior = {
    profile: "js-ts-syntax-v1",
    parser: "typescript",
    parserVersion: "6.0.3",
    state: "collected",
    reachabilityVerified: false,
    files: [],
    ...empty(),
    omissions,
  };
  const changes = diff
    ? reviewChanges(
        base,
        current,
        [...new Set([...base, ...current].map((file) => file.path))].sort(),
      )
    : [];
  for (const [revision, sources] of [
    ["base", base],
    ["current", current],
  ] as const) {
    const records: ReviewBehavior["files"] = sources.map((file) => ({
      revision,
      file: file.path,
      sha256: file.sha256,
      role: primary.includes(file.path)
        ? ("primary" as const)
        : ("support" as const),
      state: supported.test(file.path)
        ? ("collected" as const)
        : ("unsupported" as const),
    }));
    result.files.push(...records);
    const output = empty();
    try {
      const sourceMap = new Map(
        sources
          .filter((file) => supported.test(file.path))
          .map((file) => [path.posix.join(virtualRoot, file.path), file]),
      );
      const ast = new Map<string, ts.SourceFile>();
      const nodes: ts.Node[] = [];
      const walk = (file: ts.SourceFile) => {
        const stack = [{ node: file as ts.Node, depth: 0 }];
        while (stack.length) {
          const { node, depth } = stack.pop()!;
          if (depth > 128 || nodes.length >= 20000) throw new Error("budget");
          nodes.push(node);
          ts.forEachChild(node, (child) => {
            stack.push({ node: child, depth: depth + 1 });
          });
        }
      };
      for (const [name, source] of sourceMap) {
        const kind = /\.tsx$/i.test(name)
          ? ts.ScriptKind.TSX
          : /\.jsx$/i.test(name)
            ? ts.ScriptKind.JSX
            : /\.[cm]?js$/i.test(name)
              ? ts.ScriptKind.JS
              : ts.ScriptKind.TS;
        const file = ts.createSourceFile(
          name,
          source.content,
          ts.ScriptTarget.Latest,
          true,
          kind,
        );
        ast.set(name, file);
      }
      const resolve = (specifier: string, containing: string) => {
        if (!specifier.startsWith("./") && !specifier.startsWith("../"))
          return { resolution: "external" as const, targetFile: null };
        const relative = path.posix.relative(
          virtualRoot,
          path.posix.resolve(path.posix.dirname(containing), specifier),
        );
        if (relative === ".." || relative.startsWith("../"))
          return { resolution: "outside-root" as const, targetFile: null };
        const extensions = [
          ".ts",
          ".tsx",
          ".js",
          ".jsx",
          ".mts",
          ".cts",
          ".mjs",
          ".cjs",
          ".d.ts",
          ".d.mts",
          ".d.cts",
        ];
        const alternatives = /\.(?:[cm]?js|jsx)$/i.test(relative)
          ? [
              relative,
              relative.replace(/\.js$/i, ".ts"),
              relative.replace(/\.js$/i, ".tsx"),
              relative.replace(/\.js$/i, ".d.ts"),
              relative.replace(/\.jsx$/i, ".tsx"),
              relative.replace(/\.jsx$/i, ".ts"),
              relative.replace(/\.jsx$/i, ".d.ts"),
              relative.replace(/\.mjs$/i, ".mts"),
              relative.replace(/\.mjs$/i, ".d.mts"),
              relative.replace(/\.cjs$/i, ".cts"),
              relative.replace(/\.cjs$/i, ".d.cts"),
            ]
          : path.posix.extname(relative)
            ? [relative]
            : extensions.flatMap((extension) => [
                relative + extension,
                relative + "/index" + extension,
              ]);
        const matches = [...new Set(alternatives)].filter((name) =>
          sourceMap.has(path.posix.join(virtualRoot, name)),
        );
        if (matches.length !== 1)
          return {
            resolution: matches.length
              ? ("ambiguous" as const)
              : ("missing" as const),
            targetFile: null,
          };
        const targetFile = matches[0]!;
        return {
          resolution: ast.has(path.posix.join(virtualRoot, targetFile))
            ? ("selected" as const)
            : ("unparsed" as const),
          targetFile,
        };
      };
      const host: ts.CompilerHost = {
        getSourceFile: (name) => ast.get(name),
        getDefaultLibFileName: () => "",
        getCurrentDirectory: () => virtualRoot,
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
        fileExists: (name) => ast.has(name),
        readFile: (name) => ast.get(name)?.text,
        directoryExists: () => false,
        getDirectories: () => [],
        realpath: (name) => name,
        writeFile: () => {
          throw new Error("Review analysis cannot emit");
        },
        resolveTypeReferenceDirectiveReferences: (refs) =>
          refs.map(() => ({ resolvedTypeReferenceDirective: undefined })),
        resolveModuleNameLiterals: (literals, containing) =>
          literals.map((literal) => {
            const target = resolve(literal.text, containing);
            return {
              resolvedModule:
                target.resolution === "selected"
                  ? {
                      resolvedFileName: path.posix.join(
                        virtualRoot,
                        target.targetFile!,
                      ),
                      extension: [
                        ts.Extension.Dts,
                        ts.Extension.Dmts,
                        ts.Extension.Dcts,
                        ts.Extension.Ts,
                        ts.Extension.Tsx,
                        ts.Extension.Js,
                        ts.Extension.Jsx,
                        ts.Extension.Mts,
                        ts.Extension.Cts,
                        ts.Extension.Mjs,
                        ts.Extension.Cjs,
                      ].find((extension) =>
                        target.targetFile!.toLowerCase().endsWith(extension),
                      )!,
                    }
                  : undefined,
            };
          }),
      };
      const options: ts.CompilerOptions = {
        noLib: true,
        noEmit: true,
        allowJs: true,
        types: [],
        target: ts.ScriptTarget.ESNext,
        module: ts.ModuleKind.ESNext,
        moduleDetection: ts.ModuleDetectionKind.Force,
        skipLibCheck: true,
        jsx: ts.JsxEmit.Preserve,
      };
      let program = ts.createProgram([...ast.keys()], options, host);
      for (const [name, file] of ast) {
        if (program.getSyntacticDiagnostics(file).length) {
          ast.delete(name);
          records.find(
            (record) => record.file === path.posix.relative(virtualRoot, name),
          )!.state = "malformed";
        }
      }
      program = ts.createProgram([...ast.keys()], options, host);
      for (const file of ast.values()) walk(file);
      const checker = program.getTypeChecker();
      const range = (node: ts.Node) => {
        const sf = node.getSourceFile();
        const start = node.getStart(sf, true);
        const end = node.getEnd();
        return {
          revision: revision as Revision,
          file: path.posix.relative(virtualRoot, sf.fileName),
          start,
          end,
          startLine: sf.getLineAndCharacterOfPosition(start).line + 1,
          endLine:
            sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1,
        };
      };
      const name = (node: ts.Node): string | null => {
        const named = node as ts.Node & { name?: ts.Node };
        const value = named.name;
        if (
          value &&
          (ts.isIdentifier(value) ||
            ts.isStringLiteral(value) ||
            ts.isNumericLiteral(value)) &&
          value.text.length <= 256
        )
          return value.text;
        return null;
      };
      const functionNode = (node: ts.Node): node is FunctionNode =>
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node);
      const declarationKind = (
        node: ts.Node,
      ): ReviewBehavior["declarations"][number]["kind"] | undefined =>
        ts.isFunctionDeclaration(node)
          ? "function"
          : ts.isVariableDeclaration(node)
            ? "variable"
            : ts.isClassDeclaration(node) || ts.isClassExpression(node)
              ? "class"
              : ts.isInterfaceDeclaration(node)
                ? "interface"
                : ts.isTypeAliasDeclaration(node)
                  ? "type"
                  : ts.isEnumDeclaration(node)
                    ? "enum"
                    : ts.isPropertyDeclaration(node) ||
                        ts.isPropertyAssignment(node)
                      ? "property"
                      : ts.isParameter(node)
                        ? "parameter"
                        : ts.isImportDeclaration(node) ||
                            ts.isImportSpecifier(node) ||
                            ts.isNamespaceImport(node) ||
                            ts.isImportClause(node)
                          ? "import"
                          : undefined;
      const declarations = new Map<ts.Node, string>();
      const declarationAddresses = new Map<
        string,
        ReviewBehavior["declarations"][number]
      >();
      const functions = new Map<ts.Node, string>();
      for (const node of nodes) {
        const kind = declarationKind(node);
        if (!kind) continue;
        if (output.declarations.length >= 2048) throw new Error("budget");
        const address = range(node);
        const id = hash([
          "declaration",
          revision,
          address.file,
          address.start,
          address.end,
          kind,
        ]);
        declarations.set(node, id);
        const existing = declarationAddresses.get(id);
        if (existing) {
          existing.name ??= name(node);
          continue;
        }
        const initializer = (node as ts.Node & { initializer?: ts.Expression })
          .initializer;
        output.declarations.push({
          ...address,
          id,
          kind,
          name: name(node),
          initializer: initializer
            ? { start: initializer.getStart(), end: initializer.getEnd() }
            : null,
        });
        declarationAddresses.set(id, output.declarations.at(-1)!);
      }
      for (const node of nodes) {
        if (!functionNode(node) || !node.body) continue;
        if (output.functions.length >= 512) throw new Error("budget");
        const address = range(node);
        const id = hash([
          "function",
          revision,
          address.file,
          address.start,
          address.end,
        ]);
        functions.set(node, id);
        const enclosingDeclarations: string[] = [];
        for (let parent = node.parent; parent; parent = parent.parent)
          if (declarations.has(parent))
            enclosingDeclarations.push(declarations.get(parent)!);
        const hunk = changes.find((change) => change.path === address.file)
          ?.hunks[0];
        const start =
          revision === "base" ? hunk?.beforeStartLine : hunk?.afterStartLine;
        const count =
          revision === "base" ? hunk?.beforeLineCount : hunk?.afterLineCount;
        output.functions.push({
          ...address,
          id,
          name:
            name(node) ??
            (ts.isVariableDeclaration(node.parent) ? name(node.parent) : null),
          kind: ts.isArrowFunction(node)
            ? "arrow"
            : ts.isConstructorDeclaration(node)
              ? "constructor"
              : ts.isGetAccessorDeclaration(node)
                ? "getter"
                : ts.isSetAccessorDeclaration(node)
                  ? "setter"
                  : ts.isMethodDeclaration(node)
                    ? "method"
                    : "function",
          declarationId:
            declarations.get(node) ?? declarations.get(node.parent) ?? null,
          enclosingDeclarations,
          overlapsChange: !diff
            ? null
            : start !== undefined &&
              count !== undefined &&
              start <= address.endLine + (count === 0 ? 1 : 0) &&
              start + Math.max(1, count) - 1 >= address.startLine,
        });
      }
      const owner = (node: ts.Node, map: Map<ts.Node, string>) => {
        for (let parent = node.parent; parent; parent = parent.parent)
          if (map.has(parent)) return map.get(parent)!;
        return null;
      };
      const symbol = (node: ts.Node) => {
        try {
          return checker.getSymbolAtLocation(node);
        } catch {
          return undefined;
        }
      };
      const unalias = (value: ts.Symbol | undefined) =>
        value && value.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(value)
          : value;
      const aliasDeclarations = (
        value: ts.Symbol | undefined,
      ): ts.Declaration[] => {
        const seen = new Set<ts.Symbol>();
        const declarations: ts.Declaration[] = [];
        while (value && !seen.has(value)) {
          seen.add(value);
          declarations.push(...(value.declarations ?? []));
          value =
            value.flags & ts.SymbolFlags.Alias
              ? checker.getImmediateAliasedSymbol(value)
              : undefined;
        }
        return declarations;
      };
      const erasedStarPath = (
        bound: ts.Symbol | undefined,
        namespace: ts.Symbol | undefined,
        member: string | undefined,
      ): boolean => {
        const target = unalias(bound);
        if (!target) return false;
        const pending: {
          file: ts.SourceFile;
          name: string;
          erased: boolean;
        }[] = [];
        const add = (
          specifier: ts.Node | undefined,
          source: ts.SourceFile,
          name: string,
          erased: boolean,
        ) => {
          if (!specifier || !ts.isStringLiteral(specifier)) return;
          const resolved = resolve(specifier.text, source.fileName);
          if (resolved.resolution !== "selected") return;
          const file = ast.get(
            path.posix.join(virtualRoot, resolved.targetFile!),
          );
          if (file) pending.push({ file, name, erased });
        };
        for (const declaration of [
          ...aliasDeclarations(bound),
          ...aliasDeclarations(namespace),
        ]) {
          if (
            !ts.isImportSpecifier(declaration) &&
            !ts.isImportClause(declaration) &&
            !ts.isNamespaceImport(declaration)
          )
            continue;
          let parent: ts.Node = declaration;
          while (parent.parent && !ts.isImportDeclaration(parent))
            parent = parent.parent;
          if (!ts.isImportDeclaration(parent)) continue;
          const imported = ts.isImportSpecifier(declaration)
            ? (declaration.propertyName ?? declaration.name).text
            : ts.isNamespaceImport(declaration)
              ? member
              : declaration.name
                ? "default"
                : undefined;
          if (imported)
            add(
              parent.moduleSpecifier,
              parent.getSourceFile(),
              imported,
              false,
            );
        }
        const seen = new Set<string>();
        let erased = false,
          runtime = false;
        while (pending.length) {
          const current = pending.pop()!;
          const identity = JSON.stringify([
            current.file.fileName,
            current.name,
            current.erased,
          ]);
          if (seen.has(identity)) continue;
          if (seen.size >= 512) throw new Error("budget");
          seen.add(identity);
          const module = symbol(current.file);
          const exported =
            module &&
            checker
              .getExportsOfModule(module)
              .find((value) => value.name === current.name);
          if (unalias(exported) !== target) continue;
          if (target.valueDeclaration?.getSourceFile() === current.file) {
            if (current.erased) erased = true;
            else runtime = true;
            continue;
          }
          for (const statement of current.file.statements) {
            if (
              !ts.isExportDeclaration(statement) ||
              !statement.moduleSpecifier
            )
              continue;
            if (!statement.exportClause)
              add(
                statement.moduleSpecifier,
                current.file,
                current.name,
                current.erased || statement.isTypeOnly,
              );
            else if (ts.isNamedExports(statement.exportClause)) {
              for (const exported of statement.exportClause.elements)
                if (exported.name.text === current.name)
                  add(
                    statement.moduleSpecifier,
                    current.file,
                    (exported.propertyName ?? exported.name).text,
                    current.erased ||
                      statement.isTypeOnly ||
                      exported.isTypeOnly,
                  );
            }
          }
        }
        return erased && !runtime;
      };
      const writes = new Set<ts.Symbol>();
      const markWrite = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
          const bound = symbol(node);
          if (bound) writes.add(bound);
        } else if (ts.isArrayLiteralExpression(node))
          node.elements.forEach(markWrite);
        else if (ts.isObjectLiteralExpression(node))
          node.properties.forEach((property) => {
            if (ts.isPropertyAssignment(property))
              markWrite(property.initializer);
            else if (ts.isShorthandPropertyAssignment(property)) {
              const bound = checker.getShorthandAssignmentValueSymbol(property);
              if (bound) writes.add(bound);
            } else if (ts.isSpreadAssignment(property))
              markWrite(property.expression);
          });
        else if (ts.isSpreadElement(node) || ts.isParenthesizedExpression(node))
          markWrite(node.expression);
      };
      for (const node of nodes) {
        const operand =
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
            ? node.left
            : (ts.isPrefixUnaryExpression(node) ||
                  ts.isPostfixUnaryExpression(node)) &&
                (node.operator === ts.SyntaxKind.PlusPlusToken ||
                  node.operator === ts.SyntaxKind.MinusMinusToken)
              ? node.operand
              : undefined;
        if (operand) markWrite(operand);
      }
      const unwrap = (node: ts.Expression): ts.Expression =>
        ts.isParenthesizedExpression(node) ||
        ts.isAsExpression(node) ||
        ts.isNonNullExpression(node) ||
        ts.isTypeAssertionExpression(node)
          ? unwrap(node.expression)
          : node;
      for (const node of nodes) {
        if (
          ts.isImportDeclaration(node) ||
          (ts.isExportDeclaration(node) && node.moduleSpecifier)
        ) {
          const spec = node.moduleSpecifier;
          if (spec && ts.isStringLiteral(spec))
            output.modules.push({
              ...range(node),
              kind: ts.isImportDeclaration(node) ? "import" : "re-export",
              specifier: spec.text.length <= 1024 ? spec.text : null,
              ...resolve(spec.text, node.getSourceFile().fileName),
            });
        }
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          if (output.calls.length >= 2048) throw new Error("budget");
          const expression = unwrap(node.expression);
          let bound: ts.Symbol | undefined;
          let namespace: ts.Symbol | undefined;
          if (ts.isIdentifier(expression)) bound = symbol(expression);
          else if (
            ts.isPropertyAccessExpression(expression) &&
            ts.isIdentifier(expression.expression)
          ) {
            namespace = symbol(expression.expression);
            if (
              namespace?.declarations?.some((declaration) =>
                ts.isNamespaceImport(declaration),
              )
            )
              bound = symbol(expression.name);
          }
          const kind = ts.isNewExpression(node)
            ? ("construct" as const)
            : ("call" as const);
          let resolution: ReviewBehavior["calls"][number]["resolution"] = bound
            ? "no-selected-definition"
            : ts.isIdentifier(expression)
              ? "no-selected-definition"
              : "unsupported-dispatch";
          let targets: string[] = [];
          const typeOnly =
            [...aliasDeclarations(bound), ...aliasDeclarations(namespace)].some(
              ts.isTypeOnlyImportOrExportDeclaration,
            ) ||
            erasedStarPath(
              bound,
              namespace,
              ts.isPropertyAccessExpression(expression)
                ? expression.name.text
                : undefined,
            );
          const targetSymbol = unalias(bound);
          if (
            bound &&
            (writes.has(bound) ||
              (targetSymbol && writes.has(targetSymbol)) ||
              (namespace && writes.has(namespace)))
          )
            resolution = "mutated-binding";
          else if (typeOnly) resolution = "type-only-import";
          else if (bound) {
            for (const declaration of targetSymbol?.declarations ?? []) {
              const value =
                ts.isVariableDeclaration(declaration) && declaration.initializer
                  ? unwrap(declaration.initializer)
                  : ts.isExportAssignment(declaration)
                    ? unwrap(declaration.expression)
                    : declaration;
              if (
                kind === "construct" &&
                (ts.isClassDeclaration(value) || ts.isClassExpression(value))
              ) {
                for (const member of value.members)
                  if (
                    ts.isConstructorDeclaration(member) &&
                    functions.has(member)
                  )
                    targets.push(functions.get(member)!);
              } else if (functions.has(value))
                targets.push(functions.get(value)!);
            }
            targets = [...new Set(targets)];
            resolution =
              targets.length === 1
                ? "lexical-binding"
                : targets.length > 1
                  ? "ambiguous-definition"
                  : "no-selected-definition";
          }
          output.calls.push({
            ...range(node),
            kind,
            optional: ts.isCallExpression(node) && !!node.questionDotToken,
            callerFunctionId: owner(node, functions),
            targetFunctionId: targets.length === 1 ? targets[0]! : null,
            resolution,
          });
          const dynamicKind =
            expression.kind === ts.SyntaxKind.ImportKeyword
              ? "dynamic-import"
              : ts.isIdentifier(expression) &&
                  expression.text === "require" &&
                  !bound
                ? "require"
                : undefined;
          if (dynamicKind)
            output.modules.push({
              ...range(node),
              kind: dynamicKind,
              specifier:
                node.arguments?.[0] &&
                ts.isStringLiteral(node.arguments[0]) &&
                node.arguments[0].text.length <= 1024
                  ? node.arguments[0].text
                  : null,
              targetFile: null,
              resolution: "dynamic",
            });
        }
        if (ts.isIdentifier(node)) {
          if (
            (node.parent as ts.Node & { name?: ts.Node }).name === node ||
            (ts.isPropertyAccessExpression(node.parent) &&
              node.parent.name === node)
          )
            continue;
          const targets = [
            ...new Set(
              (unalias(symbol(node))?.declarations ?? []).flatMap(
                (declaration) =>
                  declarations.has(declaration)
                    ? [declarations.get(declaration)!]
                    : [],
              ),
            ),
          ];
          if (targets.length === 1) {
            if (output.references.length >= 4096) throw new Error("budget");
            output.references.push({
              ...range(node),
              fromFunctionId: owner(node, functions),
              ownerDeclarationId: owner(node, declarations),
              targetDeclarationId: targets[0]!,
            });
          }
        }
        if (output.modules.length > 256) throw new Error("budget");
      }
      for (const key of [
        "functions",
        "declarations",
        "calls",
        "references",
        "modules",
      ] as const) {
        output[key].sort(
          (a, b) =>
            a.file.localeCompare(b.file, "en") ||
            a.start - b.start ||
            a.end - b.end,
        );
        result[key].push(...(output[key] as never[]));
      }
    } catch (error) {
      for (const record of records)
        if (record.state === "collected")
          record.state =
            error instanceof Error && error.message === "budget"
              ? "budget-exhausted"
              : "error";
    }
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 262144) {
    Object.assign(result, empty());
    for (const file of result.files)
      if (file.state === "collected") file.state = "budget-exhausted";
  }
  result.state = result.files.some((file) => file.state !== "collected")
    ? "partial"
    : "collected";
  return reviewBehaviorSchema.parse(result);
}
