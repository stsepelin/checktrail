import { test } from "node:test";
import {
  javaMethodReferenceFixture,
  javaLocalTypeFixture,
  javaCompetingImportFixture,
  javaConstructorFixture,
} from "./review-java-boundaries-fixture.js";
test(
  "Java method reference names do not become same-name constant reads",
  javaMethodReferenceFixture,
);
test(
  "Java local type visibility starts at its declaration",
  javaLocalTypeFixture,
);
test(
  "Java explicit absent import prevents a selected competing import guess",
  javaCompetingImportFixture,
);
test(
  "Java constructor dispatch is retained as an unresolved call",
  javaConstructorFixture,
);

import {
  javaAncestorAccessibilityFixture,
  javaUnicodeEscapeFixture,
} from "./review-java-boundaries-fixture.js";
test(
  "Java nested type accessibility includes every enclosing class",
  javaAncestorAccessibilityFixture,
);
test(
  "Java Unicode preprocessing cannot establish raw-syntax call targets",
  javaUnicodeEscapeFixture,
);
