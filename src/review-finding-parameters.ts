import { createRequire } from "node:module";
import type ts from "typescript";
import type { ReviewContext } from "./review.js";

export interface FindingParameterObservation {
  functionId: string;
  state: "observed" | "unavailable";
  names: string[];
  sourceDigest: string | null;
}
type Callable =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** Parse captured text only. No compiler config, project module or real host is loaded. */
function observeParameterBindings(
  context: ReviewContext,
  requested: string[],
  guard: () => void,
  loadCompiler: () => typeof ts,
): Map<string, FindingParameterObservation> {
  const observations = new Map<string, FindingParameterObservation>();
  const pending = [...new Set(requested)];
  for (const functionId of pending)
    observations.set(functionId, {
      functionId,
      state: "unavailable",
      names: [],
      sourceDigest: null,
    });
  if (!pending.length || !("analysis" in context)) return observations;
  guard();
  const compiler = loadCompiler();
  guard();
  if (compiler.version !== "6.0.3") return observations;
  const functions = context.analysis.functions.filter(
    (fn) => fn.revision === "current" && observations.has(fn.id),
  );
  for (const file of context.files) {
    const selected = functions.filter((fn) => fn.file === file.path);
    if (
      !selected.length ||
      !/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(file.path) ||
      !context.analysis.files.some(
        (record) =>
          record.file === file.path &&
          record.revision === "current" &&
          record.state === "collected",
      )
    )
      continue;
    guard();
    const filename = "/__checktrail_repair__/" + file.path;
    let source: ts.SourceFile;
    try {
      source = compiler.createSourceFile(
        filename,
        file.content,
        compiler.ScriptTarget.Latest,
        true,
      );
      const host: ts.CompilerHost = {
        getSourceFile: (name) => (name === filename ? source : undefined),
        getDefaultLibFileName: () => "",
        writeFile: () => {
          throw Error("Parameter observation cannot emit files");
        },
        getCurrentDirectory: () => "/",
        getDirectories: () => [],
        directoryExists: () => false,
        realpath: (name) => name,
        fileExists: (name) => name === filename,
        readFile: (name) => (name === filename ? file.content : undefined),
        getCanonicalFileName: (name) => name,
        useCaseSensitiveFileNames: () => true,
        getNewLine: () => "\n",
      };
      const program = compiler.createProgram(
        [filename],
        {
          target: compiler.ScriptTarget.Latest,
          module: compiler.ModuleKind.ESNext,
          allowJs: true,
          noLib: true,
          noResolve: true,
          types: [],
        },
        host,
      );
      if (program.getSyntacticDiagnostics(source).length) continue;
    } catch {
      // Syntax/parser failures are unknown availability, not a usable repair.
      continue;
    }
    guard();
    const found = new Map<string, Callable[]>();
    const nodes: { node: ts.Node; depth: number }[] = [
      { node: source, depth: 0 },
    ];
    let visited = 0,
      exhausted = false;
    while (nodes.length) {
      const { node, depth } = nodes.pop()!;
      if (++visited > 50000 || depth > 64) {
        exhausted = true;
        break;
      }
      if (visited % 100 === 0) guard();
      if (
        (compiler.isFunctionDeclaration(node) ||
          compiler.isFunctionExpression(node) ||
          compiler.isArrowFunction(node) ||
          compiler.isMethodDeclaration(node) ||
          compiler.isConstructorDeclaration(node) ||
          compiler.isGetAccessorDeclaration(node) ||
          compiler.isSetAccessorDeclaration(node)) &&
        node.body
      ) {
        const key = JSON.stringify([
          node.getStart(source, true),
          node.getEnd(),
        ]);
        const previous = found.get(key) ?? [];
        previous.push(node);
        found.set(key, previous);
      }
      compiler.forEachChild(node, (child) => {
        nodes.push({ node: child, depth: depth + 1 });
      });
    }
    if (exhausted) continue;
    for (const fn of selected) {
      const matches = found.get(JSON.stringify([fn.start, fn.end]));
      if (matches?.length !== 1) continue;
      const names = new Set<string>();
      const bindings: { name: ts.BindingName; depth: number }[] =
        matches[0]!.parameters.map((parameter) => ({
          name: parameter.name,
          depth: 0,
        }));
      let steps = 0,
        bounded = true;
      while (bindings.length) {
        const { name, depth } = bindings.pop()!;
        if (++steps > 512 || depth > 64) {
          bounded = false;
          break;
        }
        if (compiler.isIdentifier(name)) {
          if (name.text.length > 256) {
            bounded = false;
            break;
          }
          names.add(name.text);
        } else {
          for (const element of name.elements)
            if (compiler.isBindingElement(element))
              bindings.push({ name: element.name, depth: depth + 1 });
        }
      }
      if (bounded)
        observations.set(fn.id, {
          functionId: fn.id,
          state: "observed",
          names: [...names].sort(),
          sourceDigest: file.sha256,
        });
    }
    guard();
  }
  return observations;
}

const loadInstalledLibrary = createRequire(import.meta.url);
/** Synchronous historical replay parses captured strings and never rechecks the filesystem. */
export function replayFindingParameters(
  context: ReviewContext,
  requested: string[],
  guard: () => void = () => {},
) {
  return observeParameterBindings(
    context,
    requested,
    guard,
    () => loadInstalledLibrary("typescript") as typeof ts,
  );
}
/** Keep asynchronous loading and caller cancellation boundaries for live inspection. */
export async function observeFindingParameters(
  context: ReviewContext,
  requested: string[],
  guard: () => void = () => {},
) {
  if (!requested.length || !("analysis" in context))
    return observeParameterBindings(context, requested, guard, () => {
      throw Error("No parser requested");
    });
  guard();
  const compiler = await import("typescript");
  guard();
  return observeParameterBindings(context, requested, guard, () => compiler);
}
