import { test } from "node:test";
import { rubyBoundariesFixture } from "./review-ruby-boundaries-fixture.js";
test(
  "selected Ruby bindings preserve explicit methods, parser-order bare calls and exact module candidates",
  rubyBoundariesFixture,
);
