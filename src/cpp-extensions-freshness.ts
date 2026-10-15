import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventorySourcePath } from "./inventory.js";
import { mavenHash } from "./maven.js";
import { cppRequire, cppSame } from "./cpp-tools.js";
import { cppMd5 } from "./cpp-native.js";
import {
  cppExtensionsConfigSchema,
  cppExtensionsScope,
} from "./cpp-extensions-contract.js";
import {
  cppExtensionsPolicyFile,
  cppExtensionsInvocationSchema,
} from "./cpp-extensions.js";
import type { Check } from "./types.js";
/** Re-importing a receipt requires current physical inputs and their complete inventoried cohort. */
export function cppExtensionsFreshness(check: Check, root: string | undefined) {
  cppRequire(
    root && path.isAbsolute(root) && realpathSync(root) === root,
    "C/C++ extension current root unavailable",
  );
  const invocation = cppExtensionsInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    ),
    directory = path.join(root!, check.project),
    files: string[] = [];
  cppRequire(
    (directory === root || directory.startsWith(root + path.sep)) &&
      realpathSync(directory) === directory,
    "C/C++ extension current project escapes root",
  );
  let entries = 0,
    total = 0;
  const read = (file: string) => {
    cppRequire(
      realpathSync(file) === file,
      "C/C++ extension current input alias unsupported",
    );
    const stat = lstatSync(file);
    cppRequire(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024,
      "C/C++ extension current input is not bounded regular",
    );
    const data = readFileSync(file);
    cppRequire(
      data.length === stat.size,
      "C/C++ extension current input changed size",
    );
    return data;
  };
  const walk = (relative: string, depth: number) => {
    cppRequire(depth <= 32, "C/C++ extension current input depth bound");
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      cppRequire(
        ++entries <= 20000,
        "C/C++ extension current inventory entry bound",
      );
      const file = path.posix.join(relative, entry.name);
      if (!inventorySourcePath(file)) continue;
      if (entry.isSymbolicLink())
        throw Error(
          "C/C++ extension current inventoried input alias unsupported",
        );
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile()) {
        files.push(file);
        cppRequire(
          files.length <= 4096,
          "C/C++ extension current inventory file bound",
        );
        total += lstatSync(path.join(directory, file)).size;
        cppRequire(
          total <= 64 * 1024 * 1024,
          "C/C++ extension current input total bound",
        );
      } else throw Error("C/C++ extension current input not regular");
    }
  };
  walk(".", 0);
  cppRequire(
    cppSame(
      files,
      invocation.inputs.map((p) => p.path),
    ),
    "C/C++ extension current input inventory differs",
  );
  for (const pin of invocation.inputs) {
    const bytes = read(path.join(directory, pin.path));
    cppRequire(
      mavenHash(bytes) === pin.sha256 && cppMd5(bytes) === pin.md5,
      "C/C++ extension current source bytes differ",
    );
  }
  const configBytes = read(path.join(directory, cppExtensionsPolicyFile));
  cppRequire(
    mavenHash(configBytes) === invocation.configSha256,
    "C/C++ extension current policy bytes differ",
  );
  const config = cppExtensionsConfigSchema.parse(
    JSON.parse(configBytes.toString("utf8")),
  );
  cppExtensionsScope(config, files);
  cppRequire(
    isDeepStrictEqual(
      check.scope,
      invocation.inputs.map((p) => p.path),
    ),
    "C/C++ extension planned scope differs",
  );
  return { config, invocation, directory, read };
}
