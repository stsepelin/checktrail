import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import { catalog, legacyCatalog } from "./producer/catalog.mjs";
const producer = await readFile(
  new URL("./producer/catalog.mjs", import.meta.url),
  "utf8",
);
const consumer = await readFile(
  new URL("./consumer/catalog.schema.json", import.meta.url),
  "utf8",
);
const fingerprint = (text) => createHash("sha256").update(text).digest("hex");
const result = process.argv.includes("--broken") ? legacyCatalog() : catalog();
process.stdout.write(
  JSON.stringify(
    {
      schemaVersion: 1,
      format: "contract-samples",
      capturedAt: new Date().toISOString(),
      contracts: [
        {
          id: "catalog-response",
          producer: {
            name: "catalog-api",
            sourceFingerprint: fingerprint(producer),
          },
          consumer: {
            name: "catalog-web",
            sourceFingerprint: fingerprint(consumer),
          },
          complete: true,
          schema: JSON.parse(consumer),
          samples: [
            {
              name: "serialized-catalog",
              payload: JSON.parse(JSON.stringify(result)),
            },
          ],
        },
      ],
    },
    null,
    2,
  ) + "\n",
);
