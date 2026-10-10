import { spotbugsCompilerSource } from "./spotbugs-compiler.js";
function replace(source: string, anchor: string, value: string) {
  if (source.split(anchor).length !== 2)
    throw Error("SpotBugs extension compiler anchor is not unique");
  return source.replace(anchor, value);
}
let compiler = replace(
  spotbugsCompilerSource,
  "List<Path> jars = new ArrayList<>();",
  'boolean modular = args.length == 3 && args[2].equals("module"); List<Path> jars = new ArrayList<>();',
);
compiler = replace(
  compiler,
  "try (JarFile archive = new JarFile(jar.toFile())) {",
  "if (Files.isDirectory(jar)) { jars.add(jar); continue; }\n      try (JarFile archive = new JarFile(jar.toFile())) {",
);
compiler = replace(
  compiler,
  "standard.setLocationFromPaths(StandardLocation.CLASS_PATH, jars);",
  "standard.setLocationFromPaths(StandardLocation.CLASS_PATH, modular ? List.of() : jars);\n      standard.setLocationFromPaths(StandardLocation.MODULE_PATH, modular ? jars : List.of());",
);
compiler = replace(
  compiler,
  'if (!name.matches("[A-Za-z_$][A-Za-z0-9_$]*(\\\\.[A-Za-z_$][A-Za-z0-9_$]*)*"))',
  'if (!name.equals("module-info") && !name.matches("[A-Za-z_$][A-Za-z0-9_$]*(\\\\.[A-Za-z_$][A-Za-z0-9_$]*)*"))',
);
compiler = replace(
  compiler,
  'outputs.add("{\\"name\\":" + quote(name) + ",\\"file\\":" + quote(source) + ",\\"sha256\\":" + quote(sha) + ",\\"bytes\\":" + data.length + "}");',
  String.raw`org.apache.bcel.classfile.JavaClass observed = new org.apache.bcel.classfile.ClassParser(new ByteArrayInputStream(data), name + ".class").parse();
                    if (!observed.getClassName().equals(name)) throw new IOException("Native class name disagrees");
                    outputs.add("{\"name\":" + quote(name) + ",\"file\":" + quote(source) + ",\"sha256\":" + quote(sha) + ",\"bytes\":" + data.length + ",\"output\":" + quote(output.toString()) + ",\"sourceFile\":" + quote(observed.getSourceFileName()) + "}");`,
);
compiler = replace(
  compiler,
  "standard.setLocationFromPaths(StandardLocation.SOURCE_PATH, List.of());",
  'standard.setLocationFromPaths(StandardLocation.SOURCE_PATH, modular ? sources.stream().filter(source -> source.getFileName().toString().equals("module-info.java")).map(Path::getParent).toList() : List.of());',
);
export const spotbugsExtensionsCompilerSource = compiler;
