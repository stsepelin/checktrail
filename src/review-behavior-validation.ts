import { createHash } from "node:crypto";
import { selectedGrammar } from "./review-grammar-profile.js";
import {
  grammarAssets,
  grammarManifestDigest,
} from "./review-grammar-assets.js";
import type { ReviewBehavior } from "./review-behavior-schema.js";

type Source = { path: string; sha256: string; content: string };
type Range = ReviewBehavior["functions"][number];
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (revision: string, file: string) =>
  JSON.stringify([revision, file]);

/** Validate captured addresses without loading the parser or a project host. */
export function validateReviewBehavior(
  analysis: ReviewBehavior,
  current: Source[],
  base: Source[],
  primary: string[],
): void {
  const fail = (): never => {
    throw new Error("Invalid review behavior anchors");
  };
  if (Buffer.byteLength(JSON.stringify(analysis)) > 256 * 1024) fail();
  const sources = new Map([
    ...base.map((file) => [key("base", file.path), file] as const),
    ...current.map((file) => [key("current", file.path), file] as const),
  ]);
  const records = new Map(
    analysis.files.map((file) => [key(file.revision, file.file), file]),
  );
  if (records.size !== analysis.files.length || records.size !== sources.size)
    fail();
  for (const [address, source] of sources) {
    const record = records.get(address);
    if (
      !record ||
      record.sha256 !== source.sha256 ||
      record.role !== (primary.includes(source.path) ? "primary" : "support")
    )
      fail();
  }
  if (
    analysis.state !==
    (analysis.files.every((file) => file.state === "collected")
      ? "collected"
      : "partial")
  )
    fail();
  const lineStarts = new Map(
    [...sources].map(
      ([address, source]) =>
        [
          address,
          [
            0,
            ...[...source.content.matchAll(/\r\n|\r|\n|\u2028|\u2029/g)].map(
              (match) => match.index + match[0].length,
            ),
          ] as number[],
        ] as const,
    ),
  );
  const line = (address: string, offset: number) => {
    const starts = lineStarts.get(address)!;
    let lower = 0,
      upper = starts.length;
    while (lower < upper) {
      const middle = Math.floor((lower + upper) / 2);
      if (starts[middle]! <= offset) lower = middle + 1;
      else upper = middle;
    }
    return lower;
  };
  const checkRange = (
    range: Pick<
      Range,
      "revision" | "file" | "start" | "end" | "startLine" | "endLine"
    >,
  ) => {
    const address = key(range.revision, range.file);
    const source = sources.get(address);
    if (
      !source ||
      records.get(address)?.state !== "collected" ||
      range.start >= range.end ||
      range.end > source.content.length
    )
      fail();
    if (
      range.startLine !== line(address, range.start) ||
      range.endLine !== line(address, range.end - 1)
    )
      fail();
  };
  const contains = (
    outer: Pick<Range, "revision" | "file" | "start" | "end">,
    inner: Pick<Range, "revision" | "file" | "start" | "end">,
  ) =>
    outer.revision === inner.revision &&
    outer.file === inner.file &&
    outer.start <= inner.start &&
    outer.end >= inner.end;
  const functions = new Map(
    analysis.functions.map((value) => [value.id, value]),
  );
  const declarations = new Map(
    analysis.declarations.map((value) => [value.id, value]),
  );
  if (
    functions.size !== analysis.functions.length ||
    declarations.size !== analysis.declarations.length
  )
    fail();
  for (const value of analysis.declarations) {
    checkRange(value);
    if (
      value.id !==
      hash([
        "declaration",
        value.revision,
        value.file,
        value.start,
        value.end,
        value.kind,
      ])
    )
      fail();
    if (
      value.initializer &&
      (value.initializer.start < value.start ||
        value.initializer.end > value.end ||
        value.initializer.start >= value.initializer.end)
    )
      fail();
  }
  const owner = (
    id: string | null,
    value: Pick<Range, "revision" | "file" | "start" | "end">,
    collection: typeof functions | typeof declarations,
  ) => {
    if (id === null) return;
    const target = collection.get(id);
    if (!target || !contains(target, value)) fail();
  };
  for (const value of analysis.functions) {
    checkRange(value);
    if (
      value.id !==
      hash(["function", value.revision, value.file, value.start, value.end])
    )
      fail();
    owner(value.declarationId, value, declarations);
    if (
      new Set(value.enclosingDeclarations).size !==
      value.enclosingDeclarations.length
    )
      fail();
    for (const id of value.enclosingDeclarations)
      owner(id, value, declarations);
  }
  for (const value of analysis.calls) {
    checkRange(value);
    owner(value.callerFunctionId, value, functions);
    const target =
      value.targetFunctionId === null
        ? null
        : functions.get(value.targetFunctionId);
    if (
      (value.targetFunctionId !== null && !target) ||
      (value.resolution === "lexical-binding") !== (target != null) ||
      (target && target.revision !== value.revision)
    )
      fail();
  }
  for (const value of analysis.references) {
    checkRange(value);
    owner(value.fromFunctionId, value, functions);
    owner(value.ownerDeclarationId, value, declarations);
    if (
      declarations.get(value.targetDeclarationId)?.revision !== value.revision
    )
      fail();
  }
  if (
    analysis.profile === "selected-syntax-v1" ||
    analysis.profile === "python-selected-bindings-v1" ||
    analysis.profile === "go-selected-bindings-v1" ||
    analysis.profile === "php-selected-bindings-v1" ||
    analysis.profile === "rust-selected-bindings-v1" ||
    analysis.profile === "java-selected-bindings-v1" ||
    analysis.profile === "kotlin-selected-bindings-v1"
  ) {
    if (
      analysis.grammarManifestDigest !== grammarManifestDigest ||
      new Set(analysis.grammarBindings.map((binding) => binding.grammar))
        .size !== analysis.grammarBindings.length
    )
      fail();
    const expected = [
      ...new Set(
        analysis.files
          .filter((file) => file.state === "collected")
          .flatMap((file) => {
            const asset = selectedGrammar(file.file);
            return asset ? [asset.grammar] : [];
          }),
      ),
    ].sort((a, b) => a.localeCompare(b, "en"));
    if (
      JSON.stringify(expected) !==
      JSON.stringify(analysis.grammarBindings.map((binding) => binding.grammar))
    )
      fail();
    for (const binding of analysis.grammarBindings) {
      const asset = grammarAssets.find(
        (asset) => asset.grammar === binding.grammar,
      );
      if (
        !asset ||
        asset.sha256 !== binding.wasmSha256 ||
        asset.sourceCommit !== binding.sourceCommit
      )
        fail();
    }
    for (const value of analysis.decisions) {
      checkRange(value);
      if (
        value.id !==
        hash([
          "decision",
          value.revision,
          value.file,
          value.start,
          value.end,
          value.nodeType,
        ])
      )
        fail();
    }
  }
  for (const value of analysis.modules) {
    checkRange(value);
    if (value.targetFile !== null) {
      const target = records.get(key(value.revision, value.targetFile));
      if (
        !target ||
        (value.resolution === "selected"
          ? target.state !== "collected"
          : value.resolution !== "unparsed")
      )
        fail();
    } else if (
      value.resolution === "selected" ||
      value.resolution === "unparsed"
    )
      fail();
  }
}
