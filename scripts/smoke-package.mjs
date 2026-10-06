import { installAcceptancePackage } from "./install-acceptance-package.mjs";
import { supportedClangVersion } from "../dist/src/clang-protocol.js";
import { architectureFixture } from "../dist/test/architecture-helpers.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { copyInstalledPackages } from "../dist/test/tool-fixture.js";
import { contractFixture } from "../dist/test/contract-helpers.js";

const repository = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), "checktrail-package-"));
let client;
try {
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  const initialTarball = await readFile(path.join(temporary, packed.filename));
  const [repacked] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary],
      { cwd: repository, encoding: "utf8" },
    ),
  );
  assert.deepEqual(repacked.files, packed.files);
  assert.equal(
    createHash("sha256")
      .update(await readFile(path.join(temporary, repacked.filename)))
      .digest("hex"),
    createHash("sha256").update(initialTarball).digest("hex"),
    "Repeated packing of the same checkout must produce identical bytes",
  );
  for (const file of packed.files)
    assert.match(
      file.path,
      /^(?:dist\/src\/|schemas\/|packs\/|docs\/|package\.json$|server\.json$|README\.md$|LICENSE$|SECURITY\.md$|CONTRIBUTING\.md$)/,
    );
  const consumer = path.join(temporary, "consumer");
  await installAcceptancePackage(
    repository,
    path.join(temporary, packed.filename),
    consumer,
  );
  const scoringSmoke = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {scoreReviewTrials,projectReviewScoring} from "@stsepelin/checktrail";
    const input={protocol:{schemaVersion:1,profile:"declared-claim-probability-v1",purpose:"development",confidenceThresholds:[0.95],trials:[{id:"OriginalPackageCase",clusterId:"OriginalPackageCluster",family:"test-adequacy"}]},observations:[]};
    console.log(JSON.stringify(projectReviewScoring(scoreReviewTrials(input),false)));
  `,
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(scoringSmoke.qualityGate, "not-assessed");
  assert.equal(scoringSmoke.aggregate.statuses.unreviewed, 1);
  assert.equal(scoringSmoke.aggregate.precision.value, null);
  assert.equal(scoringSmoke.aggregate.properScores.brier, null);
  assert.equal(scoringSmoke.calibratedConfidence, false);
  // Exercise parser availability before injecting consumer development tools.
  // The worker must execute from the installed package, not the development tree.
  const probeRoot = path.join(consumer, "probe-profile");
  await mkdir(probeRoot);
  await mkdir(path.join(probeRoot, ".checktrail"));
  await writeFile(
    path.join(probeRoot, "subject.mjs"),
    "export function decision(name){return name.startsWith('scope');}\n",
  );
  const probeSmoke = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {createReviewContext,runReviewProbe,projectReviewProbe,runReviewVerification,projectReviewVerification} from "@stsepelin/checktrail";
    import {writeFile,mkdir} from "node:fs/promises";
    import {createHash} from "node:crypto";
    const context=await createReviewContext("./probe-profile",{schemaVersion:5,track:"snapshot",currentSource:"working-tree",files:["subject.mjs"],supportFiles:[],topics:[]});
    const candidate={id:"original-package-probe",family:"identifiers-allowlists",severity:"concern",claim:"The trigger differs from its declared decision.",trigger:"scopeToken",consequence:"Unexpected decision.",evidenceGaps:["Production policy unknown."],attribution:"unknown",fixScope:"unknown",citations:[{revision:"current",file:"subject.mjs",sourceDigest:context.files[0].sha256,startLine:1,endLine:1,quote:context.files[0].content.trim()}]};
    const contents=JSON.stringify({schemaVersion:1,profile:"node-export-boolean-v1",id:"PackageBoundary",family:candidate.family,file:"subject.mjs",exportName:"decision",minimumTriggerScale:1,guard:null,cases:[{id:"Baseline",role:"baseline",args:["scope:read"],expected:true},{id:"Trigger",role:"trigger",args:["scopeToken"],expected:false},{id:"NearMiss",role:"near-miss",args:["other"],expected:false}]});
    const run=await runReviewProbe("./probe-profile",context,candidate,{trusted:true,recipe:{contents,sha256:createHash("sha256").update(contents).digest("hex")},timeoutMs:10000});
    const config={schemaVersion:1,kind:"openai-responses",model:"original-package-adjudicator",credentialEnv:"ORIGINAL_VERIFICATION_KEY",pricing:null,limits:{wallMs:10000,maxAttempts:1,retryDelayMs:0,maxRequestBytes:1048576,maxResponseBytes:131072,maxOutputTokens:4096}};
    const response={model:config.model,status:"completed",usage:{input_tokens:100,output_tokens:20},output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({files:[{path:"subject.mjs",disposition:"reviewed",note:"Original synthetic package verification"}],candidates:[]})}]}]};
    let requests=0;
    const verification=await runReviewVerification("./probe-profile",context,candidate,{trusted:true,recipe:{contents,sha256:createHash("sha256").update(contents).digest("hex")},wallMs:10000,provider:{config,allowInference:true,allowSourceDisclosure:true,environment:{ORIGINAL_VERIFICATION_KEY:"opaque-original-key"},fetch:async(_url,init)=>{requests++;const request=JSON.parse(init.body);const packet=JSON.parse(request.input[0].content[0].text);if(requests===1 && "nativeObservations" in packet)throw new Error("Refuter was contaminated");if(requests===2 && (!packet.nativeObservations || "id" in packet.unverifiedTarget || "severity" in packet.unverifiedTarget))throw new Error("Adjudicator was contaminated");return Response.json(response);}}});
    if(requests!==2)throw new Error("Missing independent package stages");
    await mkdir("./verification-operator");
    await writeFile("./probe-profile/.checktrail/context.json",JSON.stringify(context));await writeFile("./probe-profile/.checktrail/candidate.json",JSON.stringify(candidate));
    await writeFile("./verification-operator/config.json",JSON.stringify(config));await writeFile("./verification-operator/recipe.json",contents);
    await writeFile("./verification-operator/transport.mjs","globalThis.fetch=async()=>Response.json("+JSON.stringify(response)+");");
    console.log(JSON.stringify({...projectReviewProbe(run,false),verification:projectReviewVerification(verification,false,false)}));
  `,
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(probeSmoke.status, "completed");
  assert.equal(probeSmoke.behavior, "violated");
  assert.equal(probeSmoke.counts.controlMismatches, 0);
  assert.equal(probeSmoke.counts.triggerMismatches, 1);
  assert.equal(probeSmoke.claimsVerified, false);
  assert.equal(probeSmoke.temporaryArtifacts, "removed");
  assert.equal(probeSmoke.nativeExecution, true);
  const verificationSmoke = probeSmoke.verification;
  assert.equal(verificationSmoke.status, "completed");
  assert.equal(verificationSmoke.evidenceTier, "native-expectation-mismatch");
  assert.equal(verificationSmoke.resolution, "unresolved");
  assert.equal(verificationSmoke.severity, "unassigned");
  const verificationOperator = path.join(consumer, "verification-operator");
  const installedVerificationCli = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src/cli.js",
  );
  const verificationContents = await readFile(
    path.join(verificationOperator, "recipe.json"),
    "utf8",
  );
  const verificationFlags = [
    "--provider-config",
    path.join(verificationOperator, "config.json"),
    "--allow-inference",
    "--allow-provider-source",
    "--probe",
    path.join(verificationOperator, "recipe.json") +
      "#sha256=" +
      createHash("sha256").update(verificationContents).digest("hex"),
  ];
  const verificationEnv = {
    PATH: process.env.PATH,
    ORIGINAL_VERIFICATION_KEY: "opaque-original-key",
  };
  const verificationCli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--import",
        path.join(verificationOperator, "transport.mjs"),
        installedVerificationCli,
        "review-verify",
        "--root",
        probeRoot,
        "--context",
        ".checktrail/context.json",
        "--input",
        ".checktrail/candidate.json",
        "--trust-project",
        ...verificationFlags,
      ],
      { encoding: "utf8", env: verificationEnv },
    ),
  );
  client = new Client(
    { name: "original-installed-verification", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "--import",
        path.join(verificationOperator, "transport.mjs"),
        installedVerificationCli,
        "serve",
        "--root",
        probeRoot,
        "--allow-execution",
        ...verificationFlags,
      ],
      env: verificationEnv,
      stderr: "pipe",
    }),
  );
  const verificationMcp = await client.callTool({
    name: "review_verify",
    arguments: {
      context: ".checktrail/context.json",
      candidate: ".checktrail/candidate.json",
      probeId: "PackageBoundary",
    },
  });
  assert.equal(
    verificationMcp.isError,
    undefined,
    JSON.stringify(verificationMcp),
  );
  for (const surface of [verificationCli, verificationMcp.structuredContent])
    for (const key of [
      "status",
      "evidenceTier",
      "claimsVerified",
      "resolution",
      "severity",
      "contextDigest",
      "targetDigest",
      "recipeDigest",
      "independence",
    ])
      assert.deepEqual(surface[key], verificationSmoke[key]);
  for (const surface of [
    verificationSmoke,
    verificationCli,
    verificationMcp.structuredContent,
  ]) {
    assert.equal(surface.probe.nativeExecution, true);
    assert.equal(surface.probe.counts.triggerMismatches, 1);
    assert.equal(surface.adjudication.status, "completed");
    assert.ok(!JSON.stringify(surface).includes("original-package-probe"));
    assert.ok(!JSON.stringify(surface).includes("subject.mjs"));
  }
  await client.close();
  client = undefined;
  let pyrightSmoke = "not-run-unavailable";
  const pyrightPackage = process.env.CHECKTRAIL_PYRIGHT_PACKAGE;
  if (pyrightPackage) {
    const pyrightRoot = path.join(consumer, "pyright-profile");
    await mkdir(path.join(pyrightRoot, "node_modules"), { recursive: true });
    await cp(pyrightPackage, path.join(pyrightRoot, "node_modules/pyright"), {
      recursive: true,
    });
    await writeFile(
      path.join(pyrightRoot, "pyproject.toml"),
      '[tool.pyright]\ntypeCheckingMode="standard"\n',
    );
    await writeFile(
      path.join(pyrightRoot, "checktrail.json"),
      JSON.stringify({
        schemaVersion: 1,
        projects: [{ path: ".", checks: ["python.pyright"] }],
      }),
    );
    await writeFile(path.join(pyrightRoot, "value.py"), 'value: int = "bad"\n');
    const installedCli = path.join(
      consumer,
      "node_modules/@stsepelin/checktrail/dist/src/cli.js",
    );
    const library = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {validate} from "@stsepelin/checktrail";console.log(JSON.stringify(await validate("./pyright-profile",{trusted:true})));',
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    );
    assert.equal(library.outcome, "failed");
    assert.equal(library.checks[0].findingsComplete, true);
    assert.equal(library.checks[0].findings[0].ruleId, "reportAssignmentType");
    const cli = spawnSync(
      process.execPath,
      [
        installedCli,
        "run",
        "--root",
        pyrightRoot,
        "--trust-project",
        "--detailed",
      ],
      {
        cwd: consumer,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(cli.status, 1, cli.stderr);
    const cliReport = JSON.parse(cli.stdout);
    assert.deepEqual(cliReport.checks[0].findings, library.checks[0].findings);
    const pyrightClient = new Client(
      { name: "original-package-pyright-test", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    try {
      await pyrightClient.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            installedCli,
            "serve",
            "--root",
            pyrightRoot,
            "--allow-execution",
            "--detailed",
          ],
          cwd: consumer,
          stderr: "pipe",
        }),
      );
      const report = await pyrightClient.callTool({
        name: "validation_run",
        arguments: {},
      });
      assert.equal(report.isError, undefined);
      assert.equal(report.structuredContent.outcome, "failed");
      assert.deepEqual(
        report.structuredContent.checks[0].findings,
        cliReport.checks[0].findings,
      );
    } finally {
      await pyrightClient.close();
    }
    pyrightSmoke = "original-native";
  }

  const behaviorRoot = path.join(consumer, "review-profile");
  await mkdir(behaviorRoot);
  await mkdir(path.join(behaviorRoot, ".checktrail"));
  await writeFile(
    path.join(behaviorRoot, "subject.ts"),
    "export const fallback = 2;\nexport function subject(value = fallback) { return value; }\n",
  );
  await writeFile(
    path.join(behaviorRoot, "caller.ts"),
    'import {subject} from "./subject.js"; export function caller() { return subject(); }\n',
  );
  const behaviorSelection = {
    schemaVersion: 4,
    track: "snapshot",
    files: ["subject.ts"],
    supportFiles: ["caller.ts"],
    topics: [],
  };
  await writeFile(
    path.join(behaviorRoot, ".checktrail/selection.json"),
    JSON.stringify(behaviorSelection),
  );
  const behavior = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {createReviewContext} from "@stsepelin/checktrail"; console.log(JSON.stringify(await createReviewContext("./review-profile",' +
          JSON.stringify(behaviorSelection) +
          ")));",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(behavior.analysis.state, "collected");
  assert.equal(behavior.analysis.parserVersion, "6.0.3");
  const subjectFunction = behavior.analysis.functions.find(
    (fn) => fn.name === "subject",
  );
  const callerFunction = behavior.analysis.functions.find(
    (fn) => fn.name === "caller",
  );
  assert.ok(
    behavior.analysis.calls.some(
      (call) =>
        call.callerFunctionId === callerFunction.id &&
        call.targetFunctionId === subjectFunction.id,
    ),
  );
  const behaviorBinary = path.join(
    consumer,
    "node_modules/@stsepelin/checktrail/dist/src/cli.js",
  );
  assert.deepEqual(
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          behaviorBinary,
          "review-context",
          "--root",
          behaviorRoot,
          "--input",
          ".checktrail/selection.json",
          "--detailed",
          "--allow-review-source",
        ],
        { encoding: "utf8" },
      ),
    ),
    behavior,
  );
  const revisionAssessment = {
    schemaVersion: 2,
    contextDigest: behavior.contextDigest,
    reviewer: { kind: "human", name: "Synthetic production exchange" },
    createdAt: "2026-09-30T00:00:00Z",
    usage: {
      inputTokens: null,
      outputTokens: null,
      elapsedMs: null,
      costUSD: null,
    },
    files: [
      { path: "subject.ts", disposition: "reviewed", note: "Declared" },
      {
        path: "caller.ts",
        disposition: "not-reviewed",
        note: "Explicit omission",
      },
    ],
    observations: [
      {
        id: "production-claim",
        severity: "concern",
        claim: "Unverified synthetic concern",
        attribution: "unknown",
        fixScope: "follow-up",
        citations: [
          {
            revision: "current",
            file: "subject.ts",
            sourceDigest: behavior.files.find(
              (file) => file.path === "subject.ts",
            ).sha256,
            startLine: 2,
            endLine: 2,
            quote:
              "export function subject(value = fallback) { return value; }",
          },
        ],
      },
    ],
  };
  await writeFile(
    path.join(behaviorRoot, ".checktrail/context.json"),
    JSON.stringify(behavior),
  );
  await writeFile(
    path.join(behaviorRoot, ".checktrail/assessment.json"),
    JSON.stringify(revisionAssessment),
  );
  const revisionReceipt = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {receiveReview} from "@stsepelin/checktrail"; import {readFileSync} from "node:fs"; console.log(JSON.stringify(await receiveReview("./review-profile",JSON.parse(readFileSync("./review-profile/.checktrail/context.json","utf8")),JSON.parse(readFileSync("./review-profile/.checktrail/assessment.json","utf8")))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(revisionReceipt.schemaVersion, 2);
  assert.equal(revisionReceipt.freshness, "current");
  assert.deepEqual(revisionReceipt.citations, {
    matched: 1,
    unmatched: 0,
    base: 0,
    current: 1,
  });
  assert.equal(revisionReceipt.attribution.verified, false);
  assert.equal(revisionReceipt.claimsVerified, false);
  assert.deepEqual(revisionReceipt.coverage, {
    selected: 2,
    declaredReviewed: 1,
    declaredNotReviewed: 1,
    unaccounted: 0,
  });
  const hypothesisPlan = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import {createHypothesisPlan, runProviderReview, projectProviderReview, runProviderRefutation, projectProviderRefutation} from "@stsepelin/checktrail";
    import {readFile} from "node:fs/promises";
    const context = JSON.parse(await readFile("./review-profile/.checktrail/context.json", "utf8"));
    const plan = createHypothesisPlan(context);
    const config = {schemaVersion:1,kind:"openai-responses",model:"synthetic-exact-model",credentialEnv:"SYNTHETIC_PROVIDER_KEY",pricing:null,
      limits:{wallMs:30000,maxAttempts:1,retryDelayMs:0,maxRequestBytes:1048576,maxResponseBytes:131072,maxOutputTokens:4096,admissionBudget:{inputTokenAllowance:1000,maxTotalTokens:6000,maxEstimatedCostMicrousd:null}}};
    const run = await runProviderReview("./review-profile", context, {config,allowInference:true,allowSourceDisclosure:true,environment:{SYNTHETIC_PROVIDER_KEY:"synthetic-opaque-key"},
      fetch:async (_url, options) => {
        const request = JSON.parse(options.body);
        if(request.tools.length || request.store !== false || request.input.length !== 1 || request.previous_response_id) throw new Error("Unsafe synthetic request");
        return Response.json({model:request.model,status:"completed",usage:{input_tokens:100,output_tokens:20},output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({files:context.selection.files.concat(context.selection.supportFiles).map(path=>({path,disposition:"reviewed",note:"Original synthetic transport"})),candidates:[]})}]}]});
      }});
    if(run.status !== "completed" || run.claimsVerified || run.nativeExecution || run.usage.costUSD !== null) throw new Error("Incomplete synthetic provider run");
    if(run.budget?.observedTokens !== 120 || run.budget?.billingCeilingGuaranteed !== false || run.budget?.decision !== "within-budget") throw new Error("Incomplete packaged budget accounting");
    const summary = projectProviderReview(run, false, false);
    if(JSON.stringify(summary).includes("subject.ts") || JSON.stringify(summary).includes("synthetic-opaque-key")) throw new Error("Disclosure failure");
    const targetSource=context.files.find(file=>file.path==="subject.ts");
    const target={id:"withheld-original-package-label",family:"test-adequacy",severity:"concern",claim:"Original synthetic hypothesis only.",trigger:"Declared argument.",consequence:"Declared unexpected decision.",evidenceGaps:["Mechanism and policy unknown."],attribution:"unknown",fixScope:"unknown",citations:[{file:"subject.ts",revision:"current",sourceDigest:targetSource.sha256,startLine:1,endLine:1,quote:targetSource.content.split("\\n")[0]}]};
    const refutation=await runProviderRefutation("./review-profile",context,target,{config,allowInference:true,allowSourceDisclosure:true,environment:{SYNTHETIC_PROVIDER_KEY:"synthetic-opaque-key"},fetch:async(_url,init)=>{const request=JSON.parse(init.body);const packet=JSON.parse(request.input[0].content[0].text);if(!request.instructions.includes("Attempt to falsify") || "id" in packet.refutationTarget || "severity" in packet.refutationTarget) throw new Error("Not an independent refutation packet");return Response.json({model:request.model,status:"completed",usage:{input_tokens:100,output_tokens:20},output:[{type:"message",role:"assistant",status:"completed",content:[{type:"output_text",text:JSON.stringify({files:context.selection.files.concat(context.selection.supportFiles).map(path=>({path,disposition:"reviewed",note:"Original synthetic refutation"})),candidates:[]})}]}]});}});
    if(refutation.verifier.status!=="completed" || refutation.resolution!=="unresolved" || refutation.claimsVerified)throw new Error("Refutation must not promote agreement");
    if(refutation.verifier.budget?.observedTokens!==120)throw new Error("Missing packaged refutation budget");
    const refutationSummary=projectProviderRefutation(refutation,false,false);
    if(JSON.stringify(refutationSummary).includes(target.id) || JSON.stringify(refutationSummary).includes("subject.ts"))throw new Error("Refutation disclosure failure");
    console.log(JSON.stringify(plan));
  `,
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(hypothesisPlan.families.length, 9);
  assert.equal(hypothesisPlan.claimsVerified, false);
  const hypothesisCli = JSON.parse(
    execFileSync(
      process.execPath,
      [
        behaviorBinary,
        "review-hypotheses",
        "--root",
        behaviorRoot,
        "--context",
        ".checktrail/context.json",
        "--detailed",
      ],
      { encoding: "utf8" },
    ),
  );
  assert.deepEqual(hypothesisCli, hypothesisPlan);
  const revisionArgs = [
    behaviorBinary,
    "review-receipt",
    "--root",
    behaviorRoot,
    "--context",
    ".checktrail/context.json",
    "--input",
    ".checktrail/assessment.json",
  ];
  assert.deepEqual(
    JSON.parse(
      execFileSync(
        process.execPath,
        [...revisionArgs, "--detailed", "--allow-review-source"],
        { encoding: "utf8" },
      ),
    ),
    revisionReceipt,
  );
  const revisionSummary = JSON.parse(
    execFileSync(process.execPath, [...revisionArgs, "--detailed"], {
      encoding: "utf8",
    }),
  );
  assert.equal(revisionSummary.schemaVersion, 2);
  assert.equal(revisionSummary.fixScope.followUp, 1);
  assert.ok(!JSON.stringify(revisionSummary).includes("subject.ts"));
  assert.ok(!JSON.stringify(revisionSummary).includes("synthetic concern"));
  client = new Client(
    { name: "synthetic-production-parser", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          behaviorBinary,
          "serve",
          "--root",
          behaviorRoot,
          "--detailed",
          "--allow-review-source",
        ],
        stderr: "pipe",
      }),
    );
    const response = await client.callTool({
      name: "review_context",
      arguments: behaviorSelection,
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, behavior);
    const imported = await client.callTool({
      name: "review_receipt",
      arguments: {
        context: ".checktrail/context.json",
        input: ".checktrail/assessment.json",
      },
    });
    assert.equal(imported.isError, undefined);
    assert.deepEqual(imported.structuredContent, revisionReceipt);
    const hypotheses = await client.callTool({
      name: "review_hypotheses",
      arguments: { context: ".checktrail/context.json" },
    });
    assert.equal(hypotheses.isError, undefined);
    assert.deepEqual(hypotheses.structuredContent, hypothesisPlan);
    const disabledProvider = await client.callTool({
      name: "review_run",
      arguments: { context: ".checktrail/context.json" },
    });
    assert.equal(disabledProvider.isError, true);
  } finally {
    await client.close();
    client = undefined;
  }
  await copyInstalledPackages(consumer, [
    "typescript",
    "eslint",
    "vitest",
    "vite",
    "jest",
    "vue-tsc",
    "vue",
    "@playwright/test",
  ]);
  const installedMetadata = JSON.parse(
    await readFile(
      path.join(consumer, "node_modules/@stsepelin/checktrail/server.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    installedMetadata,
    JSON.parse(await readFile(path.join(repository, "server.json"), "utf8")),
  );
  const contract = contractFixture();
  await writeFile(
    path.join(consumer, "contract.json"),
    JSON.stringify(contract),
  );
  const contractLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {validateContracts} from "@stsepelin/checktrail";import {readFileSync} from "node:fs";console.log(JSON.stringify(await validateContracts(JSON.parse(readFileSync("contract.json","utf8")))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(contractLibrary.outcome, "passed");
  assert.equal(contractLibrary.counts.accepted, 1);
  const checks = [
    "node-test",
    "typescript",
    "typescript-build",
    "eslint",
    "vitest",
    "jest",
    "vue-tsc",
    "playwright",
  ];
  const publicPack = await readFile(
    path.join(
      consumer,
      "node_modules/@stsepelin/checktrail/packs/javascript-node.json",
    ),
    "utf8",
  );
  const files = {
    "policy/node.json": publicPack,
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: checks.map((name) => ({
        path: name,
        checks: name === "node-test" ? [] : [`javascript.${name}`],
        ...(name === "node-test"
          ? {
              packs: [
                {
                  path: "policy/node.json",
                  sha256: createHash("sha256").update(publicPack).digest("hex"),
                },
              ],
            }
          : {}),
      })),
    }),
    "node-test/sum.test.js":
      "import {test} from 'node:test';import assert from 'node:assert/strict';test('adds',()=>assert.equal(2+3,5));",
    "node-test/eslint.config.mjs":
      "export default [{rules:{'no-debugger':'error'}}];",
    "typescript/tsconfig.json": JSON.stringify({
      compilerOptions: { strict: true, types: [] },
      include: ["value.ts"],
    }),
    "typescript/value.ts": "export const value: number = 42;",
    "typescript-build/tsconfig.json": JSON.stringify({
      files: [],
      references: [{ path: "./library" }],
    }),
    "typescript-build/library/tsconfig.json": JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: true,
        noEmit: true,
        noCheck: true,
        types: [],
        outDir: "build",
      },
      files: ["value.ts"],
    }),
    "typescript-build/library/value.ts": "export const value: number = 42;",
    "eslint/eslint.config.mjs":
      "export default [{files:['**/*.js','**/*.mjs'],rules:{'no-undef':'error'}}];",
    "eslint/value.js": "export const value = 42;",
    "vitest/sum.test.js":
      "import {test,expect} from 'vitest';test('adds',()=>expect(2+3).toBe(5));",
    "playwright/sum.spec.js":
      "import {test,expect} from '@playwright/test';test('adds',()=>expect(2+3).toBe(5));",
    "jest/sum.test.cjs": "test('adds',()=>expect(2+3).toBe(5));",
    "jest/jest.config.cjs": "module.exports={};",
    "vue-tsc/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["App.vue"],
    }),
    "vue-tsc/App.vue":
      '<script setup lang="ts">const value: number = 42;</script><template>{{ value.toFixed(2) }}</template>',
  };
  for (const name of checks)
    files[`${name}/package.json`] = JSON.stringify({ type: "module" });
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(consumer, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const library = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {validate} from "@stsepelin/checktrail";const report=await validate(process.cwd(),{trusted:true});console.log(JSON.stringify(report));',
      ],
      { cwd: consumer, encoding: "utf8", timeout: 60_000 },
    ),
  );
  assert.equal(library.outcome, "passed", JSON.stringify(library.checks));
  assert.equal(library.checks.length, checks.length + 1);
  assert.ok(
    library.checks.every((check) =>
      check.tools.every((tool) => tool.status === "identified"),
    ),
  );
  const binary = path.join(consumer, "node_modules/.bin/checktrail");
  const onboardingRoot = path.join(temporary, "onboarding");
  await mkdir(onboardingRoot);
  await writeFile(
    path.join(onboardingRoot, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      scripts: { test: "node --test" },
    }),
  );
  await writeFile(
    path.join(onboardingRoot, "example.test.js"),
    "import { test } from 'node:test'; test('fixture', () => {});\n",
  );
  const onboarding = (args) =>
    JSON.parse(
      execFileSync(binary, [...args, "--root", onboardingRoot], {
        cwd: consumer,
        encoding: "utf8",
      }),
    );
  assert.equal(onboarding(["init"]).status, "preview");
  assert.equal(onboarding(["init", "--write"]).status, "created");
  assert.equal(onboarding(["init", "--write"]).status, "preserved");
  assert.equal(onboarding(["doctor"]).status, "no-static-blockers");
  const generated = onboarding(["mcp-config", "--client", "vscode"]);
  const generatedServer = JSON.parse(generated.configuration).servers
    .checktrail;
  assert.equal(generatedServer.type, "stdio");
  assert.ok(!generatedServer.args.includes("--allow-execution"));
  const generatedClient = new Client(
    { name: "synthetic-generated-config-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    await generatedClient.connect(
      new StdioClientTransport({
        command: generatedServer.command,
        args: generatedServer.args,
        cwd: consumer,
        env: { ...process.env, npm_config_offline: "true" },
        stderr: "pipe",
      }),
    );
    const generatedPlan = await generatedClient.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.notEqual(generatedPlan.isError, true);
    assert.ok(JSON.stringify(generatedPlan).includes("javascript.node-test"));
    const generatedRun = await generatedClient.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(generatedRun.isError, true);
    assert.match(JSON.stringify(generatedRun), /Execution is disabled/);
  } finally {
    await generatedClient.close();
  }
  const architectureInput = architectureFixture();
  await writeFile(
    path.join(consumer, "graph.json"),
    JSON.stringify(architectureInput.graph),
  );
  await writeFile(
    path.join(consumer, "architecture.json"),
    JSON.stringify(architectureInput.policy),
  );
  const architectureLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {checkArchitecture} from "@stsepelin/checktrail";import {readFileSync} from "node:fs";const read=p=>JSON.parse(readFileSync(p,"utf8"));console.log(JSON.stringify(checkArchitecture(read("graph.json"),read("architecture.json"))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(architectureLibrary.outcome, "passed");
  const architectureCli = JSON.parse(
    execFileSync(
      binary,
      [
        "check-architecture",
        "--root",
        consumer,
        "--input",
        "graph.json",
        "--policy",
        "architecture.json",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(architectureCli.outcome, "passed");
  assert.equal(architectureCli.projects, undefined);

  const contractCli = JSON.parse(
    execFileSync(
      binary,
      ["check-contracts", "--root", consumer, "--input", "contract.json"],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(contractCli.outcome, "passed");
  assert.equal(contractCli.contracts, undefined);
  await writeFile(
    path.join(consumer, "junit.xml"),
    '<testsuite tests="1"><testcase name="synthetic" file="private-path.php"/></testsuite>',
  );
  const imported = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {importJUnit} from "@stsepelin/checktrail";import {readFileSync} from "node:fs";console.log(JSON.stringify(importJUnit(readFileSync("junit.xml","utf8"))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(imported.outcome, "passed");
  assert.equal(imported.provenance, "imported-report");
  const importedCli = JSON.parse(
    execFileSync(
      binary,
      ["import-junit", "--root", consumer, "--input", "junit.xml"],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(importedCli.outcome, "passed");
  assert.ok(!JSON.stringify(importedCli).includes("private-path.php"));
  await writeFile(
    path.join(consumer, "validation.json"),
    JSON.stringify(library),
  );
  const sarifCli = JSON.parse(
    execFileSync(
      binary,
      ["export-sarif", "--root", consumer, "--input", "validation.json"],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(sarifCli.version, "2.1.0");
  assert.equal(sarifCli.runs.length, checks.length + 1);
  assert.ok(
    sarifCli.runs.every((run) => run.invocations[0].executionSuccessful),
  );
  const sarifLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {exportSarif} from "@stsepelin/checktrail";import {readFileSync} from "node:fs";console.log(JSON.stringify(exportSarif(JSON.parse(readFileSync("validation.json","utf8")))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.deepEqual(sarifLibrary, sarifCli);
  const baseline = JSON.parse(
    execFileSync(
      binary,
      [
        "create-baseline",
        "--root",
        consumer,
        "--input",
        "validation.json",
        "--owner",
        "synthetic-maintainer",
        "--reason",
        "Synthetic package check",
        "--detailed",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  await writeFile(
    path.join(consumer, "baseline.json"),
    JSON.stringify(baseline),
  );
  const comparison = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {compareFindings} from "@stsepelin/checktrail";import {readFileSync} from "node:fs";const read=p=>JSON.parse(readFileSync(p,"utf8"));console.log(JSON.stringify(compareFindings(read("validation.json"),read("baseline.json"))));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(comparison.outcome, "passed");
  assert.equal(comparison.counts.current, 0);
  const cli = JSON.parse(
    execFileSync(binary, ["run", "--root", consumer, "--trust-project"], {
      cwd: consumer,
      encoding: "utf8",
      timeout: 60_000,
    }),
  );
  assert.equal(cli.outcome, "passed");
  const registryClient = new Client(
    { name: "synthetic-registry-install", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  try {
    const launch = installedMetadata.packages[0].packageArguments.flatMap(
      (argument) =>
        argument.type === "named"
          ? [
              `${argument.name}=${argument.value.replace("{project_root}", consumer)}`,
            ]
          : [argument.value],
    );
    await registryClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [
          path.join(
            consumer,
            "node_modules/@stsepelin/checktrail/dist/src/cli.js",
          ),
          ...launch,
        ],
        stderr: "pipe",
      }),
    );
    const planned = await registryClient.callTool({
      name: "validation_plan",
      arguments: {},
    });
    assert.equal(planned.isError, undefined);
    assert.ok(!JSON.stringify(planned).includes(consumer));
    const denied = await registryClient.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /Execution is disabled/);
  } finally {
    await registryClient.close();
  }
  client = new Client(
    { name: "synthetic-package-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["serve", "--root", consumer, "--allow-execution"],
      stderr: "pipe",
    }),
  );
  const result = await client.callTool({
    name: "validation_run",
    arguments: { timeoutMs: 30_000 },
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.outcome, "passed");
  assert.ok(!JSON.stringify(result).includes(consumer));
  assert.deepEqual(cli.checks, result.structuredContent.checks);
  const compared = await client.callTool({
    name: "finding_comparison",
    arguments: {
      runId: result.structuredContent.runId,
      baseline: "baseline.json",
    },
  });
  assert.equal(compared.isError, undefined);
  assert.equal(compared.structuredContent.outcome, "passed");
  assert.equal(compared.structuredContent.entries, undefined);
  const contractMcp = await client.callTool({
    name: "contract_validation",
    arguments: { input: "contract.json" },
  });
  assert.equal(contractMcp.isError, undefined);
  assert.equal(contractMcp.structuredContent.outcome, "passed");
  assert.deepEqual(contractMcp.structuredContent.counts, contractCli.counts);
  const architectureMcp = await client.callTool({
    name: "architecture_validation",
    arguments: { input: "graph.json", policy: "architecture.json" },
  });
  assert.equal(architectureMcp.isError, undefined);
  assert.deepEqual(
    architectureMcp.structuredContent.counts,
    architectureCli.counts,
  );
  assert.equal(architectureMcp.structuredContent.projects, undefined);
  const guidanceLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {retrieveGuidance} from "@stsepelin/checktrail";console.log(JSON.stringify(retrieveGuidance({schemaVersion:1,checks:["javascript.node-test"],topics:[]})));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(guidanceLibrary.channel, "advisory");
  assert.equal(guidanceLibrary.items[0].id, "review.test-lifecycle");
  const guidanceCli = JSON.parse(
    execFileSync(binary, ["guidance", "--root", consumer], {
      cwd: consumer,
      encoding: "utf8",
    }),
  );
  const guidanceMcp = await client.callTool({
    name: "review_guidance",
    arguments: {},
  });
  assert.equal(guidanceMcp.isError, undefined);
  assert.deepEqual(guidanceMcp.structuredContent, guidanceCli);
  assert.equal(guidanceCli.automatedCoverage, false);
  assert.equal(guidanceCli.context, undefined);
  await client.close();
  const mutationRoot = path.join(consumer, "mutation");
  await mkdir(mutationRoot);
  for (const file of [
    "package.json",
    "quantity.js",
    "quantity.test.js",
    "mutations.json",
  ])
    await writeFile(
      path.join(mutationRoot, file),
      await readFile(path.join(repository, "examples/mutations", file)),
    );
  const mutationLibrary = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import {runMutations} from "@stsepelin/checktrail";import {readFileSync} from "node:fs";console.log(JSON.stringify(await runMutations("mutation",JSON.parse(readFileSync("mutation/mutations.json","utf8")),{trusted:true})));',
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(mutationLibrary.complete, true);
  assert.deepEqual(
    mutationLibrary.trials.map((trial) => trial.status),
    ["killed", "survived"],
  );
  const mutationCli = JSON.parse(
    execFileSync(
      binary,
      [
        "mutate",
        "--root",
        mutationRoot,
        "--input",
        "mutations.json",
        "--trust-project",
      ],
      { cwd: consumer, encoding: "utf8" },
    ),
  );
  assert.equal(mutationCli.complete, true);
  assert.equal(mutationCli.trials, undefined);
  client = new Client(
    { name: "synthetic-mutation-client", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(
    new StdioClientTransport({
      command: binary,
      args: ["serve", "--root", mutationRoot, "--allow-execution"],
      stderr: "pipe",
    }),
  );
  const mutationMcp = await client.callTool({
    name: "mutation_experiment",
    arguments: { input: "mutations.json" },
  });
  assert.equal(mutationMcp.isError, undefined);
  assert.equal(mutationMcp.structuredContent.complete, true);
  assert.deepEqual(mutationMcp.structuredContent.counts, mutationCli.counts);
  const clangVersion = spawnSync(
    "clang",
    ["--no-default-config", "--version"],
    { encoding: "utf8", timeout: 10000 },
  );
  let clangSmoke = "unavailable: verified compiler not present";
  if (
    clangVersion.status === 0 &&
    !clangVersion.stderr.trim() &&
    supportedClangVersion(clangVersion.stdout)
  ) {
    const clangRoot = path.join(consumer, "cpp");
    await cp(path.join(repository, "examples/cpp"), clangRoot, {
      recursive: true,
    });
    const clangLibrary = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {validate} from "@stsepelin/checktrail";console.log(JSON.stringify(await validate("cpp",{trusted:true})));',
        ],
        { cwd: consumer, encoding: "utf8" },
      ),
    );
    assert.equal(
      clangLibrary.outcome,
      "passed",
      JSON.stringify(clangLibrary.checks),
    );
    assert.equal(clangLibrary.checks[0].id, "cpp.clang-check");
    const clangCli = JSON.parse(
      execFileSync(binary, ["run", "--root", clangRoot, "--trust-project"], {
        cwd: consumer,
        encoding: "utf8",
      }),
    );
    assert.equal(clangCli.outcome, "passed");
    await client.close();
    client = new Client(
      { name: "synthetic-clang-client", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(
      new StdioClientTransport({
        command: binary,
        args: ["serve", "--root", clangRoot, "--allow-execution"],
        stderr: "pipe",
      }),
    );
    const clangMcp = await client.callTool({
      name: "validation_run",
      arguments: {},
    });
    assert.equal(clangMcp.isError, undefined);
    assert.equal(clangMcp.structuredContent.outcome, "passed");
    assert.deepEqual(clangMcp.structuredContent.checks, clangCli.checks);
    assert.ok(!JSON.stringify(clangMcp).includes(clangRoot));
    clangSmoke = "passed";
  }
  process.stdout.write(
    `${JSON.stringify({ package: packed.filename, files: packed.files.length, checks, library: "passed", cli: "passed", mcp: "passed", installation: "offline", reviewBehavior: "passed", reviewerTransport: "offline-synthetic", sourceBoundProbe: "original-native", independentRefutation: "offline-synthetic", reviewScoring: "original-synthetic", pyright: pyrightSmoke, reproduciblePacking: "same-checkout", junit: "passed", sarif: "passed", architecture: "passed", guidance: "passed", mutations: "passed", clang: clangSmoke })}\n`,
  );
} finally {
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
