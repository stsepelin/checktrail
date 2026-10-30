#!/usr/bin/env node
import assert from "node:assert/strict";
import process from "node:process";
import {
  readConsumerDockerCaptureContext,
  runCapturedConsumerDocker,
} from "./consumer-native-docker-storage.mjs";
const filename = process.env.CHECKTRAIL_CONSUMER_DOCKER_CONTEXT;
assert.ok(filename, "Native capture wrapper requires private operator context");
try {
  const context = readConsumerDockerCaptureContext(filename);
  const result = await runCapturedConsumerDocker(
    process.argv.slice(2),
    context,
  );
  process.exitCode =
    result.complete && Number.isInteger(result.status) ? result.status : 1;
} catch (error) {
  process.stderr.write("Native Docker capture failed: " + String(error) + "\n");
  process.exitCode = 1;
}
