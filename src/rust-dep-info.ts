import path from "node:path";

function words(value: string): string[] {
  const result: string[] = [];
  let word = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === "\\") {
      const escaped = value[++index];
      if (escaped !== " " && escaped !== "\\")
        throw new Error("Unsupported dep-info escape");
      word += escaped;
    } else if (character === " " || character === "\t") {
      if (word) result.push(word);
      word = "";
    } else {
      if ("$#\r\n".includes(character))
        throw new Error("Unsupported dep-info path character");
      word += character;
    }
  }
  if (word) result.push(word);
  return result;
}

export function rustDependencyPaths(text: string, cwd: string): string[] {
  const paths = new Set<string>();
  let rules = 0;
  for (const line of text.split("\n")) {
    if (!line.trim() || line.startsWith("# env-dep:")) continue;
    const separator = line.indexOf(":");
    if (separator <= 0 || !words(line.slice(0, separator)).length)
      throw new Error("Malformed dep-info rule");
    const dependencies = words(line.slice(separator + 1));
    if (dependencies.length) rules++;
    for (const dependency of dependencies)
      paths.add(path.resolve(cwd, dependency));
  }
  if (!rules) throw new Error("Empty dep-info dependency rules");
  return [...paths].sort();
}
