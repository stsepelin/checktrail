import { test } from "node:test";
import { archiveStore } from "./attempt-whole-controls.js";
test(
  "native archive storage reconstructs an actual multi-chunk report and the same physical journal after closing and reopening the store",
  { timeout: 180000 },
  archiveStore,
);
