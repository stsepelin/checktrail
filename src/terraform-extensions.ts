import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  terraformProtectedEnvironment,
  terraformRequire,
} from "./terraform.js";
import { terraformExtensionsCurrent } from "./terraform-extensions-physical.js";
import type { Check, Inventory, Project } from "./types.js";
export async function terraformExtensionsCheck(
  source: Inventory,
  project: Project,
): Promise<Check> {
  const check: Check = {
    id: "infrastructure.terraform-extensions",
    adapter: "infrastructure",
    project: project.path,
    scope: project.files,
    kind: "analysis",
    parser: "terraform-extensions-json",
    commands: [],
    reason:
      "Validate declared local HCL/JSON modules against a pinned offline provider and complete native schema; no plan or apply.",
  };
  try {
    const directory = path.join(source.root, project.path),
      current = terraformExtensionsCurrent(directory);
    const prefix = project.path === "." ? "" : project.path + "/";
    terraformRequire(
      isDeepStrictEqual(
        current.files,
        source.files
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length)),
      ),
      "Planning inventory and current physical source differ",
    );
    const serialized = JSON.stringify(current.invocation);
    terraformRequire(
      Buffer.byteLength(serialized) <= 96 * 1024,
      "Invocation bound",
    );
    const providerRoot =
      process.env.CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT ??
      path.join(source.root, ".checktrail/terraform-extensions-tools");
    check.scope = current.files;
    check.commands.push({
      executable: process.execPath,
      args: [
        fileURLToPath(
          new URL("./terraform-extensions-runner.js", import.meta.url),
        ),
        source.root,
        serialized,
      ],
      cwd: project.path,
      temporaryDirectory: true,
      env: {
        ...Object.fromEntries(
          terraformProtectedEnvironment.map((key) => [key, ""]),
        ),
        TF_CLI_ARGS_providers: "",
        NODE_OPTIONS: "",
        NODE_PATH: "",
        PATH: process.env.PATH ?? "",
        CHECKTRAIL_TERRAFORM_EXTENSIONS_PROVIDER_ROOT: providerRoot,
      },
    });
  } catch {
    check.unavailableReason =
      "Terraform extension prerequisites are invalid incomplete or outside the declared local module/provider profile.";
  }
  return check;
}
