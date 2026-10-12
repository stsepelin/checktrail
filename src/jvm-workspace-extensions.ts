import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  lstat,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { jvmWrapperArchives } from "./jvm-wrapper-pins.js";
import type { JvmExtensions, JvmKind } from "./jvm-extensions.js";
import type { JvmInvoke } from "./jvm-invoke.js";
const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const jvmGeneratedSchema = z
  .array(
    z.strictObject({
      source: z.string(),
      sourceSha256: digest,
      outputs: z
        .array(
          z.strictObject({
            path: z.string(),
            className: z.string(),
            bytes: z.number().int().positive().max(131072),
            sha256: digest,
          }),
        )
        .min(1)
        .max(32),
    }),
  )
  .max(8);
export type JvmGenerated = z.infer<typeof jvmGeneratedSchema>;
export async function stageJvmWrapper(
  workspace: string,
  kind: JvmKind,
  archive: string,
) {
  const relative =
    kind === "maven"
      ? ".mvn/wrapper/maven-wrapper.properties"
      : "gradle/wrapper/gradle-wrapper.properties";
  const file = path.join(workspace, relative);
  const original = await readFile(file);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(original);
  if (
    text.split("\n").filter((line) => line.startsWith("distributionUrl="))
      .length !== 1
  )
    throw Error("Wrapper distribution URL must have one exact declaration");
  const staged = Buffer.from(
    text.replace(
      /^distributionUrl=.*$/m,
      "distributionUrl=" + pathToFileURL(archive).href.replaceAll(":", "\\:"),
    ),
  );
  await writeFile(file, staged);
  return {
    file: relative,
    originalSha256: hash(original),
    stagedSha256: hash(staged),
    archiveSha256: jvmWrapperArchives[kind].sha256,
  };
}
export async function findJvmWrapperDistribution(root: string, kind: JvmKind) {
  const name = kind === "maven" ? "apache-maven-3.10.0" : "gradle-9.8.0";
  const matches: string[] = [];
  let entries = 0;
  const walk = async (directory: string, depth: number) => {
    if (depth > 7) throw Error("Wrapper cache depth bound");
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 2048 || item.isSymbolicLink())
        throw Error("Wrapper cache inventory bound or link");
      const file = path.join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name === name) matches.push(await realpath(file));
        else await walk(file, depth + 1);
      } else if (!item.isFile())
        throw Error("Wrapper cache contains a special entry");
    }
  };
  await walk(root, 0);
  if (matches.length !== 1)
    throw Error("Wrapper bootstrap must produce one selected distribution");
  return matches[0]!;
}
export async function generateJvmSources(
  extensions: Pick<JvmExtensions, "generators">,
  inputs: { path: string; sha256: string }[],
  workspace: string,
  temporary: string,
  invoke: JvmInvoke,
): Promise<JvmGenerated> {
  const receipts: JvmGenerated = [];
  let bytesTotal = 0;
  for (const [index, generator] of extensions.generators.entries()) {
    const input = inputs.find((i) => i.path === generator.source);
    if (
      !input ||
      hash(await readFile(path.join(workspace, generator.source))) !==
        input.sha256
    )
      throw Error("Java generator source does not match the planned input");
    const directory = path.join(temporary, "generator-" + index),
      classes = path.join(directory, "classes"),
      output = path.join(directory, "output");
    await mkdir(classes, { recursive: true });
    await mkdir(output);
    const compiled = await invoke(
      "javac",
      [
        "-proc:none",
        "-encoding",
        "UTF-8",
        "-d",
        classes,
        path.join(workspace, generator.source),
      ],
      directory,
    );
    if (compiled.status !== 0 || compiled.signal)
      throw Error("Declared native Java generator did not compile");
    const generated = await invoke(
      "java",
      [
        "--enable-native-access=ALL-UNNAMED",
        "-cp",
        classes,
        generator.className,
        output,
      ],
      directory,
    );
    if (generated.status !== 0 || generated.signal)
      throw Error("Declared native Java generator did not finish");
    const actual: string[] = [];
    let entries = 0;
    const walk = async (prefix: string) => {
      for (const entry of await readdir(path.join(output, prefix), {
        withFileTypes: true,
      })) {
        if (++entries > 512 || entry.isSymbolicLink())
          throw Error("Generated Java inventory bound or link");
        const relative = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) {
          if (relative.split("/").length > 32)
            throw Error("Generated Java directory depth");
          await walk(relative);
        } else if (entry.isFile()) actual.push(relative);
        else throw Error("Generated Java special entry");
      }
    };
    await walk("");
    const declared = generator.outputs.map((o) => o.file);
    if (
      new Set(actual).size !== actual.length ||
      JSON.stringify(actual.sort()) !== JSON.stringify([...declared].sort())
    )
      throw Error(
        "Generated Java outputs must match every declared output exactly",
      );
    const outputs: JvmGenerated[number]["outputs"] = [];
    // Validate every generated output before copying any output for this generator.
    const payloads = [];
    for (const item of generator.outputs) {
      const file = path.join(output, item.file),
        stat = await lstat(file);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 1 ||
        stat.size > 131072
      )
        throw Error("Generated Java source regular-file or size bound");
      const data = await readFile(file);
      bytesTotal += data.length;
      if (data.length !== stat.size || bytesTotal > 2 * 1024 * 1024)
        throw Error("Generated Java total byte bound");
      new TextDecoder("utf-8", { fatal: true }).decode(data);
      payloads.push({ item, data });
    }
    for (const { item, data } of payloads) {
      const relative = path.posix.join(generator.module, item.file),
        destination = path.join(workspace, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, data, { flag: "wx" });
      outputs.push({
        path: relative,
        className: item.className,
        bytes: data.length,
        sha256: hash(data),
      });
    }
    receipts.push({
      source: generator.source,
      sourceSha256: input.sha256,
      outputs,
    });
  }
  return jvmGeneratedSchema.parse(receipts);
}
export const jvmModuleWitnessSchema = z
  .array(
    z.strictObject({
      module: z.string(),
      name: z.string(),
      requires: z.array(z.string()).max(64),
      exports: z.array(z.string()).max(64),
      bytes: z.number().int().positive().max(1048576),
      sha256: digest,
    }),
  )
  .max(64);
