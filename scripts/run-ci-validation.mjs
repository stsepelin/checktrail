import { runValidationLanes } from "./ci-validation.mjs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const cancellation = new globalThis.AbortController();
const abort = () => cancellation.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
try {
  const result = await runValidationLanes(
    fileURLToPath(new URL("../", import.meta.url)),
    {
      signal: cancellation.signal,
      progress: (event) => process.stderr.write(JSON.stringify(event) + "\n"),
      emitLog: ({ lane, script }, bytes) => {
        process.stdout.write("::group::" + lane + ": " + script + "\n");
        process.stdout.write(bytes);
        process.stdout.write("\n::endgroup::\n");
      },
    },
  );
  process.stdout.write(JSON.stringify(result) + "\n");
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
