import { vbGrammarAsset } from "./review-vb-grammar-assets.js";
import { grammarAssets } from "./review-grammar-assets.js";
export function selectedGrammar(file: string, vb = false, cpp = false) {
  if (cpp && file.endsWith(".h"))
    return grammarAssets.find((asset) => asset.grammar === "cpp");
  if (vb && file.endsWith(".vb")) return vbGrammarAsset;
  const extension = file.split(".").at(-1)!.toLowerCase();
  const grammar = (
    {
      py: "python",
      go: "go",
      php: "php",
      rs: "rust",
      java: "java",
      kt: "kotlin",
      kts: "kotlin",
      scala: "scala",
      sc: "scala",
      cs: "c_sharp",
      fs: "fsharp",
      fsx: "fsharp",
      fsi: "fsharp_signature",
      rb: "ruby",
      swift: "swift",
      c: "c",
      h: "c",
      cc: "cpp",
      cpp: "cpp",
      cxx: "cpp",
      hpp: "cpp",
      hh: "cpp",
      hxx: "cpp",
      tf: "hcl",
      hcl: "hcl",
      yaml: "yaml",
      yml: "yaml",
    } as Record<string, string>
  )[extension];
  return grammar
    ? grammarAssets.find((asset) => asset.grammar === grammar)
    : undefined;
}
