import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import {
  gitMetadataEnvironment,
  gitMetadataPrefix,
  isGitMetadataCommand,
  isWindowsBuiltinGit,
} from "../src/git-metadata-policy.js";
import { runHostGitMetadata } from "../src/posix-target.js";
import { gitReader } from "../src/git-selection.js";
import { fixture } from "./helpers.js";
import { fixtureGit, syntheticCommit } from "./git-fixture.js";
import type { Command } from "../src/types.js";
const hash = "a".repeat(40),
  platform = ["darwin", "linux"].includes(process.platform);
const command = (args: string[]): Command => ({
  executable: "/original/operator/git",
  args: [...gitMetadataPrefix, ...args],
  cwd: ".",
  env: { ...gitMetadataEnvironment },
});
test("Git metadata admission permits exact read-only forms and literal leading-option filenames while rejecting neighboring commands and execution flags", () => {
  for (const file of [
    "C:/synthetic/SDK/mingw64/bin/git.exe",
    "D:/SYNTHETIC/MINGW64/BIN/GIT.EXE",
  ])
    assert.equal(isWindowsBuiltinGit(file), true, file);
  for (const file of [
    "C:/synthetic/SDK/cmd/git.exe",
    "C:/synthetic/SDK/bin/git.exe",
    "C:/synthetic/SDK/mingw640/bin/git.exe",
    "C:/synthetic/SDK/mingw64/binary/git.exe",
    "C:/synthetic/SDK/mingw64/bin/git.exe.backup",
    "C:/synthetic/SDK/mingw64/bin/git.cmd",
    "//synthetic.invalid/share/mingw64/bin/git.exe",
    "mingw64/bin/git.exe",
  ])
    assert.equal(isWindowsBuiltinGit(file), false, file);

  for (const args of [
    ["--version"],
    ["rev-parse", "--show-toplevel"],
    ["rev-parse", "--verify", "HEAD^{commit}"],
    ["rev-parse", "--verify", "--end-of-options", "original-branch^{commit}"],
    ["ls-files", "--stage", "-z"],
    ["ls-tree", "-rz", "--full-tree", hash],
    [
      "--literal-pathspecs",
      "ls-tree",
      "-rz",
      "--full-tree",
      hash,
      "--",
      "--filters;literal.ts",
    ],
    ["cat-file", "-s", hash],
    ["cat-file", "blob", "b".repeat(64)],
  ])
    assert.equal(isGitMetadataCommand(command(args)), true, args.join(" "));
  for (const args of [
    ["--exec-path"],
    ["rev-parse-other", "--show-toplevel"],
    ["ls-files-extra", "--stage", "-z"],
    ["cat-file", "--filters", hash],
    ["cat-file", "--textconv", hash],
    ["cat-files", "blob", hash],
    ["ls-tree", "-rz", "--full-tree", "--original-option"],
    ["ls-files", "--stage", "-z", "--debug"],
    ["-c", "core.sshCommand=original", "rev-parse", "HEAD"],
    ["fetch", "original"],
    ["checkout", "original"],
    ["--literal-pathspecs", "cat-file", "blob", hash],
  ])
    assert.equal(isGitMetadataCommand(command(args)), false, args.join(" "));
  for (const key of Object.keys(gitMetadataEnvironment)) {
    const removed = command(["--version"]);
    delete removed.env![key];
    assert.equal(isGitMetadataCommand(removed), false, key);
    const changed = command(["--version"]);
    changed.env![key] += "original";
    assert.equal(isGitMetadataCommand(changed), false, key);
  }
  for (let index = 0; index < gitMetadataPrefix.length; index++) {
    const changed = command(["--version"]);
    changed.args[index] += "original";
    assert.equal(isGitMetadataCommand(changed), false, String(index));
  }
  const extra = command(["--version"]);
  extra.env!.ORIGINAL_METADATA_EXTRA = "value";
  assert.equal(isGitMetadataCommand(extra), false);
});
test(
  "Git metadata rejects project-local executables and arbitrary commands before any native source marker",
  { skip: !platform },
  async (t) => {
    const root = await realpath(await fixture(t, {})),
      outside = await realpath(await fixture(t, {})),
      marker = path.join(outside, "executed"),
      program = `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'Original operator probe.');process.stdout.write('git version original');\n`;
    const executable = path.join(outside, "git");
    await writeFile(executable, program);
    await chmod(executable, 0o700);
    const local = path.join(root, "git");
    await writeFile(local, program);
    await chmod(local, 0o700);
    await assert.rejects(
      runHostGitMetadata(
        root,
        { ...command(["--version"]), executable: local },
        { timeoutMs: 1000 },
      ),
    );
    await assert.rejects(
      runHostGitMetadata(
        root,
        { ...command(["fetch", "original"]), executable },
        { timeoutMs: 1000 },
      ),
    );
    await assert.rejects(
      runHostGitMetadata(
        root,
        { ...command(["--version"]), executable },
        { timeoutMs: 5001 },
      ),
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
    const result = await runHostGitMetadata(
      root,
      { ...command(["--version"]), executable },
      { timeoutMs: 1000 },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "git version original");
    assert.equal(await readFile(marker, "utf8"), "Original operator probe.");
  },
);
test(
  "Git metadata retains its five-second aggregate budget for both size and original byte reads across the selected 64-file boundary",
  { skip: !platform, timeout: 30000 },
  async (t) => {
    const files = Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          "source-" + i + ".ts",
          "export const original=" + i + ";\n",
        ]),
      ),
      root = await fixture(t, files);
    fixtureGit(root, ["init", "--quiet"]);
    const base = await syntheticCommit(root, files),
      read = gitReader(root);
    const tree = await read(["ls-tree", "-rz", "--full-tree", base]);
    const entries = tree
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const match = /^100644 blob ([a-f0-9]{40}|[a-f0-9]{64})\t(.+)$/.exec(
          line,
        );
        assert.ok(match);
        return { oid: match[1]!, file: match[2]! };
      });
    assert.equal(entries.length, Object.keys(files).length);
    for (const entry of entries) {
      const bytes = await read(["cat-file", "blob", entry.oid]);
      assert.equal(bytes, files[entry.file]);
      assert.equal(
        Number((await read(["cat-file", "-s", entry.oid])).trim()),
        Buffer.byteLength(bytes),
      );
    }
  },
);

