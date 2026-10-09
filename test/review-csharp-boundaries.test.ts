import { test } from "node:test";
import { csharpBoundariesFixture } from "./review-csharp-boundaries-fixture.js";
test(
  "selected C# bindings preserve exact imports, value masks, unknown scopes and source addresses",
  csharpBoundariesFixture,
);
