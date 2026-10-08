import { test } from "node:test";
import { fsharpBoundariesFixture } from "./review-fsharp-boundaries-fixture.js";
test(
  "selected F# bindings preserve ordered opens, sequential lets, literal module aliases and exact source addresses",
  fsharpBoundariesFixture,
);
