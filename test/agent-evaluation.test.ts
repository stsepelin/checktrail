import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function exercise(body: string) {
  const module = new URL("../../scripts/agent-evaluation.mjs", import.meta.url)
    .href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import assert from 'node:assert/strict';
      import { promises as fs } from 'node:fs';
      import os from 'node:os';
      import path from 'node:path';
      const api = await import(process.argv[1]);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'checktrail-agent-eval-test-'));
      const encode = value => JSON.stringify(value, null, 2) + '\\n';
      const identity = sessionId => ({sessionId, provider: 'synthetic', model: 'fixture', version: 'test', provenance: 'orchestrator-declared'});
      const usage = {inputTokens: null, outputTokens: null, costUsd: null, elapsedMs: null, provenance: 'reviewer-declared'};
      const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
      const absent = async file => assert.rejects(fs.stat(file), {code: 'ENOENT'});
      const finding = id => ({id, claim: 'Original synthetic concern', reproduction: 'Not an executed reproduction: synthetic protocol fixture', citations: [{file: 'value.mjs', line: 1, endLine: 1, quote: 'export const value = 1;'}]});
      const decision = (findingId, verdict, defectId = null, duplicateOf = null) => ({findingId, verdict, defectId, duplicateOf, evidence: ['Synthetic adjudication fixture; no actual review claim']});
      async function setup(name = 'run', options = {}) {
        const base = path.join(root, name);
        const source = path.join(base, 'source');
        await fs.mkdir(source, {recursive: true});
        await fs.writeFile(path.join(source, 'value.mjs'), 'export const value = 1;\\n');
        const artifact = path.join(base, 'engine.mjs');
        await fs.writeFile(artifact, '// original synthetic engine identity fixture\\n');
        const plan = {
          schemaVersion: 1, id: name, purpose: 'Synthetic accounting test', evidenceClass: 'development', curatorSessionId: 'curator',
          engine: {package: '@stsepelin/checktrail', version: 'synthetic', artifact, sha256: api.sha256(await fs.readFile(artifact))},
          reviewerProfile: {provider: 'synthetic', model: 'fixture', version: 'test', settings: 'No model invocation'},
          environment: {platform: 'synthetic', runtime: 'test', dependencies: 'No external dependencies'},
          isolation: 'procedural', isolationEvidence: 'Shared test process; no inference or model isolation',
          budget: {wallSeconds: 1, maxToolCalls: 8, maxInputTokens: null, maxOutputTokens: 1000, repetitions: 1},
          cases: [{id: 'case-one', family: 'synthetic', group: 'private-group-marker', split: 'development', root: source, files: ['value.mjs'], task: 'Inspect the supplied source',
            source: {repository: 'https://example.org/original-fixture', revision: 'a'.repeat(40), license: 'MIT'}, reviewCommands: [], validators: options.validators ?? [], exclusion: null}],
        };
        const labels = [{caseId: 'case-one', scope: 'Original synthetic fixture', expectedDefects: options.valid ? [] : [{id: 'expected-one', description: 'SECRET_EXPECTED_LABEL', evidence: ['synthetic label, not actual defect evidence']}], provenance: 'Synthetic protocol test only'}];
        const run = path.join(base, 'frozen');
        const frozen = options.freeze === false ? null : await api.freeze(plan, labels, run);
        return {base, source, plan, labels, run, frozen};
      }
      const receipt = (frozen, index, findings = [], status = 'completed') => ({schemaVersion: 1, assignmentId: frozen.manifest.assignments[index].id, manifestSha256: frozen.sha256, sourceSha256: frozen.manifest.cases[0].captured.sha256, reviewer: identity('reviewer-' + index), status, findings, limitations: ['Synthetic fixture'], usage});
      const judgment = (frozen, index, findings = []) => ({blindId: frozen.manifest.assignments[index].blindId, labelStatus: 'accepted', findings, rationale: 'Synthetic protocol accounting fixture'});
      const judged = (frozen, judgments) => ({schemaVersion: 1, manifestSha256: frozen.sha256, adjudicator: identity('judge'), judgments});
      try {
        ${body}
      } finally {
        await fs.rm(root, {recursive: true, force: true});
      }
      `,
      module,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
}

test("agent packets withhold labels and sibling identities, then blind only sealed terminal assessments", () => {
  exercise(String.raw`
    const {run, frozen, base} = await setup();
    const assignment = frozen.manifest.assignments[0];
    const packet = path.join(base, 'packet');
    await api.packet(run, assignment.id, packet);
    const task = await read(path.join(packet, 'task.json'));
    const serialized = JSON.stringify(task);
    for (const secret of ['SECRET_EXPECTED_LABEL', 'private-group-marker', 'a'.repeat(40), frozen.manifest.assignments[1].id]) assert.ok(!serialized.includes(secret), secret);
    assert.equal(await fs.readFile(path.join(packet, 'source/value.mjs'), 'utf8'), 'export const value = 1;\n');
    await assert.rejects(api.packet(run, assignment.id, packet));
    const destination = path.join(base, 'blind');
    await assert.rejects(api.blind(run, destination), /Seal every terminal review/);
    await absent(destination);
    for (let index = 0; index < 2; index++) await api.seal(run, frozen.manifest.assignments[index].id, receipt(frozen, index));
    await api.blind(run, destination);
    const judging = await read(path.join(destination, 'judging.json'));
    assert.equal(judging.items.length, 2);
    for (const item of judging.items) {
      assert.equal(item.label.expectedDefects[0].description, 'SECRET_EXPECTED_LABEL');
      assert.equal(item.findings.length, 0);
      for (const key of ['arm', 'reviewer', 'usage', 'assignmentId', 'caseId']) assert.ok(!(key in item), key);
    }
    const blindBytes = JSON.stringify(judging);
    for (const secret of ['reviewer-0', 'reviewer-1', assignment.id, 'private-group-marker']) assert.ok(!blindBytes.includes(secret), secret);
    await assert.rejects(api.blind(run, destination));
  `);
});

test("agent freeze rejects contaminated splits and partial snapshots without publishing half a run", () => {
  exercise(String.raw`
    const {plan, labels, run, base} = await setup('atomic', {freeze: false});
    const paired = structuredClone(plan);
    paired.cases.push({...paired.cases[0], id: 'case-two', split: 'holdout'});
    await assert.rejects(api.freeze(paired, [...labels, {...labels[0], caseId: 'case-two'}], run), /Related cases/);
    await absent(run);
    const badSource = structuredClone(plan);
    badSource.cases[0].files.push('missing.mjs');
    await assert.rejects(api.freeze(badSource, labels, run), /ENOENT/);
    await absent(run);
    assert.ok(!(await fs.readdir(base)).some(name => name.startsWith('.agent-eval-')));
    await assert.rejects(api.freeze({...plan, engine: {...plan.engine, sha256: '0'.repeat(64)}}, labels, run), /Engine artifact changed/);
    const frozen = await api.freeze(plan, labels, run);
    await assert.rejects(api.freeze(plan, labels, run));
    assert.equal((await api.loadRun(run)).sha256, frozen.sha256);
    const changedLabels = structuredClone(labels);
    changedLabels[0].expectedDefects = [];
    await fs.writeFile(path.join(run, 'labels.json'), encode(changedLabels));
    await assert.rejects(api.loadRun(run), /Labels changed/);
    await fs.writeFile(path.join(run, 'labels.json'), encode(labels));
    await fs.writeFile(path.join(run, 'sources/case-one/value.mjs'), 'export const value = 2;\n');
    await assert.rejects(api.loadRun(run), /Frozen source changed/);
  `);
});

test("agent receipts bind exact citations and source identities and reject reused roles", () => {
  exercise(String.raw`
    const {run, frozen} = await setup();
    const first = frozen.manifest.assignments[0].id;
    const input = receipt(frozen, 0, [finding('one')]);
    for (const override of [
      {manifestSha256: '0'.repeat(64)}, {sourceSha256: '0'.repeat(64)},
      {assignmentId: 'unknown'}, {reviewer: identity('curator')},
      {reviewer: {...identity('reviewer-0'), model: 'different-model'}},
      {findings: [finding('one'), finding('one')]},
    ]) await assert.rejects(api.seal(run, first, {...input, ...override}));
    for (const override of [{quote: 'incorrect'}, {file: 'outside.mjs'}, {endLine: 3}, {line: 2, endLine: 1}]) {
      const invalid = structuredClone(input);
      Object.assign(invalid.findings[0].citations[0], override);
      await assert.rejects(api.seal(run, first, invalid));
    }
    await api.seal(run, first, input);
    await assert.rejects(api.seal(run, first, input));
    const second = receipt(frozen, 1);
    second.reviewer = input.reviewer;
    await assert.rejects(api.seal(run, second.assignmentId, second), /fresh reviewer session/);
    second.reviewer = identity('reviewer-1');
    await api.seal(run, second.assignmentId, second);
    for (const session of ['curator', 'reviewer-0', 'reviewer-1']) {
      await assert.rejects(api.score(run, {...judged(frozen, []), adjudicator: identity(session)}), /cannot adjudicate/);
    }
    const savedPath = path.join(run, 'receipts', first + '.json');
    const saved = await read(savedPath);
    saved.receipt.findings[0].claim = 'tampered after seal';
    await fs.writeFile(savedPath, encode(saved));
    await assert.rejects(api.score(run, judged(frozen, [])), /Sealed receipt changed/);
  `);
});

test("agent scoring preserves missing review, missing judgment and missing reference denominators", () => {
  exercise(String.raw`
    const validator = {id: 'optional-missing', kind: 'additional', version: 'synthetic', command: ['checktrail-nonexistent-fixture-executable'], required: false, assets: []};
    const {run, frozen} = await setup('missing', {validators: [validator]});
    let scored = await api.score(run, judged(frozen, []));
    assert.equal(scored.complete, false);
    for (const summary of scored.summaries.filter(s => s.family === 'all')) {
      assert.equal(summary.assignments, 1);
      assert.equal(summary.incomplete, 1);
      assert.equal(summary.expectedDefects, 1);
      assert.equal(summary.unresolvedExpected, 1);
      assert.equal(summary.confirmedMisses, 0);
      assert.equal(summary.unknownCostAssignments, 1);
    }
    for (let i = 0; i < 2; i++) await api.seal(run, frozen.manifest.assignments[i].id, receipt(frozen, i));
    scored = await api.score(run, judged(frozen, [judgment(frozen, 0)]));
    assert.equal(scored.observations[0].status, 'complete');
    assert.equal(scored.observations[0].missed, 1);
    assert.equal(scored.observations[1].status, 'incomplete');
    assert.equal(scored.observations[1].missed, null);
    assert.equal(scored.observations[0].references[0].status, 'missing');
    await assert.rejects(api.reference(run, 'case-one', validator.id, false), /trust-project/);
    const reference = await api.reference(run, 'case-one', validator.id, true);
    assert.equal(reference.status, 'incomplete');
    assert.notEqual(reference.exitCode, 0);
    scored = await api.score(run, judged(frozen, [judgment(frozen, 0), judgment(frozen, 1)]));
    assert.equal(scored.complete, true);
    assert.ok(scored.observations.every(o => o.references[0].status === 'incomplete'));
    await assert.rejects(api.reference(run, 'case-one', validator.id, true));
    const required = await setup('required', {validators: [{...validator, required: true}]});
    for (let i = 0; i < 2; i++) await api.seal(required.run, required.frozen.manifest.assignments[i].id, receipt(required.frozen, i));
    scored = await api.score(required.run, judged(required.frozen, [judgment(required.frozen, 0), judgment(required.frozen, 1)]));
    assert.ok(scored.observations.every(o => o.status === 'incomplete' && o.missed === null));
  `);
});

test("agent adjudication accounts for every claim and counts duplicate false alarms once", () => {
  exercise(String.raw`
    const {run, frozen} = await setup('valid', {valid: true});
    await api.seal(run, frozen.manifest.assignments[0].id, receipt(frozen, 0, [finding('one'), finding('two')]));
    await api.seal(run, frozen.manifest.assignments[1].id, receipt(frozen, 1));
    const first = judgment(frozen, 0, [decision('one', 'false-positive'), decision('two', 'duplicate', null, 'one')]);
    const second = judgment(frozen, 1);
    const scored = await api.score(run, judged(frozen, [first, second]));
    assert.equal(scored.complete, true);
    assert.equal(scored.observations[0].falseClaims, 1);
    assert.equal(scored.observations[0].duplicateClaims, 1);
    const baseline = scored.summaries.find(s => s.family === 'all' && s.arm === 'baseline');
    assert.equal(baseline.validCases, 1);
    assert.equal(baseline.validCaseFalseAlarms, 1);
    assert.equal(baseline.falseClaims, 1);
    for (const findings of [first.findings.slice(0, 1), [...first.findings, decision('unknown', 'false-positive')], [first.findings[0], first.findings[0]], [decision('one', 'duplicate', null, 'two'), decision('two', 'duplicate', null, 'one')]]) {
      await assert.rejects(api.score(run, judged(frozen, [{...first, findings}, second])));
    }
    await assert.rejects(api.score(run, judged(frozen, [first, first, second])), /Duplicate judgment/);
    await assert.rejects(api.score(run, judged(frozen, [{...first, blindId: 'unknown'}, second])), /Unknown judgment/);
    await assert.rejects(api.score(run, {...judged(frozen, [first, second]), manifestSha256: '0'.repeat(64)}));
  `);
});

test("agent scoring keeps unresolved, disputed and explicitly incomplete reviews out of completed misses", () => {
  exercise(String.raw`
    const {run, frozen} = await setup('unresolved');
    await api.seal(run, frozen.manifest.assignments[0].id, receipt(frozen, 0, [finding('one'), finding('two')]));
    await api.seal(run, frozen.manifest.assignments[1].id, receipt(frozen, 1, [], 'incomplete'));
    let first = judgment(frozen, 0, [decision('one', 'confirmed', 'expected-one'), decision('two', 'duplicate', null, 'one')]);
    let scored = await api.score(run, judged(frozen, [first, judgment(frozen, 1)]));
    assert.equal(scored.observations[0].matched, 1);
    assert.equal(scored.observations[0].missed, 0);
    assert.equal(scored.observations[1].missed, null);
    assert.equal(scored.observations[1].status, 'incomplete');
    const repeated = {...first, findings: [decision('one', 'confirmed', 'expected-one'), decision('two', 'confirmed', 'expected-one')]};
    await assert.rejects(api.score(run, judged(frozen, [repeated])), /Confirmed defect/);
    await assert.rejects(api.score(run, judged(frozen, [{...first, findings: [decision('one', 'confirmed', 'undeclared'), decision('two', 'false-positive')]}])), /predeclared defect/);
    first = {...first, findings: [decision('one', 'unresolved'), decision('two', 'false-positive')]};
    scored = await api.score(run, judged(frozen, [first]));
    assert.equal(scored.observations[0].status, 'incomplete');
    assert.equal(scored.observations[0].unresolvedClaims, 1);
    assert.equal(scored.observations[0].missed, null);
    first = {...first, labelStatus: 'disputed', findings: [decision('one', 'confirmed', 'expected-one'), decision('two', 'false-positive')]};
    scored = await api.score(run, judged(frozen, [first]));
    assert.equal(scored.observations[0].matched, 0);
    assert.equal(scored.observations[0].status, 'incomplete');
  `);
});

test("agent reference execution records source deletion as incomplete terminal evidence", () => {
  exercise(String.raw`
    const {run, frozen} = await setup('deleted', {validators: [{id: 'deleting-check', kind: 'reproduction', version: 'synthetic', command: [process.execPath, '-e', 'require("node:fs").unlinkSync("value.mjs")'], required: true, assets: []}]});
    const result = await api.reference(run, 'case-one', 'deleting-check', true);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.sourceUnchanged, false);
    const saved = await read(path.join(run, 'references/case-one/deleting-check.json'));
    assert.equal(saved.record.sourceSha256, frozen.manifest.cases[0].captured.sha256);
    assert.equal(saved.record.status, 'incomplete');
  `);
});

test("agent scoring does not accept a declared over-budget review as complete", () => {
  exercise(String.raw`
    const {run, frozen} = await setup('budget', {valid: true});
    const first = receipt(frozen, 0);
    first.usage = {...usage, outputTokens: 1001};
    await api.seal(run, first.assignmentId, first);
    const second = receipt(frozen, 1);
    second.usage = {...usage, elapsedMs: 1001};
    await api.seal(run, second.assignmentId, second);
    const scored = await api.score(run, judged(frozen, [judgment(frozen, 0), judgment(frozen, 1)]));
    assert.equal(scored.complete, false);
    assert.ok(scored.observations.every(o => o.status === 'incomplete' && o.budgetExceeded));
  `);
});

test("agent MCP bridge rejects an existing trace before executing project tools", () => {
  exercise(String.raw`
    const {spawnSync} = await import('node:child_process');
    const marker = path.join(root, 'executed');
    const cli = path.join(root, 'fake-cli.mjs');
    await fs.writeFile(cli, 'import {writeFileSync} from "node:fs"; writeFileSync(' + JSON.stringify(marker) + ', "executed");');
    const trace = path.join(root, 'trace.json');
    await fs.writeFile(trace, 'previous evidence');
    const source = path.join(root, 'source');
    await fs.mkdir(source);
    const {fileURLToPath} = await import('node:url');
    const bridge = fileURLToPath(new URL('./agent-evaluation-mcp.mjs', process.argv[1]));
    const result = spawnSync(process.execPath, [bridge, cli, source, 'validation_run', '{}', trace, '--trust-project'], {encoding:'utf8', timeout:5000});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(await fs.readFile(trace, 'utf8'), 'previous evidence');
    await absent(marker);
  `);
});

test("agent reference identities remain distinct when case and validator IDs contain dots", () => {
  exercise(String.raw`
    const prepared = await setup('reference-collision', {freeze:false, valid:true});
    const template = prepared.plan.cases[0];
    const validator = id => ({id, kind:'native', version:process.version, command:[process.execPath, '-e', 'process.stdout.write("checked")'], required:true, assets:[]});
    prepared.plan.cases = [{...template,id:'a.b',validators:[validator('c')]},{...template,id:'a',validators:[validator('b.c')]}];
    const labels = prepared.plan.cases.map(c=>({...prepared.labels[0],caseId:c.id}));
    const frozen = await api.freeze(prepared.plan, labels, prepared.run);
    assert.equal((await api.reference(prepared.run,'a.b','c',true)).status,'completed');
    assert.equal((await api.reference(prepared.run,'a','b.c',true)).status,'completed');
    const report = await api.score(prepared.run, judged(frozen, []));
    assert.ok(report.observations.every(o=>o.references[0].status==='completed'));
    assert.equal(new Set(report.observations.map(o=>o.references[0].evidenceSha256)).size,2);
  `);
});

test("excluded agent cases cannot acquire reviewed misses or findings", () => {
  exercise(String.raw`
    const prepared = await setup('excluded', {freeze:false});
    prepared.plan.cases[0].exclusion = 'Required public dependency unavailable';
    const frozen = await api.freeze(prepared.plan, prepared.labels, prepared.run);
    const input = receipt(frozen,0,[]);
    await assert.rejects(api.seal(prepared.run,input.assignmentId,input),/Excluded/);
    const report = await api.score(prepared.run,judged(frozen,[]));
    for(const row of report.summaries){
      assert.equal(row.excluded,1);
      assert.equal(row.detected,0);
      assert.equal(row.confirmedMisses,0);
      assert.equal(row.unresolvedExpected,1);
      assert.equal(row.expectedDefects,row.detected+row.confirmedMisses+row.unresolvedExpected);
    }
    const bytes = JSON.stringify(input,null,2)+'\n';
    await fs.writeFile(path.join(prepared.run,'receipts',input.assignmentId+'.json'),JSON.stringify({receipt:input,sha256:api.sha256(bytes),sealedAt:new Date().toISOString()}));
    await assert.rejects(api.score(prepared.run,judged(frozen,[judgment(frozen,0,[])])),/Excluded/);
  `);
});

test("published agent pilot counts reconcile with adjudication and preserved protocol bytes", () => {
  exercise(String.raw`
    const readMeasurement = name => fs.readFile(new URL('../docs/measurements/'+name,process.argv[1]));
    const record = JSON.parse(await readMeasurement('agent-pilot-v1.json'));
    const archive = JSON.parse(await readMeasurement('agent-pilot-v1-protocol.json'));
    const auditBytes = await readMeasurement(record.independentAudit.record);
    const audit = JSON.parse(auditBytes);
    assert.equal(api.sha256(auditBytes),record.independentAudit.sha256);
    assert.equal(archive.harnessSha256,record.frozenHarnessSha256);
    assert.equal(archive.manifestSha256,record.scoring.manifestSha256);
    for(const file of archive.files) assert.equal(api.sha256(file.content),file.sha256);
    assert.equal(archive.files.find(f=>f.path==='scripts/agent-evaluation.mjs').sha256,archive.harnessSha256);
    assert.equal(record.protocolValidForEffectivenessClaim,false);
    assert.deepEqual(audit.errors,[]);
    assert.equal(record.scoring.observations.length,record.cases.length*2);
    for(const observation of record.scoring.observations){
      const labels = record.cases.find(c=>c.id===observation.caseId).expectedDefects;
      const judgment = record.adjudication.findings.find(j=>j.caseId===observation.caseId&&j.arm===observation.arm&&j.trial===observation.trial);
      const confirmed = judgment.findings.filter(f=>f.verdict==='confirmed').map(f=>f.defectId);
      assert.equal(new Set(confirmed).size,confirmed.length);
      assert.ok(confirmed.every(d=>labels.includes(d)));
      assert.deepEqual(confirmed.sort(),[...observation.matchedDefectIds].sort());
      assert.equal(observation.expected,labels.length);
      assert.equal(observation.missed,labels.length-confirmed.length);
      for(const [metric,verdict] of [['falseClaims','false-positive'],['duplicateClaims','duplicate'],['outOfScopeClaims','out-of-scope'],['unresolvedClaims','unresolved']]) assert.equal(observation[metric],judgment.findings.filter(f=>f.verdict===verdict).length);
    }
    for(const arm of ['baseline','mcp']){
      const rows=record.scoring.observations.filter(o=>o.arm===arm);
      const summary=record.scoring.summaries.find(s=>s.arm===arm&&s.family==='all');
      const independent=audit.summaries.find(s=>s.arm===arm);
      for(const [metric,field] of [['expectedDefects','expected'],['detected','matched'],['confirmedMisses','missed'],['falseClaims','falseClaims'],['outOfScopeClaims','outOfScopeClaims']]){
        assert.equal(summary[metric],rows.reduce((n,o)=>n+o[field],0));
        assert.equal(summary[metric],independent[metric]);
      }
      assert.equal(summary.assignments,summary.complete+summary.incomplete+summary.excluded);
      assert.equal(summary.expectedDefects,summary.detected+summary.confirmedMisses+summary.unresolvedExpected);
    }
    assert.ok(record.mcpExecution.every(r=>r.server.version==='0.1.0-alpha.5'&&r.outcome==='incomplete'));
  `);
});
