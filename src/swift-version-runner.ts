import { spawnSync } from "node:child_process";
import { swiftToolsProtectedEnvironment } from "./swift-tools.js";
const probes = {
  swift: { executable: "swiftc", args: ["--version"] },
  swiftpm: { executable: "swift", args: ["package", "--version"] },
  swiftlint: { executable: "swiftlint", args: ["version"] },
};
const name = process.argv[2];
if (!name || !Object.hasOwn(probes, name) || process.argv.length !== 3) {
  process.stderr.write("Swift version probe selection unavailable\n");
  process.exitCode = 2;
} else {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      swiftToolsProtectedEnvironment.includes(key) ||
      /^(?:SWIFT_|SWIFTPM_|SWIFTLINT_|SCRIPT_INPUT_|DYLD_)/.test(key)
    )
      delete env[key];
  const probe = probes[name as keyof typeof probes],
    result = spawnSync(probe.executable, probe.args, {
      env,
      encoding: "utf8",
      maxBuffer: 8192,
      timeout: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  if (result.error || result.signal || result.status === null) {
    process.stderr.write("Swift version probe incomplete\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.status;
  }
}
