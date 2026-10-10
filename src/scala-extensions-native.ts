import { scalaNativeSource } from "./scala-native.js";
const edits = [
  [
    "selected(unit.source.path).foreach { source =>",
    "if !unit.isJava then selected(unit.source.path).foreach { source =>",
  ],
  [
    "a.drop(4).foreach { f =>",
    'a.drop(4).filter(_.endsWith(".scala")).foreach { f =>',
  ],
  [
    "selected(source.path).foreach(_.compiled += 1)",
    'if source.path.endsWith(".scala") then selected(source.path).foreach(_.compiled += 1)',
  ],
] as const;
// Java symbol inputs are separately compiled by the native JavaCompiler task.
export const scalaExtensionsNativeSource = edits.reduce(
  (source, [before, after]) => {
    if (source.split(before).length !== 2)
      throw Error("Original Scala mixed-source observer address changed");
    return source.replace(before, after);
  },
  scalaNativeSource,
);
