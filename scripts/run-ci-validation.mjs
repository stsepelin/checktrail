import { runValidationLanes } from "./ci-validation.mjs";
import {
  parseValidationShardArgs,
  selectValidationShard,
} from "./ci-validation-shards.mjs";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
const shard = parseValidationShardArgs(process.argv.slice(2));
const selected = shard === undefined ? {} : selectValidationShard(shard);
const cancellation = new globalThis.AbortController();
const abort = () => cancellation.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
try {
  const result = await runValidationLanes(
    fileURLToPath(new URL("../", import.meta.url)),
    {
      ...selected,
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