export const jvmModuleObserverSource = String.raw`import java.nio.file.*;
import java.nio.ByteBuffer;
import java.lang.module.ModuleDescriptor;
import java.security.MessageDigest;
import java.util.*;
public class VerifierJvmModules {
 static String quote(String text){StringBuilder out=new StringBuilder("\"");for(char c:text.toCharArray()){if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32||Character.isSurrogate(c))out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();}
 static String list(Collection<String> values){return "["+String.join(",",values.stream().sorted().map(VerifierJvmModules::quote).toList())+"]";}
 public static void main(String[] args)throws Exception{
  if(args.length%2!=0||args.length>128)throw new IllegalArgumentException("Module witness bound");
  var entries=new ArrayList<String>();
  for(int i=0;i<args.length;i+=2){Path file=Path.of(args[i+1]);if(Files.isSymbolicLink(file)||!Files.isRegularFile(file)||Files.size(file)>1048576)throw new IllegalStateException("Native descriptor bound");byte[] bytes=Files.readAllBytes(file);ModuleDescriptor d=ModuleDescriptor.read(ByteBuffer.wrap(bytes));
   if(d.isOpen()||d.isAutomatic()||!d.opens().isEmpty()||!d.uses().isEmpty()||!d.provides().isEmpty()||d.exports().stream().anyMatch(ModuleDescriptor.Exports::isQualified))throw new IllegalStateException("Unsupported open, service or qualified JPMS descriptor");
   for(var r:d.requires()){Set<ModuleDescriptor.Requires.Modifier> expected=r.name().equals("java.base")?Set.of(ModuleDescriptor.Requires.Modifier.MANDATED):Set.of();if(!r.modifiers().equals(expected))throw new IllegalStateException("Unsupported JPMS requires modifier");}
   entries.add("{\"module\":"+quote(args[i])+",\"name\":"+quote(d.name())+",\"requires\":"+list(d.requires().stream().map(ModuleDescriptor.Requires::name).toList())+",\"exports\":"+list(d.exports().stream().map(ModuleDescriptor.Exports::source).toList())+",\"bytes\":"+bytes.length+",\"sha256\":"+quote(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))+"}");}
  System.out.println("["+String.join(",",entries)+"]");
 }
}`;
export async function captureJvmModules(
  extensions: JvmExtensions,
  workspace: string,
  temporary: string,
  kind: JvmKind,
  invoke: JvmInvoke,
) {
  if (!extensions.jpms.length) return [];
  const classes = path.join(temporary, "module-observer");
  await mkdir(classes);
  const source = path.join(classes, "VerifierJvmModules.java");
  await writeFile(source, jvmModuleObserverSource, { flag: "wx" });
  const compiled = await invoke(
    "javac",
    ["-proc:none", "-encoding", "UTF-8", "-d", classes, source],
    classes,
  );
  if (compiled.status !== 0 || compiled.signal)
    throw Error("Native module observer did not compile");
  const result = await invoke(
    "java",
    [
      "-cp",
      classes,
      "VerifierJvmModules",
      ...extensions.jpms.flatMap((m) => [
        m.module,
        path.join(
          workspace,
          m.module,
          kind === "maven"
            ? "target/classes/module-info.class"
            : "build/classes/java/main/module-info.class",
        ),
      ]),
    ],
    classes,
  );
  if (result.status !== 0 || result.signal)
    throw Error("Native module descriptor collection failed");
  return jvmModuleWitnessSchema.parse(JSON.parse(result.stdout));
}
export const jvmGeneratedClassSchema = z
  .array(
    z.strictObject({
      path: z.string(),
      className: z.string(),
      sourceFile: z.string(),
      bytes: z.number().int().positive().max(1048576),
      sha256: digest,
    }),
  )
  .max(256);
