import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const jvmConsumerFamilies = Object.freeze(["java", "kotlin", "scala"]);
function identity(value, maximum = 1073741824) {
  assert.ok(
    value &&
      Number.isSafeInteger(value.bytes) &&
      value.bytes > 0 &&
      value.bytes <= maximum,
  );
  assert.ok(sha(value.sha256));
}
export function inspectJvmDirectory(value, allowEmpty = false) {
  assert.equal(value?.profile, "bounded-consumer-directory-v1");
  assert.ok(sha(value.directorySha256));
  assert.ok(Array.isArray(value.files) && value.files.length <= 256);
  assert.ok(
    allowEmpty || value.files.length > 0,
    "Generated JVM artifacts are empty",
  );
  const names = [];
  let bytes = 0;
  for (const file of value.files) {
    assert.ok(
      typeof file.path === "string" &&
        file.path.length <= 512 &&
        !/[\\\0:]/.test(file.path) &&
        file.path
          .split("/")
          .every((part) => part && part !== "." && part !== ".."),
    );
    identity(file, 134217728);
    names.push(file.path);
    bytes += file.bytes;
  }
  assert.ok(bytes <= 536870912);
  assert.deepEqual(names, [...new Set(names)].sort());
  assert.equal(value.bytes, bytes);
  assert.equal(value.manifestSha256, hash(JSON.stringify(value.files)));
  return value;
}
export function inspectJvmInputs(value, family) {
  assert.equal(value?.profile, "consumer-jvm-inputs-v1");
  assert.equal(value.family, family);
  assert.ok(jvmConsumerFamilies.includes(family));
  identity(value.compiler);
  identity(value.runtime);
  identity(value.modules);
  if (family === "java") assert.equal(value.libraries, null);
  else {
    inspectJvmDirectory(value.libraries);
    assert.ok(
      value.libraries.files.every(
        (file) => file.path.endsWith(".jar") || file.path.endsWith(".JAR"),
      ),
    );
    const compiler =
      family === "kotlin"
        ? "kotlin-compiler.jar"
        : "scala3-compiler_3-3.9.0.jar";
    if (family === "kotlin")
      assert.ok(
        value.libraries.files.some((file) => file.path === "kotlin-stdlib.jar"),
        "Selected Kotlin runtime library is unobserved",
      );
    assert.ok(
      value.libraries.files.some((file) => file.path === compiler),
      "Selected JVM compiler library is unobserved",
    );
  }
  return value;
}
/** Observe actual classpath options, including both launcher spellings. */
export function consumerJvmClasspaths(args, root) {
  return args.flatMap((argument, index) => {
    const separate = ["-cp", "-classpath", "--class-path"].includes(argument);
    const joined = argument.startsWith("--class-path=");
    if (!separate && !joined) return [];
    const value = joined
      ? argument.slice("--class-path=".length)
      : String(args[index + 1] ?? "");
    return [
      value.split(":").map((entry) => {
        const resolved = path.posix.resolve(root, entry);
        const member = entry.endsWith("/*")
          ? "*"
          : entry.endsWith(".jar") || entry.endsWith(".JAR")
            ? path.posix.basename(entry)
            : null;
        return {
          directorySha256: hash(
            member === null ? resolved : path.posix.dirname(resolved),
          ),
          member,
        };
      }),
    ];
  });
}
export function inspectJvmAttempt(value) {
  const row = value.jvm;
  if (!jvmConsumerFamilies.includes(value.family)) {
    assert.ok(row === undefined || row === null);
    return;
  }
  assert.ok(row);
  assert.ok(Array.isArray(row.classpaths) && row.classpaths.length <= 4);
  for (const group of row.classpaths) {
    assert.ok(Array.isArray(group) && group.length <= 256);
    for (const entry of group) {
      assert.ok(sha(entry.directorySha256));
      assert.ok(
        entry.member === null ||
          entry.member === "*" ||
          (typeof entry.member === "string" &&
            entry.member.length <= 512 &&
            !/[\\/\0:]/.test(entry.member) &&
            (entry.member.endsWith(".jar") || entry.member.endsWith(".JAR"))),
      );
    }
  }
  inspectJvmInputs(row.inputsBefore, value.family);
  if (row.inputsAfter !== null) inspectJvmInputs(row.inputsAfter, value.family);
  if (row.generatedBefore !== null)
    inspectJvmDirectory(row.generatedBefore, true);
  if (row.generatedAfter !== null)
    inspectJvmDirectory(row.generatedAfter, true);
  assert.ok(
    row.commandDirectorySha256 === null || sha(row.commandDirectorySha256),
  );
}
export function requireJvmAttemptBinding(witness, value) {
  if (!jvmConsumerFamilies.includes(witness.family)) return;
  const row = value.jvm;
  const generated = {
    directorySha256: witness.jvm.generated.directorySha256,
    member: null,
  };
  const libraryRoot = witness.jvm.inputs.libraries?.directorySha256;
  const wildcard = { directorySha256: libraryRoot, member: "*" };
  const library =
    witness.family === "kotlin"
      ? { directorySha256: libraryRoot, member: "kotlin-stdlib.jar" }
      : wildcard;
  const expectedClasspaths =
    value.stage === "compiler"
      ? witness.family === "java"
        ? []
        : [[wildcard], [library]]
      : [witness.family === "java" ? [generated] : [generated, library]];
  assert.deepEqual(
    row.classpaths,
    expectedClasspaths,
    "Actual JVM compiler or runtime classpath contains unobserved dependencies",
  );
  assert.deepEqual(row.inputsBefore, witness.jvm.inputs);
  assert.deepEqual(
    row.inputsAfter,
    witness.jvm.inputs,
    "JVM runtime or compiler dependencies changed",
  );
  assert.equal(
    row.commandDirectorySha256,
    witness.jvm.generated.directorySha256,
    "Actual JVM command does not bind the produced class directory",
  );
  assert.deepEqual(
    row.generatedAfter,
    witness.jvm.generated,
    "Generated JVM artifacts changed",
  );
  if (value.stage === "compiler") {
    inspectJvmDirectory(row.generatedBefore, true);
    assert.deepEqual(
      row.generatedBefore.files,
      [],
      "JVM compilation did not start from an empty original output directory",
    );
  } else assert.deepEqual(row.generatedBefore, witness.jvm.generated);
}
export function inspectJvmWitness(row) {
  assert.ok(
    row.jvm,
    "JVM witness lacks reached dependency and artifact observations",
  );
  inspectJvmInputs(row.jvm.inputs, row.family);
  inspectJvmDirectory(row.jvm.generated);
  const names = row.jvm.generated.files.map((file) => file.path);
  assert.ok(
    names.includes(
      row.family === "kotlin" ? "WitnessKt.class" : "Witness.class",
    ),
  );
  for (const directory of ["policy/", "consumer/"])
    assert.ok(
      names.some(
        (name) => name.startsWith(directory) && name.endsWith(".class"),
      ),
      "Original JVM producer or consumer class is missing",
    );
  assert.equal(row.tool.sha256, row.jvm.inputs.compiler.sha256);
  assert.equal(row.invocation.executableSha256, row.jvm.inputs.runtime.sha256);
  assert.ok(
    isDeepStrictEqual(row.jvm.inputs, row.jvm.afterInputs),
    "JVM dependencies changed after the runtime",
  );
}
