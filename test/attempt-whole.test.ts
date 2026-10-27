import { test } from "node:test";
import {
  archiveBroken,
  archiveRepair,
  archiveNear,
  archiveStore,
  archiveCallers,
  archiveStale,
  archiveEmpty,
} from "./attempt-whole-controls.js";
test(
  "native archive witness executes both affected consumers and retains every failed and successful case with the actual child PID",
  { timeout: 90000 },
  archiveBroken,
);
test(
  "native archive repair changes the captured producer while preserving consumer cases operator identity and independent process records",
  { timeout: 180000 },
  archiveRepair,
);
test(
  "native archive valid alternate producer syntax leaves adjacent identifiers denied through both distinct consumer outputs",
  { timeout: 90000 },
  archiveNear,
);
test(
  "native archive storage reconstructs an actual multi-chunk report and the same physical journal after closing and reopening the store",
  { timeout: 180000 },
  archiveStore,
);
test(
  "native archive witness detects either consumer-only regression while the producer and unaffected caller remain unchanged",
  { timeout: 240000 },
  archiveCallers,
);
test(
  "native archive source changes remain incomplete even after every captured native case passes",
  { timeout: 120000 },
  archiveStale,
);
test(
  "native archive empty and genuinely skipped case bodies cannot become passing validation despite complete process journals",
  { timeout: 180000 },
  archiveEmpty,
);
