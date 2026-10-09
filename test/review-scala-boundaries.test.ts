import { test } from "node:test";
import { scalaBoundaryFixtures } from "./review-scala-boundaries-fixture.js";
test(
  "selected Scala bindings defend import, statement, value and complete-call boundaries",
  scalaBoundaryFixtures,
);
