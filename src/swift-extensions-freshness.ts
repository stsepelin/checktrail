import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inventorySourcePath } from "./inventory.js";
import { mavenHash } from "./maven.js";
import { swiftRequire, swiftSame } from "./swift-native.js";
import {
  swiftExtensionsConfigSchema,
  swiftExtensionsInvocationSchema,
  swiftExtensionsScope,
} from "./swift-extensions-contract.js";
import { swiftExtensionsPolicyFile } from "./swift-extensions.js";
import type { Check } from "./types.js";
/** Re-importing a receipt requires current physical inputs and their complete inventoried cohort. */
export function swiftExtensionsFreshness(
  check: Check,
  root: string | undefined,
) {
  swiftRequire(
    root && path.isAbsolute(root) && realpathSync(root) === root,
    "Swift extension current root unavailable",
  );
  const invocation = swiftExtensionsInvocationSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!),
    ),
    directory = path.join(root!, check.project),
    files: string[] = [];
  let entries = 0,
    total = 0;
  const read = (file: string) => {
    swiftRequire(
      realpathSync(file) === file,
      "Swift extension current input alias unsupported",
    );
    const stat = lstatSync(file);
    swiftRequire(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4 * 1024 * 1024,
      "Swift extension current input is not bounded regular",
    );
    const data = readFileSync(file);
    swiftRequire(
      data.length === stat.size,
      "Swift extension current input changed size",
    );
    return data;
  };
  const walk = (relative: string, depth: number) => {
    swiftRequire(depth <= 32, "Swift extension current input depth bound");
    for (const entry of readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      swiftRequire(
        ++entries <= 20000,
        "Swift extension current inventory entry bound",
      );
      const file = path.posix.join(relative, entry.name);
      if (!inventorySourcePath(file)) continue;
      if (entry.isSymbolicLink())
        throw Error(
          "Swift extension current inventoried input alias unsupported",
        );
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile()) {
        files.push(file);
        swiftRequire(
          files.length <= 4096,
          "Swift extension current inventory file bound",
        );
        total += lstatSync(path.join(directory, file)).size;
        swiftRequire(
          total <= 64 * 1024 * 1024,
          "Swift extension current input total bound",
        );
      } else throw Error("Swift extension current input not regular");
    }
  };
  walk(".", 0);
  swiftRequire(
    swiftSame(
      files,
      invocation.inputs.map((p) => p.path),
    ),
    "Swift extension current input inventory differs",
  );
  for (const pin of invocation.inputs)
    swiftRequire(
      mavenHash(read(path.join(directory, pin.path))) === pin.sha256,
      "Swift extension current source bytes differ",
    );
  const configBytes = read(path.join(directory, swiftExtensionsPolicyFile));
  swiftRequire(
    mavenHash(configBytes) === invocation.configSha256,
    "Swift extension current policy bytes differ",
  );
  const config = swiftExtensionsConfigSchema.parse(
    JSON.parse(configBytes.toString("utf8")),
  );
  swiftExtensionsScope(config, files);
  swiftRequire(
    isDeepStrictEqual(
      check.scope,
      invocation.inputs.map((p) => p.path),
    ),
    "Swift extension planned scope differs",
  );
  return { config, invocation };
}
