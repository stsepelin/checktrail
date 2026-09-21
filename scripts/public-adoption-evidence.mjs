import assert from "node:assert/strict";

const counts = (total, failed = 0, skipped = 0) => {
  const result = { total, passed: total - failed - skipped, failed, skipped };
  assert.ok(
    Object.values(result).every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ),
  );
  return result;
};

export function nativeEvidence(id, processes) {
  assert.ok(processes.length > 0);
  const output = processes
    .map(({ stdout, stderr }) => stdout + stderr)
    .join("\n");
  if (id === "nanoid") {
    const field = (name) => {
      const matches = [
        ...output.matchAll(new RegExp(`^# ${name} (\\d+)$`, "gm")),
      ];
      assert.equal(
        matches.length,
        1,
        `Expected one native TAP ${name} summary`,
      );
      return Number(matches[0][1]);
    };
    const result = counts(field("tests"), field("fail"), field("skipped"));
    assert.equal(result.passed, field("pass"));
    return { tests: result };
  }
  if (id === "more-itertools") {
    const total = [...output.matchAll(/^Ran (\d+) tests? in /gm)];
    assert.equal(total.length, 1, "Expected one unittest summary");
    assert.match(output, /^(?:OK|FAILED)(?: \([^\n]+\))?$/m);
    const field = (name) =>
      Number(new RegExp(`\\b${name}=(\\d+)`).exec(output)?.[1] ?? 0);
    return {
      tests: counts(
        Number(total[0][1]),
        field("failures") + field("errors"),
        field("skipped"),
      ),
    };
  }
  if (id === "uuid") {
    assert.equal(processes.length, 3);
    const events = processes[2].stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const terminal = events.filter(
      (event) => event.Test && ["pass", "fail", "skip"].includes(event.Action),
    );
    assert.ok(terminal.length > 0);
    assert.equal(
      new Set(terminal.map((event) => `${event.Package}/${event.Test}`)).size,
      terminal.length,
    );
    return {
      formattedFiles: processes[0].stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .sort(),
      tests: counts(
        terminal.length,
        terminal.filter((event) => event.Action === "fail").length,
        terminal.filter((event) => event.Action === "skip").length,
      ),
    };
  }
  if (id === "mitt") {
    return {
      diagnosticCodes: [
        ...new Set(
          [...output.matchAll(/\berror (TS\d+):/g)].map((match) => match[1]),
        ),
      ].sort(),
    };
  }
  assert.equal(id, "psr-log");
  return {
    files: processes.length,
    passed: processes.filter((result) => result.exitCode === 0).length,
    failed: processes.filter((result) => result.exitCode !== 0).length,
  };
}

export function compareNativeEvidence(id, native, report, negative = false) {
  const evidence = nativeEvidence(id, native);
  const checkId = {
    nanoid: "javascript.node-test",
    "more-itertools": "python.unittest",
    uuid: "go.test",
    mitt: "javascript.typescript",
    "psr-log": "php.syntax",
  }[id];
  const check = report.checks.find((entry) => entry.id === checkId);
  assert.ok(check, `Missing ${checkId}`);
  if (evidence.tests && check.tests)
    assert.deepEqual(
      check.tests,
      evidence.tests,
      "Native and wrapper test counts disagree",
    );
  if (evidence.tests && !check.tests)
    assert.notEqual(
      check.status,
      "passed",
      "Missing test evidence cannot pass",
    );
  if (id === "uuid") {
    const formatter = report.checks.find((entry) => entry.id === "go.format");
    const files = formatter.processes
      .flatMap((result) =>
        result.stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((file) => file.replace(/^\.\//, "")),
      )
      .sort();
    assert.deepEqual(files, evidence.formattedFiles);
  }
  const wrapperOutput = check.processes
    .map(({ stdout, stderr }) => stdout + stderr)
    .join("\n");
  if (id === "mitt") {
    return {
      ...evidence,
      wrapperDiagnosticCodes: [
        ...new Set(
          [...wrapperOutput.matchAll(/\berror (TS\d+):/g)].map(
            (match) => match[1],
          ),
        ),
      ].sort(),
      negativeControlDetected: negative
        ? wrapperOutput.includes("checktrail-adoption.ts") &&
          wrapperOutput.includes("TS2322")
        : undefined,
    };
  }
  if (id === "psr-log") {
    assert.equal(check.processes.length, evidence.files);
    assert.equal(
      check.processes.filter((result) => result.exitCode !== 0).length,
      evidence.failed,
    );
  }
  if (negative) {
    assert.equal(check.status, "failed");
    if (evidence.tests)
      assert.equal(
        evidence.tests.failed,
        1,
        "Sentinel must be the only test failure",
      );
    const marker =
      id === "uuid"
        ? "TestChecktrailAdoptionSentinel"
        : id === "more-itertools"
          ? "AdoptionSentinel"
          : id === "psr-log"
            ? "checktrail-adoption-broken.php"
            : "checktrail adoption sentinel";
    assert.ok(
      wrapperOutput.includes(marker),
      "Failure must name the injected sentinel",
    );
    return { ...evidence, negativeControlDetected: true };
  }
  return evidence;
}
