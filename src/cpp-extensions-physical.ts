import path from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { cppRequire, cppSame } from "./cpp-tools.js";
import { cppArchive, cppWords } from "./cpp-native.js";
import { cppExtensionsDependencies } from "./cpp-extensions-sdk.js";
import {
  cppExtensionsArtifact,
  cppExtensionsDwarf,
  cppExtensionsCrtDebugPins,
  cppExtensionsCompileArgs,
  cppExtensionsFlags,
  cppExtensionsLinkClosure,
  cppExtensionsLinkRuntime,
  cppExtensionsUnits,
} from "./cpp-extensions-native.js";
import type { CppExtensionsPacket } from "./cpp-extensions-packet.js";
type Receipt = CppExtensionsPacket["receipts"][number];
/** Reconcile native physical participation; parsed command spelling is never executed. */
export function cppExtensionsPhysical(
  packet: CppExtensionsPacket,
  inputMd5: Map<string, string>,
  artifact: (file: string, encoding?: "utf8" | "base64") => string,
  receipt: (phase: string, name: string, args: string[]) => Receipt,
  compiled: Receipt,
) {
  const { config: c, workspace, build } = packet;
  const units = cppExtensionsUnits(c),
    observed = new Set<string>(),
    usedSdk = new Set<string>();
  const entry = (name: string) =>
    packet.tools.find((t) => t.name === name)!.entry;
  const prebuiltDebug = new Map<string, string>();
  for (const pin of cppExtensionsCrtDebugPins) {
    cppRequire(
      c.sdk.some((p) => p.path === pin),
      "SDK CRT debug bytes undeclared",
    );
    const row = receipt("sdk-dwarf:" + pin, "llvm-dwarfdump", [
      "--debug-line",
      "/" + pin,
    ]);
    cppRequire(
      row.exitCode === 0 && !row.stderr.trim(),
      "SDK CRT debug observation incomplete",
    );
    for (const [file, digest] of cppExtensionsDwarf(row.stdout)) {
      cppRequire(
        !file.startsWith(workspace + "/") &&
          !file.startsWith(build + "/") &&
          (!prebuiltDebug.has(file) || prebuiltDebug.get(file) === digest),
        "SDK CRT debug source ownership differs",
      );
      prebuiltDebug.set(file, digest);
    }
  }
  const expected = new Map(inputMd5);
  for (const g of packet.generated)
    expected.set(path.join(build, g.path), g.md5);
  cppRequire(
    cppSame(
      packet.sdkObserved.map((p) => p.path),
      [...new Set(packet.sdkObserved.map((p) => p.path))],
    ),
    "Repeated SDK observation",
  );
  for (const p of packet.sdkObserved) {
    const pin = c.sdk.find((x) => x.path === p.path);
    cppRequire(
      pin &&
        pin.resolved === p.resolved &&
        pin.bytes === p.bytes &&
        pin.sha256 === p.sha256,
      "SDK used byte/alias pin differs",
    );
  }
  const sdk = (absolute: string, md5?: string) => {
    const pin = packet.sdkObserved.find((p) => "/" + p.path === absolute);
    cppRequire(
      pin && (md5 === undefined || pin.md5 === md5),
      "Native SDK consumption missing or checksum differs",
    );
    usedSdk.add(pin.path);
  };
  const dwarf = (phase: string, file: string, required: string[]) => {
    const row = receipt(phase, "llvm-dwarfdump", [
      "--debug-line",
      path.join(build, file),
    ]);
    cppRequire(
      row.exitCode === 0 && !row.stderr.trim(),
      "Native line checksum collection incomplete",
    );
    const files = cppExtensionsDwarf(row.stdout);
    for (const [source, md5] of files) {
      if (
        units.some(
          (u) =>
            u.language === "CXX" &&
            source === path.join(build, u.directory, "<stdin>"),
        )
      ) {
        cppRequire(
          md5 === "0".repeat(32),
          "Compiler virtual assembly record changed",
        );
        continue;
      }
      if (
        source.startsWith(workspace + "/") ||
        source.startsWith(build + "/")
      ) {
        cppRequire(
          expected.has(source) && expected.get(source) === md5,
          "Compiler-consumed local source or header checksum differs",
        );
        observed.add(source);
      } else if (prebuiltDebug.has(source)) {
        cppRequire(
          prebuiltDebug.get(source) === md5,
          "SDK CRT linked debug observation differs",
        );
      } else sdk(source, md5);
    }
    for (const source of required)
      cppRequire(
        files.has(source) && files.get(source) === expected.get(source),
        "Native object/link omits a compiled source",
      );
  };
  const nativeCommand = (words: string[], directory = ".") => {
    const prefix =
      directory === "." ? "" : `cd ${path.join(build, directory)} && `;
    const lines = compiled.stdout
      .split("\n")
      .filter((l) => l.startsWith(prefix + words[0] + " "));
    cppRequire(
      lines.some((l) => equal(cppWords(l.slice(prefix.length)), words)),
      "Native build omitted or changed physical command",
    );
    return compiled.stdout
      .split("\n")
      .findIndex(
        (l) =>
          l.startsWith(prefix + words[0] + " ") &&
          equal(cppWords(l.slice(prefix.length)), words),
      );
  };
  for (const unit of units) {
    const args = cppExtensionsCompileArgs(c, workspace, build, unit),
      insert = args.indexOf("-o"),
      object = path.posix.relative(unit.directory, unit.object);
    nativeCommand(
      [
        entry(unit.language === "C" ? "clang" : "clang++"),
        ...args.slice(0, insert),
        "-MD",
        "-MT",
        unit.object,
        "-MF",
        object + ".d",
        ...args.slice(insert),
      ],
      unit.directory,
    );
    const bytes = Buffer.from(artifact(unit.object, "base64"), "base64");
    cppRequire(
      bytes.length >= 64 &&
        bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        bytes.readUInt16LE(16) === 1 &&
        bytes.readUInt16LE(18) === 183,
      "Compiled object is not selected AArch64 ELF",
    );
    const dep = cppExtensionsDependencies(artifact(unit.object + ".d"));
    cppRequire(
      dep.output === unit.object &&
        !dep.phony.length &&
        new Set(dep.files).size === dep.files.length,
      "Native compiler dependency denominator differs",
    );
    const physical = dep.files.map((f) =>
      path.resolve(build, unit.directory, f),
    );
    cppRequire(
      physical.includes(path.join(workspace, unit.file)),
      "Native compiler dependency lacks primary source",
    );
    for (const source of physical) {
      if (expected.has(source)) continue;
      sdk(source);
    }
    dwarf("dwarf:" + unit.object, unit.object, [
      path.join(workspace, unit.file),
    ]);
  }
  cppRequire(
    cppSame(
      packet.binaries.map((b) => b.path),
      c.targets
        .filter((t) => t.type !== "static")
        .map((t) => cppExtensionsArtifact(c, t.name)),
    ) && packet.binaries.every((b) => b.sha256 === b.afterSha256),
    "Physical linked binary denominator or bytes differ",
  );
  for (const target of c.targets) {
    const binary = cppExtensionsArtifact(c, target.name),
      basename = path.posix.basename(binary),
      own = units.filter((u) => u.target === target.name),
      objects = own.map((u) => path.posix.relative(target.directory, u.object));
    const link = artifact(
      path.posix.join(
        target.directory,
        `CMakeFiles/${target.name}.dir/link.txt`,
      ),
    );
    if (target.type === "static") {
      const members = cppArchive(
        Buffer.from(artifact(binary, "base64"), "base64"),
      );
      cppRequire(
        cppSame(
          [...members.keys()],
          own.map((u) => path.basename(u.object)),
        ) &&
          own.every((u) =>
            members
              .get(path.basename(u.object))!
              .equals(Buffer.from(artifact(u.object, "base64"), "base64")),
          ),
        "Archived member/object bytes differ",
      );
      const commands = [
        [entry("llvm-ar"), "qc", basename, ...objects],
        [entry("llvm-ranlib"), basename],
      ];
      cppRequire(
        equal(link.trim().split("\n").map(cppWords), commands),
        "Archive command cohort differs",
      );
      for (const words of commands) nativeCommand(words);
      const row = receipt("archive:" + target.name, "llvm-ar", [
        "t",
        path.join(build, binary),
      ]);
      cppRequire(
        row.exitCode === 0 &&
          !row.stderr.trim() &&
          cppSame(
            row.stdout.trimEnd().split("\n"),
            own.map((u) => path.basename(u.object)),
          ),
        "Native archive member observation differs",
      );
      continue;
    }
    const linked = cppExtensionsLinkClosure(c, target.name),
      libraries = linked.map((n) =>
        path.posix.relative(target.directory, cppExtensionsArtifact(c, n)),
      );
    const language = [
      target,
      ...linked.map((n) => c.targets.find((t) => t.name === n)!),
    ].some((t) => t.sources.some((s) => s.endsWith(".cpp")))
      ? "CXX"
      : "C";
    const rpaths = [
      ...new Set(
        linked
          .filter((n) => c.targets.find((t) => t.name === n)!.type === "shared")
          .map((n) =>
            path.join(build, c.targets.find((t) => t.name === n)!.directory),
          ),
      ),
    ];
    const dependency = `CMakeFiles/${target.name}.dir/link.d`;
    const words = [
      entry(language === "C" ? "clang" : "clang++"),
      ...(target.type === "shared" ? ["-fPIC"] : []),
      ...cppExtensionsFlags(language),
      "-g",
      ...(target.type === "shared" ? ["-shared"] : []),
      "-Wl,--trace",
      "-Xlinker",
      "--dependency-file=" + dependency,
      ...(target.type === "shared"
        ? ["-Wl,-soname," + basename, "-o", basename, ...objects]
        : [...objects, "-o", basename]),
      ...(rpaths.length ? ["-Wl,-rpath," + rpaths.join(":")] : []),
      ...libraries,
    ];
    cppRequire(
      equal(cppWords(link), words),
      "Native linked object/interface/rpath command differs",
    );
    const commandIndex = nativeCommand(words);
    const dep = cppExtensionsDependencies(
      artifact(path.posix.join(target.directory, dependency)),
    );
    cppRequire(
      dep.output === basename && equal(dep.phony, dep.files),
      "Native linker complete ordered phony cohort differs",
    );
    const nativeRuntime = cppExtensionsLinkRuntime(
        language,
        target.type === "executable",
      ),
      nativeTrace = cppExtensionsLinkRuntime(
        language,
        target.type === "executable",
        true,
      );
    cppRequire(
      equal(dep.files, [
        ...nativeRuntime.prefix,
        ...objects,
        ...libraries,
        ...nativeRuntime.suffix,
      ]),
      "Complete native linker input order or multiplicity differs",
    );
    const trace = [
      ...nativeTrace.prefix,
      ...objects,
      ...libraries,
      ...nativeTrace.suffix,
    ];
    const following = compiled.stdout.split("\n").slice(commandIndex + 1),
      end = following.findIndex((l) =>
        /^make\[[0-9]+\]: Leaving directory /.test(l),
      );
    cppRequire(end > 0 && end <= 256, "Native linker trace terminator missing");
    const observedTrace = following.slice(0, end),
      normalized: string[] = [];
    for (let i = 0; i < observedTrace.length; i++) {
      const file = observedTrace[i]!;
      if (file === "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/libgcc.a") {
        let visits = 1;
        while (observedTrace[i + 1] === file) {
          visits++;
          i++;
        }
        // GNU ld may revisit this archive while resolving symbols. Its dependency
        // record keeps the fixed driver input groups; retain those separately.
        const required = language === "CXX" ? 2 : 1;
        cppRequire(
          visits >= required,
          "Native GCC archive trace visits missing",
        );
        normalized.push(...Array.from({ length: required }, () => file));
      } else normalized.push(file);
    }
    cppRequire(
      equal(normalized, trace),
      "Native linker trace participation differs",
    );
    const local = dep.files.filter((f) => !path.isAbsolute(f));
    cppRequire(
      equal(local, [...objects, ...libraries]),
      "Native linked object/library participation differs",
    );
    const runtime = dep.files.filter((f) => path.isAbsolute(f));
    for (const f of runtime) {
      cppRequire(
        !f.startsWith("/usr/include/") &&
          !f.startsWith("/usr/lib/llvm22/lib/clang/22/include/"),
        "Header used as linker runtime",
      );
      sdk(path.normalize(f));
    }
    const gcc = "/usr/lib/gcc/aarch64-alpine-linux-musl/15.2.0/";
    for (const f of [
      "/usr/lib/crti.o",
      gcc + "crtbeginS.o",
      "/usr/lib/libc.so",
      gcc + "crtendS.o",
      "/usr/lib/crtn.o",
      ...(target.type === "executable" ? ["/usr/lib/Scrt1.o"] : []),
      ...(language === "CXX" ? ["/usr/lib/libstdc++.so"] : []),
    ])
      cppRequire(
        runtime.includes(f),
        "Native linker omitted selected CRT/standard library role",
      );
    const elf = receipt("elf:" + target.name, "llvm-readelf", [
      "--wide",
      "--file-header",
      "--dynamic",
      "--symbols",
      path.join(build, binary),
    ]);
    cppRequire(
      elf.exitCode === 0 &&
        !elf.stderr.trim() &&
        /^ELF Header:\n/.test(elf.stdout) &&
        /^ {2}Class:[ \t]+ELF64$/m.test(elf.stdout) &&
        /^ {2}Data:[ \t]+2's complement, little endian$/m.test(elf.stdout) &&
        /^ {2}Machine:[ \t]+AArch64$/m.test(elf.stdout) &&
        /^ {2}Type:[ \t]+DYN \(Shared object file\)$/m.test(elf.stdout),
      "Native binary header observation differs",
    );
    const sonames = [
      ...elf.stdout.matchAll(/\(SONAME\)[ \t]+Library soname: \[([^\]]+)\]/g),
    ].map((m) => m[1]!);
    cppRequire(
      equal(sonames, target.type === "shared" ? [basename] : []),
      "Native shared object soname differs",
    );
    const paths = [
      ...elf.stdout.matchAll(/\(RUNPATH\)[ \t]+Library runpath: \[([^\]]+)\]/g),
    ].map((m) => m[1]!);
    cppRequire(
      equal(paths, rpaths.length ? [rpaths.join(":")] : []),
      "Native dynamic runtime path differs",
    );
    const needed = [
      ...elf.stdout.matchAll(/\(NEEDED\)[ \t]+Shared library: \[([^\]]+)\]/g),
    ].map((m) => m[1]!);
    cppRequire(
      new Set(needed).size === needed.length &&
        needed.every(
          (n) =>
            libraries.some((l) => path.posix.basename(l) === n) ||
            c.sdk.some((p) => path.posix.basename(p.path) === n),
        ),
      "Native dynamic dependency outside selected local/SDK closure",
    );
    cppRequire(
      elf.stdout.includes("Symbol table '.symtab'") &&
        elf.stdout.includes("Symbol table '.dynsym'"),
      "Native physical symbol tables missing",
    );
    dwarf(
      "dwarf:" + target.name,
      binary,
      target.sources.map((f) => path.join(workspace, f)),
    );
  }
  cppRequire(
    cppSame([...observed], [...expected.keys()]),
    "Compiler scope omits declared source/header or generated bytes",
  );
  cppRequire(
    cppSame(
      [...usedSdk],
      packet.sdkObserved.map((p) => p.path),
    ),
    "SDK used observation denominator differs",
  );
}