test(
  "native Git metadata passes the complete independent safety configuration to the operator executable without inheriting a project override",
  { skip: !platform },
  async (t) => {
    const root = await realpath(await fixture(t, {})),
      operator = await realpath(await fixture(t, {})),
      executable = path.join(operator, "git");
    const names = [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "GIT_NO_LAZY_FETCH",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_ATTR_NOSYSTEM",
      "GIT_ALLOW_PROTOCOL",
    ];
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2),env:Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))}));\n`,
    );
    await chmod(executable, 0o700);
    const result = await runHostGitMetadata(
      root,
      { ...command(["--version"]), executable },
      { timeoutMs: 1000 },
    );
    assert.equal(result.exitCode, 0);
    const observed = JSON.parse(result.stdout);
    assert.deepEqual(observed.args, [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "submodule.recurse=false",
      "--version",
    ]);
    assert.deepEqual(observed.env, {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ATTR_NOSYSTEM: "1",
      GIT_ALLOW_PROTOCOL: "",
    });
  },
);

test("Windows metadata uses only the native outside-project executable, retains refusal and output boundaries, and compares staged modes without inventing chmod changes", async (t) => {
  const root = await realpath(
    await fixture(t, {
      "original.js": "export const original = true;\n",
      "git.exe": "Original project executable marker; must never execute.",
    }),
  );
  const operator = await realpath(
    await fixture(t, {
      "mingw64/bin/git.exe":
        "Original synthetic operator built-in; native calls are intercepted.",
      "cmd/git.exe": "Original forwarding launcher; must not execute.",
      "git.cmd": "Original synthetic wrapper; must never be admitted.",
    }),
  );
  await chmod(path.join(operator, "mingw64/bin/git.exe"), 0o755);
  await chmod(path.join(operator, "cmd/git.exe"), 0o755);
  const helper = await fixture(t, {
    "observe.mjs": `import assert from 'node:assert/strict';
