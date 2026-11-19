import test from "node:test";
import { runGccMain05Group } from "./gcc-main05-controls.js";

test("GCC original main05 synthetic capture, failure, and service controls", (t) => {
  runGccMain05Group(t, "core");
});
