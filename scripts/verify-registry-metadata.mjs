import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";

if (process.argv.length !== 3)
  throw new Error("Provide the downloaded official registry schema file path");
const bytes = await readFile(process.argv[2]);
assert.equal(
  createHash("sha256").update(bytes).digest("hex"),
  "3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0",
  "Review and update the schema pin explicitly if the official schema changes",
);
const schema = JSON.parse(bytes.toString("utf8"));
const metadata = JSON.parse(
  await readFile(new URL("../server.json", import.meta.url), "utf8"),
);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
assert.equal(validate(metadata), true, JSON.stringify(validate.errors));
assert.equal(metadata.$schema, schema.$id);
process.stdout.write(
  `${JSON.stringify({ schema: schema.$id, schemaSha256: createHash("sha256").update(bytes).digest("hex"), valid: true, publication: "not performed" })}\n`,
);
