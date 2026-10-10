import process from "node:process";
import path from "node:path";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { mavenHash } from "./maven.js";
export const kubernetesExtensionProfile = "kubernetes-1.36-extended-kinds-v1";
export const kubernetesExtensionPins = [
  {
    file: "statefulset-apps-v1.json",
    bytes: 739077,
    sha256: "cfa6579916fc2a1be0deb6372a3c67c3747a212131d0cb7b342d645f65639987",
    kind: "StatefulSet",
    version: "apps/v1",
  },
  {
    file: "daemonset-apps-v1.json",
    bytes: 690841,
    sha256: "1cee9fe50cbcbb91df4fa0eadbef134916c865037a0eba7675d4ae4c8e45a1b9",
    kind: "DaemonSet",
    version: "apps/v1",
  },
  {
    file: "job-batch-v1.json",
    bytes: 709299,
    sha256: "f49fee30367890a492146d63c3c433a7853e9088ebfe9e25cc792ec4b1400f18",
    kind: "Job",
    version: "batch/v1",
  },
  {
    file: "cronjob-batch-v1.json",
    bytes: 814829,
    sha256: "adc506e976a783ff7ff9c12d1633a11d40a4ff6fef64e576e6fc423668f0b7c5",
    kind: "CronJob",
    version: "batch/v1",
  },
  {
    file: "ingress-networking-v1.json",
    bytes: 35503,
    sha256: "4e0f63ad84c2bf22565e489d1f4b885ddaa9f6bf7cff1ddd562553760afe4d79",
    kind: "Ingress",
    version: "networking.k8s.io/v1",
  },
  {
    file: "secret-v1.json",
    bytes: 17311,
    sha256: "de761ccb06bd1d2c641fb57397f61b68e7ff53a384f0817ce40e5ded8cee86f3",
    kind: "Secret",
    version: "v1",
  },
  {
    file: "namespace-v1.json",
    bytes: 18892,
    sha256: "324fae677b98d1a6d54340db0c334d053e8ffbafceb3f73326e41de2610d5843",
    kind: "Namespace",
    version: "v1",
  },
  {
    file: "role-rbac-v1.json",
    bytes: 18914,
    sha256: "dfe8fb03b1642f985b57b12edd1727b6867c13ed4b6761ef81bdd51b1d236711",
    kind: "Role",
    version: "rbac.authorization.k8s.io/v1",
  },
  {
    file: "rolebinding-rbac-v1.json",
    bytes: 18581,
    sha256: "b12ea4163fc37df2e02192b4291b1b7c28836e3e7665d989dd538bfcffa10076",
    kind: "RoleBinding",
    version: "rbac.authorization.k8s.io/v1",
  },
  {
    file: "persistentvolumeclaim-v1.json",
    bytes: 36227,
    sha256: "6136871ac0337f11a48da5231a2807407c7386967e3432f344141b902f6a538c",
    kind: "PersistentVolumeClaim",
    version: "v1",
  },
] as const;
// Planning reads the selected native bytes; it does not invoke the tool.
export async function verifyKubernetesExtensionTool(expectedSha256: string) {
  if (process.platform !== "linux" || process.arch !== "arm64")
    throw Error("Select the pinned Linux ARM64 Kubernetes validator");
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const file = path.resolve(directory, "kubeconform");
    try {
      await access(file, constants.X_OK);
    } catch {
      continue;
    }
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 128 * 1024 * 1024 ||
      (await realpath(file)) !== file
    )
      throw Error("Select a bounded regular native validator");
    const bytes = await readFile(file);
    if (bytes.length !== info.size || mavenHash(bytes) !== expectedSha256)
      throw Error("Selected native validator bytes differ");
    return file;
  }
  throw Error("Prepare the pinned native Kubernetes validator");
}

export function verifyCurrentKubernetesExtensionInputs(
  root: string,
  project: string,
  inputs: { path: string; text: string; sha256: string }[],
  schemaDirectory: string,
  schemaPins: readonly { file: string; bytes: number; sha256: string }[],
  tool: { entry: string; resolved: string; sha256: string },
) {
  if (
    !path.isAbsolute(root) ||
    path.normalize(root) !== root ||
    realpathSync(root) !== root
  )
    throw Error("Current source root is not canonical");
  const base = path.resolve(root, project),
    relative = path.relative(root, base);
  if (
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  )
    throw Error("Current project leaves the source root");
  const physical = (
    file: string,
    bound: number,
    sha256: string,
    size?: number,
  ) => {
    const info = lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > bound ||
      realpathSync(file) !== file
    )
      throw Error("Current input is not a bounded regular file");
    const bytes = readFileSync(file);
    if (
      bytes.length !== info.size ||
      (size !== undefined && bytes.length !== size) ||
      mavenHash(bytes) !== sha256
    )
      throw Error("Current physical input bytes differ");
  };
  for (const input of inputs)
    physical(path.join(base, input.path), 80 * 1024, input.sha256);
  for (const pin of schemaPins)
    physical(
      path.join(base, schemaDirectory, pin.file),
      1024 * 1024,
      pin.sha256,
      pin.bytes,
    );
  if (tool.entry !== tool.resolved)
    throw Error("Current native tool path differs");
  physical(tool.resolved, 128 * 1024 * 1024, tool.sha256);
}
