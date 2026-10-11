import path from "node:path";
import { isBuiltin } from "node:module";
import ts from "typescript";
import { inventory } from "./inventory.js";
import { mutationBoundedBytes } from "./mutation-native-copy.js";
import type { Inventory, Workspace } from "./types.js";

export interface ConsumerImportEvidence {
  status: "resolved" | "unknown" | "inconsistent";
  reason: string;
  edges: Array<{ consumer: string; producer: string }>;
  parsedFiles: number;
}

// This is a finite captured-source profile, not a complete runtime graph. No
// loader, compiler configuration, manifest script or project code is evaluated.
export async function reconcileConsumerImports(
  source: Inventory,
  projects: string[],
  workspace: Workspace,
): Promise<ConsumerImportEvidence> {
  const all = [...new Set(projects)].sort();
  const files = new Set(source.files);
  const owner = (file: string) =>
    all
      .filter((p) => p === "." || file.startsWith(p + "/"))
      .sort((a, b) => b.length - a.length)[0];
  const graph = new Map<string, Set<string>>();
  const projected = new Map<string, { consumer: string; producer: string }>();
  let parsedFiles = 0,
    nodes = 0,
    bytes = 0,
    edgeCount = 0;
  const unknown = (): ConsumerImportEvidence => ({
    status: "unknown",
    reason:
      "Captured source imports or resource inputs are outside the resolved shape; retaining full validation.",
    edges: [],
    parsedFiles,
  });
  const selectedBuiltins = new Set(
    [
      "assert",
      "assert/strict",
      "test",
      "path",
      "path/posix",
      "path/win32",
      "url",
      "buffer",
      "fs",
      "fs/promises",
    ].flatMap((n) => [n, "node:" + n]),
  );
  const add = (from: string, to: string) => {
    const deps = graph.get(from) ?? new Set<string>();
    if (!deps.has(to) && ++edgeCount > 8192) throw Error("Import edge bound");
    deps.add(to);
    graph.set(from, deps);
  };
  const resolve = (from: string, specifier: string, resource = false) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../"))
      throw Error("Unresolved module root");
    if (/[\\%?#\0]/.test(specifier)) throw Error("Unresolved module spelling");
    const exact = path.posix.normalize(
      path.posix.join(path.posix.dirname(from), specifier),
    );
    if (exact === ".." || exact.startsWith("../"))
      throw Error("Escaping import");
    // Extension search, directory entry points and compiler substitutions are
    // deliberately unknown. Require the exact physical input named by the source.
    if (
      !files.has(exact) ||
      (!resource && !/\.(?:js|mjs|cjs|json)$/.test(exact))
    )
      throw Error("Missing or unsupported physical import");
    return exact;
  };
  try {
    if (
      !workspace.complete ||
      !all.length ||
      all.length > 256 ||
      (all.includes(".") && all.length > 1)
    )
      return unknown();
    for (const file of source.files) {
      if (
        owner(file) &&
        /\.(?:[cm]?tsx?|jsx|py|php|go|rs|java|kt|kts|scala|cs|vb|fs|fsi|fsx|rb|swift|c|h|cc|cpp|cxx|hpp|vue|svelte|hcl|tf|tfvars|ya?ml)$/.test(
          file,
        )
      )
        return unknown();
      if (
        owner(file) &&
        /(?:^|\/)(?:tsconfig[^/]*|jsconfig[^/]*)\.json$/.test(file)
      )
        return unknown();
    }
    for (const file of source.files.filter((f) =>
      /\.(?:js|mjs|cjs)$/.test(f),
    )) {
      if (++parsedFiles > 512) throw Error("Import file bound");
      const raw = await mutationBoundedBytes(
        source.root,
        file,
        Math.min(4 * 1048576, 16 * 1048576 - bytes),
      );
      bytes += raw.length;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      const unit = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
      );
      if (
        (unit as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
          .parseDiagnostics.length ||
        unit.referencedFiles.length ||
        unit.typeReferenceDirectives.length ||
        unit.libReferenceDirectives.length
      )
        throw Error("Unresolved syntax or compiler references");
      const readers = new Set<string>();
      const modules: string[] = [];
      function visit(node: ts.Node, depth = 0): void {
        if (++nodes > 100000 || depth > 64) throw Error("Import syntax bound");
        if (ts.isModuleDeclaration(node) || ts.isImportEqualsDeclaration(node))
          throw Error("Unresolved module scope");
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          if (node.moduleSpecifier) {
            if (!ts.isStringLiteral(node.moduleSpecifier))
              throw Error("Dynamic declaration");
            const name = node.moduleSpecifier.text;
            modules.push(name);
            if (
              ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(
                name,
              )
            ) {
              const bindings = ts.isImportDeclaration(node)
                ? node.importClause?.namedBindings
                : undefined;
              if (!bindings || !ts.isNamedImports(bindings))
                throw Error("Filesystem namespace");
              for (const item of bindings.elements) {
                if (
                  !["readFile", "readFileSync"].includes(
                    (item.propertyName ?? item.name).text,
                  )
                )
                  throw Error("Unresolved filesystem capability");
                readers.add(item.name.text);
              }
            }
          }
        }
        ts.forEachChild(node, (child) => visit(child, depth + 1));
      }
      visit(unit);
      function uses(node: ts.Node): void {
        if (++nodes > 100000) throw Error("Import use bound");
        if (ts.isElementAccessExpression(node))
          throw Error("Computed runtime input");
        if (
          ts.isIdentifier(node) &&
          [
            "eval",
            "Function",
            "constructor",
            "createRequire",
            "registerHooks",
            "global",
            "globalThis",
            "process",
            "module",
            "Reflect",
            "getPrototypeOf",
            "setPrototypeOf",
            "getOwnPropertyDescriptor",
            "getOwnPropertyDescriptors",
            "defineProperty",
            "defineProperties",
            "__lookupGetter__",
            "__lookupSetter__",
          ].includes(node.text)
        )
          throw Error("Dynamic source or environment input");
        if (ts.isIdentifier(node) && node.text === "require") {
          if (!(
            ts.isCallExpression(node.parent) &&
            node.parent.expression === node &&
            node.parent.arguments.length === 1 &&
            ts.isStringLiteral(node.parent.arguments[0]!)
          ))
            throw Error("Unresolved require binding");
          const name = (node.parent.arguments[0] as ts.StringLiteral).text;
          if (
            ["fs", "node:fs", "fs/promises", "node:fs/promises"].includes(name)
          )
            throw Error("Unresolved filesystem require");
          modules.push(name);
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword
        ) {
          if (
            node.arguments.length !== 1 ||
            !ts.isStringLiteral(node.arguments[0]!)
          )
            throw Error("Dynamic module input");
          modules.push((node.arguments[0] as ts.StringLiteral).text);
        }
        if (
          ts.isIdentifier(node) &&
          node.text === "URL" &&
          !(ts.isNewExpression(node.parent) && node.parent.expression === node)
        )
          throw Error("Indirect or shadowed URL binding");
        if (ts.isIdentifier(node) && readers.has(node.text)) {
          if (ts.isImportSpecifier(node.parent)) return;
          const call = node.parent;
          if (!ts.isCallExpression(call) || call.expression !== node)
            throw Error("Indirect or shadowed resource reader");
          const url = call.arguments[0];
          if (
            !url ||
            !ts.isNewExpression(url) ||
            !ts.isIdentifier(url.expression) ||
            url.expression.text !== "URL" ||
            url.arguments?.length !== 2 ||
            !ts.isStringLiteral(url.arguments[0]!) ||
            url.arguments[1]!.getText(unit) !== "import.meta.url"
          )
            throw Error("Unresolved resource path");
          add(
            file,
            resolve(file, (url.arguments[0] as ts.StringLiteral).text, true),
          );
        }
        ts.forEachChild(node, uses);
      }
      uses(unit);
      for (const name of modules) {
        if (isBuiltin(name)) {
          if (!selectedBuiltins.has(name))
            throw Error("Unselected native capability");
        } else add(file, resolve(file, name));
      }
    }
    if (!parsedFiles) return unknown();
    for (const file of graph.keys()) {
      const consumer = owner(file);
      if (!consumer) continue;
      const pending = [...(graph.get(file) ?? [])];
      const seen = new Set<string>();
      while (pending.length) {
        const target = pending.pop()!;
        if (seen.has(target)) continue;
        seen.add(target);
        const producer = owner(target);
        if (producer && producer !== consumer)
          projected.set(JSON.stringify([consumer, producer]), {
            consumer,
            producer,
          });
        pending.push(...(graph.get(target) ?? []));
      }
    }
    const edges = [...projected.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b), "en"),
    );
    // Reject stale observations before making either a resolved or inconsistent
    // graph claim. The observed snapshots are not an attestation against races.
    if ((await inventory(source.root)).fingerprint !== source.fingerprint)
      return unknown();
    for (const edge of edges) {
      const pending = [edge.consumer];
      const seen = new Set<string>();
      while (pending.length) {
        const p = pending.pop()!;
        if (seen.has(p)) continue;
        seen.add(p);
        pending.push(
          ...workspace.dependencies
            .filter((e) => e.consumer === p)
            .map((e) => e.producer),
        );
      }
      if (!seen.has(edge.producer))
        return {
          status: "inconsistent",
          reason:
            "Declared dependencies omit a captured source consumer; retaining full validation.",
          edges,
          parsedFiles,
        };
    }
    return {
      status: "resolved",
      reason:
        "Declared transitive consumers reconcile with the selected captured-source import profile.",
      edges,
      parsedFiles,
    };
  } catch {
    return unknown();
  }
}
