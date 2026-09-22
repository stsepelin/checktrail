import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("native profile preflight checks raw output, scope, failures and cleanup without model inference", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      String.raw`
        import assert from 'node:assert/strict';
        import { createHash } from 'node:crypto';
        import { promises as fs } from 'node:fs';
        import os from 'node:os';
        import path from 'node:path';
        const api = await import(process.argv[1]);
        const profile = { image: 'sha256:' + 'a'.repeat(64), runtimeSha256: 'b'.repeat(64), dependenciesSha256: null, native: { executable: 'node', args: ['test-runner.mjs'] }, languages: ['javascript'], timeoutMs: 1000, maxOutputBytes: 1048576 };
        const expected = { profile, nativeEvidence: { parser: 'vitest-json', scope: ['sample.test.ts'] } };
        const report = { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, testResults: [{ name: '/source/sample.test.ts', status: 'passed', assertionResults: [{ fullName: 'long synthetic assertion '.repeat(500), status: 'passed' }] }] };
        const output = { exitCode: 0, signal: null, stdout: JSON.stringify(report), stderr: '', durationMs: 1, timedOut: false, cancelled: false, truncated: false, integrity: { scope: 'mounted-trees-per-execution', verified: true, expected: {runtimeSha256:null,dependenciesSha256:null}, before: {runtimeSha256:null,dependenciesSha256:null}, after: {runtimeSha256:null,dependenciesSha256:null} } };
        assert.ok(output.stdout.length > 8000);
        const events = () => [
          { type: 'start', auditVersion:2, binding:null, treatment:false, integrityScope:'mounted-trees-per-execution', image:profile.image, runtimeSha256:profile.runtimeSha256, dependenciesSha256:profile.dependenciesSha256, budget:{maxCalls:1,timeoutMs:profile.timeoutMs,maxOutputBytes:profile.maxOutputBytes}, gatewaySha256:'d'.repeat(64),workerSha256:'e'.repeat(64), profile, files: [{ file: 'sample.test.ts', sha256: 'c'.repeat(64), bytes: 1 }] },
          { type: 'call', tool: 'evaluation_native', arguments: {} },
          { type: 'result', tool: 'evaluation_native', result: { ok: true, value: structuredClone(output) } },
          { type: 'end', calls:1, integrityScope:'completed-execution-calls', cleanupCompleted: true, sourceSnapshotRemoved: true, executionAttempts: 1, verifiedExecutions: 1, integrityFailures: 0 }
        ];
        const encode = (rows) => {
          let previous=null;
          const encoded=[];
          for(const [index,row] of rows.entries()) {
            if(row.type==='result') { const call=encoded.find(event=>event.type==='call'); row.attempt='evidence-'+call.sequence+'-'+call.sha256.slice(0,12); }
            const content={sequence:index+1,previous,...row};
            const sha256=createHash('sha256').update(JSON.stringify(content)+'\n').digest('hex');
            encoded.push({...content,sha256});previous=sha256;
          }
          return encoded.map(row=>JSON.stringify(row)+'\n').join('');
        };
        const summary = (rows, declaration = expected) => api.summarizeNativePreflight(encode(rows), declaration);
        const passed = summary(events());
        assert.equal(passed.ready, true);
        assert.equal(passed.modelInference, false);
        assert.equal(passed.exitCode, 0);
        assert.match(passed.auditSha256, /^[a-f0-9]{64}$/);
        for (const change of [
          rows => { rows[2].result.value.stdout += '\nJSON report written to /dev/stdout\n'; },
          rows => { rows[2].result.value.stdout = rows[2].result.value.stdout.slice(0, 8000); },
          rows => { rows[2].result.value.truncated = true; },
          rows => { rows[2].result.value.timedOut = true; },
          rows => { rows[2].result.value.cancelled = true; },
          rows => { rows[2].result.value.exitCode = 1; },
          rows => { rows[2].result.value.integrity.verified = false; },
          rows => { rows[3].cleanupCompleted = false; },
          rows => { rows[3].sourceSnapshotRemoved = false; },
          rows => { rows[3].integrityFailures = 1; },
          rows => { rows[3].calls = 0; },
          rows => { rows[2].result.value.integrity.after.dependenciesSha256 = 'f'.repeat(64); },
          rows => { rows[0].files[0].file = 'undisclosed.test.ts'; },
          rows => { rows[0].binding = { role: 'reviewer' }; },
          rows => { rows[0].treatment = true; },
          rows => { rows[0].dependenciesSha256 = 'f'.repeat(64); },
          rows => { rows.splice(2,0,{type:'error',message:'failed'}); },
          rows => { rows.splice(1,0,{type:'unexpected'}); },
          rows => { rows.pop(); },
        ]) {
          const rows = events(); change(rows);
          assert.equal(summary(rows).ready, false, JSON.stringify(rows.at(-1)));
        }
        const tampered=encode(events()).replace('long synthetic assertion','tampered synthetic assertion');
        assert.equal(api.summarizeNativePreflight(tampered,expected).ready,false);
        const rejected=events();rejected[2].result={ok:false,error:'execution failed'};
        assert.equal(summary(rejected).ready,false);
        assert.equal(summary(events(), { ...expected, nativeEvidence: { parser: 'vitest-json', scope: ['other.test.ts'] } }).ready, false);
        const failed = events();
        const failedReport = structuredClone(report);
        Object.assign(failedReport, { success: false, numPassedTests: 0, numFailedTests: 1, numPassedTestSuites: 0, numFailedTestSuites: 1 });
        failedReport.testResults[0].status = 'failed';
        failedReport.testResults[0].assertionResults[0].status = 'failed';
        Object.assign(failed[2].result.value, { exitCode: 1, stdout: JSON.stringify(failedReport) });
        assert.equal(summary(failed).ready, true);
        const python = { ...expected, profile: { ...profile, native: { executable: 'python3', args: ['-m', 'unittest'] }, languages: ['python'] }, nativeEvidence: { parser: 'unittest', scope: ['test_sample.py'] } };
        for (const [stderr, ready] of [['Ran 2 tests in 0.001s\n\nOK (skipped=1)\n', true], ['Ran 1 test in 0.001s\n\nOK (skipped=1)\n', false], ['Ran 0 tests in 0.001s\n\nOK\n', false]]) {
          const rows = events(); rows[0].profile = python.profile;rows[0].files=[{file:'test_sample.py',sha256:'c'.repeat(64),bytes:1}];
          Object.assign(rows[2].result.value, { stdout: '', stderr });
          assert.equal(summary(rows, python).ready, ready);
        }
        assert.throws(() => summary(events(), { ...expected, profile: { ...profile, timeoutMs: 2000 } }));
        const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'native-preflight-test-'));
        try {
          const destination = path.join(temp, 'output');
          const canonical=await fs.realpath(temp);
          const source=path.join(canonical,'source');const runtime=path.join(canonical,'runtime');
          await fs.mkdir(source);await fs.mkdir(runtime);await fs.writeFile(path.join(source,'sample.test.ts'),'sample');await fs.writeFile(path.join(runtime,'runtime.txt'),'runtime');
          const config={...expected,gateway:{schemaVersion:1,source,files:['sample.test.ts'],runtime,dependencies:null,treatment:false,image:profile.image,native:profile.native,languages:profile.languages,timeoutMs:profile.timeoutMs,maxOutputBytes:profile.maxOutputBytes,maxCalls:1}};
          const existing=path.join(temp,'existing');await fs.mkdir(existing);await fs.writeFile(path.join(existing,'sentinel'),'untouched');
          await assert.rejects(api.preflightNativeProfile(config,existing,{trustExecution:true}),{code:'EEXIST'});
          assert.deepEqual(await fs.readdir(existing),['sentinel']);
          const mismatch=path.join(temp,'mismatch');
          await assert.rejects(api.preflightNativeProfile(config,mismatch,{trustExecution:true}), /Execution profile mismatch/);
          const audit=(await fs.readFile(path.join(mismatch,'gateway-audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
          assert.deepEqual(audit.map(event=>event.type),['start','end']);
          assert.equal(audit[1].executionAttempts,0);assert.equal(audit[1].cleanupCompleted,true);assert.equal(audit[1].sourceSnapshotRemoved,true);
          assert.equal(await fs.readFile(path.join(source,'sample.test.ts'),'utf8'),'sample');
          await assert.rejects(api.preflightNativeProfile({}, destination), /Explicit execution trust/);
          await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
          await assert.rejects(api.preflightNativeProfile({}, destination, { trustExecution: true }));
          await assert.rejects(fs.stat(destination), { code: 'ENOENT' });
        } finally { await fs.rm(temp, { recursive: true, force: true }); }
      `,
      new URL("../../scripts/preflight-evaluation-native.mjs", import.meta.url)
        .href,
    ],
    { encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
