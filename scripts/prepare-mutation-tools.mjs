import path from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { prepareJavaScriptTools } from "./prepare-javascript-tools.mjs";

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await prepareJavaScriptTools(
    fileURLToPath(
      new URL("../.checktrail/mutation-javascript-tools", import.meta.url),
    ),
  );
