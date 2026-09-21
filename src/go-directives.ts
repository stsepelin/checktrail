export function hasGoSuppression(source: string): boolean {
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"' || char === "'" || char === "`") {
      for (i++; i < source.length; i++) {
        if (source[i] === char) break;
        if (char !== "`" && source[i] === "\\") i++;
      }
    } else if (char === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      const text = source
        .slice(i, end === -1 ? source.length : end)
        .replace(/\r/g, "")
        .replace(/^[ /]+/, "");
      if (/^(?:nolint(?: |:|$)|lint:(?:ignore|file-ignore)(?: |$))/.test(text))
        return true;
      if (end === -1) break;
      i = end;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 1;
    }
  }
  return false;
}