export const jvmGeneratedClassObserverSource = String.raw`import java.nio.file.*;
import java.lang.classfile.*;
import java.security.MessageDigest;
import java.util.*;
public class VerifierJvmGeneratedClasses {
 static String quote(String text){StringBuilder out=new StringBuilder("\"");for(char c:text.toCharArray()){if(c=='"'||c=='\\')out.append('\\').append(c);else if(c<32||Character.isSurrogate(c))out.append(String.format("\\u%04x",(int)c));else out.append(c);}return out.append('"').toString();}
 public static void main(String[] args)throws Exception{
  if(args.length%2!=0||args.length>512)throw new IllegalArgumentException("Generated class witness bound");
  var result=new ArrayList<String>();
  for(int i=0;i<args.length;i+=2){Path file=Path.of(args[i+1]);if(Files.isSymbolicLink(file)||!Files.isRegularFile(file)||Files.size(file)>1048576)throw new IllegalStateException("Generated class file bound");byte[] bytes=Files.readAllBytes(file);var model=ClassFile.of().parse(bytes);String name=model.thisClass().asInternalName().replace('/','.');String source=model.findAttribute(Attributes.sourceFile()).orElseThrow().sourceFile().stringValue();result.add("{\"path\":"+quote(args[i])+",\"className\":"+quote(name)+",\"sourceFile\":"+quote(source)+",\"bytes\":"+bytes.length+",\"sha256\":"+quote(HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)))+"}");}
  System.out.println("["+String.join(",",result)+"]");
 }
}`;
export async function captureJvmGeneratedClasses(
  extensions: JvmExtensions,
  workspace: string,
  temporary: string,
  kind: JvmKind,
  invoke: JvmInvoke,
) {
  const outputs = extensions.generators.flatMap((generator) =>
    generator.outputs.map((o) => ({ ...o, module: generator.module })),
  );
  if (!outputs.length) return [];
  const classes = path.join(temporary, "generated-class-observer");
  await mkdir(classes);
  const source = path.join(classes, "VerifierJvmGeneratedClasses.java");
  await writeFile(source, jvmGeneratedClassObserverSource, { flag: "wx" });
  const compiled = await invoke(
    "javac",
    ["-proc:none", "-encoding", "UTF-8", "-d", classes, source],
    classes,
  );
  if (compiled.status !== 0 || compiled.signal)
    throw Error("Native generated-class observer did not compile");
  const result = await invoke(
    "java",
    [
      "-cp",
      classes,
      "VerifierJvmGeneratedClasses",
      ...outputs.flatMap((o) => [
        path.posix.join(o.module, o.file),
        path.join(
          workspace,
          o.module,
          kind === "maven" ? "target/classes" : "build/classes/java/main",
          o.className.replaceAll(".", "/") + ".class",
        ),
      ]),
    ],
    classes,
  );
  if (result.status !== 0 || result.signal)
    throw Error("Native generated class collection failed");
  return jvmGeneratedClassSchema.parse(JSON.parse(result.stdout));
}
export const jvmExtensionPacketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nativeToolchainVerified: z.literal(true),
  wrapper: z.strictObject({
    file: z.string(),
    originalSha256: digest,
    stagedSha256: digest,
    archiveSha256: digest,
    installedDistributionVerified: z.literal(true),
  }),
  generated: jvmGeneratedSchema,
  modules: jvmModuleWitnessSchema,
  generatedClasses: jvmGeneratedClassSchema,
});
