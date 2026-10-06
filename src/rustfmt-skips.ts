// This scanner identifies exact Rustfmt suppression paths in attributes. It
// does not claim Rust parsing, macro expansion, cfg evaluation or reachability.
export function rustfmtHasSkip(source: string): boolean {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    if (source.startsWith("/*", index)) {
      let depth = 1;
      index += 2;
      while (index < source.length && depth) {
        if (source.startsWith("/*", index)) {
          depth++;
          index += 2;
        } else if (source.startsWith("*/", index)) {
          depth--;
          index += 2;
        } else index++;
        if (depth > 128) throw new Error("Rust comment depth limit");
      }
      if (depth) throw new Error("Unterminated Rust comment");
      continue;
    }
    const rest = source.slice(index);
    const raw = /^(?:br|cr|r)(#{0,255})"/.exec(rest);
    if (raw) {
      const end = source.indexOf('"' + raw[1], index + raw[0].length);
      if (end < 0) throw new Error("Unterminated Rust raw string");
      index = end + 1 + raw[1]!.length;
      continue;
    }
    const string = /^(?:b|c)?"/.exec(rest);
    if (string) {
      index += string[0].length;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") index += 2;
        else if (source[index++] === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unterminated Rust string");
      continue;
    }
    const character =
      /^(?:b)?'(?:\\(?:u\{[a-fA-F0-9_]+\}|x[a-fA-F0-9]{2}|[^])|[^'\\\r\n])'/u.exec(
        rest,
      );
    if (character) {
      index += character[0].length;
      continue;
    }
    const identifier = /^(?:r#)?[\p{ID_Start}_][\p{ID_Continue}_]*/u.exec(rest);
    if (identifier) {
      tokens.push(identifier[0].replace(/^r#/, ""));
      index += identifier[0].length;
    } else {
      if (!/\s/.test(source[index]!)) tokens.push(source[index]!);
      index++;
    }
    if (tokens.length > 2_000_000) throw new Error("Rust token limit");
  }
  let attributeDepth = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (
      !attributeDepth &&
      tokens[i] === "[" &&
      (tokens[i - 1] === "#" ||
        (tokens[i - 1] === "!" && tokens[i - 2] === "#"))
    )
      attributeDepth = 1;
    else if (attributeDepth && tokens[i] === "[") attributeDepth++;
    else if (attributeDepth && tokens[i] === "]") attributeDepth--;
    if (
      attributeDepth &&
      tokens[i] === "rustfmt" &&
      tokens[i + 1] === ":" &&
      tokens[i + 2] === ":" &&
      tokens[i + 3] === "skip"
    )
      return true;
  }
  return false;
}
