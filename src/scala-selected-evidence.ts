import { scalaConfigSchema } from "./scala.js";
import { scalaEvidence } from "./scala-evidence.js";
import { scala2Evidence } from "./scala2-evidence.js";
import { scalaExtensionEvidence } from "./scala-extension-evidence.js";
import type { Check, ProcessResult } from "./types.js";
export function selectedScalaEvidence(
  check: Check,
  processes: ProcessResult[],
  root: string | undefined,
) {
  try {
    const config = scalaConfigSchema.parse(
      JSON.parse(check.commands[0]!.args[2]!).config,
    );
    return config.profile === "linux-arm64-scala2-typed-class-v1"
      ? scala2Evidence(check, processes, root)
      : config.extensions
        ? scalaExtensionEvidence(check, processes, root)
        : scalaEvidence(check, processes, root);
  } catch {
    return {
      status: "inconclusive" as const,
      reason: "Selected Scala declaration is unavailable or malformed",
      findingsComplete: false,
    };
  }
}