import cp from 'node:child_process';import{syncBuiltinESMExports}from'node:module';
import{createHash}from'node:crypto';import{readFile}from'node:fs/promises';import path from'node:path';
const[root,operator,metadataModule,selectionModule]=process.argv.slice(2);const calls=[];
let reply='version',indexMode='100755',treeMode='100755';
const contents=await readFile(path.join(root,'original.js'));
const nul=String.fromCharCode(0),nl=String.fromCharCode(10),tab=String.fromCharCode(9);
const oid=createHash('sha1').update('blob '+contents.length+nul).update(contents).digest('hex');
cp.spawnSync=(executable,args,options)=>{
 calls.push({executable,args,options});
 assert.equal(executable,path.join(operator,'mingw64','bin','git.exe'));
 assert.equal(options.shell,false);assert.equal(options.killSignal,'SIGKILL');
 assert.equal(options.env.ORIGINAL_UNLISTED_SECRET,undefined);
 assert.equal(options.env.GIT_CONFIG_NOSYSTEM,'1');assert.equal(options.env.GIT_NO_LAZY_FETCH,'1');
 const flags=['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','submodule.recurse=false'];assert.deepEqual(args.slice(0,flags.length),flags);
 let stdout='git version 2.56.0'+nl,stderr='',status=0,error;
 if(reply==='output'){stdout='abcd';stderr='efgh';}
 else if(reply==='refusal'){status=7;stderr='Original refusal';}
 else if(reply==='timeout'){status=null;error=Object.assign(new Error('Original timeout'),{code:'ETIMEDOUT'});}
 else if(reply==='metadata'){
  const q=args.slice(flags.length);if(q[0]==='--version')stdout='git version 2.56.0'+nl;
  else if(q[0]==='rev-parse')stdout=q[1]==='--show-toplevel'?root+nl:'a'.repeat(40)+nl;
  else if(q[0]==='ls-tree')stdout=treeMode+' blob '+oid+tab+'original.js'+nul;
  else if(q[0]==='ls-files')stdout=indexMode+' '+oid+' 0'+tab+'original.js'+nul;
  else throw Error('Unexpected metadata command');
 }
 return{pid:42,status,signal:null,stdout:Buffer.from(stdout),stderr:Buffer.from(stderr),error};
};syncBuiltinESMExports();Object.defineProperty(process,'platform',{value:'win32'});
process.env.PATH=[root,path.join(operator,'cmd')].join(path.delimiter);process.env.ORIGINAL_UNLISTED_SECRET='Must remain outside the native query';
const{runHostGitMetadata}=await import(metadataModule);const{gitReader,selectGitChanges}=await import(selectionModule);
const command={executable:path.join(operator,'mingw64','bin','git.exe'),args:['--no-pager','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','submodule.recurse=false','--version'],cwd:'.',env:{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_NO_REPLACE_OBJECTS:'1',GIT_ATTR_NOSYSTEM:'1',GIT_ALLOW_PROTOCOL:''}};
const read=gitReader(root);assert.match(await read(['--version']),/^git version 2[.]56[.]0/);assert.equal(calls.length,1);
for(const invalid of [{...command,executable:path.join(root,'git.exe')},{...command,executable:path.join(operator,'git.cmd')},{...command,executable:path.join(operator,'cmd','git.exe')},{...command,args:[...command.args.slice(0,-1),'--exec-path']},{...command,env:{...command.env,GIT_CONFIG_NOSYSTEM:'0'}}])await assert.rejects(runHostGitMetadata(root,invalid,{timeoutMs:1000}));
assert.equal(calls.length,1,'Rejected commands must never reach native creation');
reply='output';const bounded=await runHostGitMetadata(root,command,{timeoutMs:1000,maxOutputBytes:7});assert.equal(bounded.stdout,'abcd');assert.equal(bounded.stderr,'efg');assert.equal(bounded.outputBytes,8);assert.equal(bounded.truncated,true);
reply='refusal';const refused=await runHostGitMetadata(root,command,{timeoutMs:1000});assert.equal(refused.exitCode,7);assert.equal(refused.stderr,'Original refusal');
reply='timeout';const timed=await runHostGitMetadata(root,command,{timeoutMs:1000});assert.equal(timed.timedOut,true);assert.equal(timed.errorCode,'ETIMEDOUT');
reply='metadata';
for(const mode of ['100644','100755']){indexMode=treeMode=mode;const selected=await selectGitChanges({root,files:['original.js'],excluded:[]},['.'],'a'.repeat(40),{complete:true,dependencies:[]});assert.deepEqual(selected.changedFiles,[]);assert.match(selected.reason,/No changed paths/);assert.ok(selected.git);}
indexMode='100755';treeMode='100644';const staged=await selectGitChanges({root,files:['original.js'],excluded:[]},['.'],'a'.repeat(40),{complete:true,dependencies:[]});assert.deepEqual(staged.changedFiles,['original.js'],'A staged executable-mode change must remain visible');
console.log(JSON.stringify({nativeAdmissionCalls:calls.length,stagedModeChangeRetained:true}));`,
  });
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    [
      path.join(helper, "observe.mjs"),
      root,
      operator,
      new URL("../src/posix-target.js", import.meta.url).href,
      new URL("../src/git-selection.js", import.meta.url).href,
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).stagedModeChangeRetained, true);
});
