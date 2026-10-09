import { test } from "node:test";
import { kotlinBoundaryFixtures } from "./review-kotlin-boundaries-fixture.js";
test(
  "selected Kotlin bindings defend import, statement, value and complete-call boundaries",
  kotlinBoundaryFixtures,
);
