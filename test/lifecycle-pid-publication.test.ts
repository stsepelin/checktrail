import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  fixture,
  lifecyclePidPublication,
  assertLifecyclePids,
} from "./helpers.js";
import { javascriptLifecycleWorker } from "./javascript-extensions-fixture.js";

type Language = "javascript" | "python" | "php";
const commands = {
  javascript: process.execPath,
  python: "python3",
  php: "php",
};
const available = Object.fromEntries(
  Object.entries(commands).map(([language, command]) => [
    language,
    spawnSync(command, ["--version"], { timeout: 3000, maxBuffer: 8192 })
      .status === 0,
  ]),
);

async function pausedPublication(
  t: TestContext,
  language: Language,
  name: "parent" | "child",
  actualWorker?: string,
  directPublication = false,
) {
  const root = await fixture(t, {});
  const publication = directPublication
    ? language === "javascript"
      ? `fs.writeFileSync('${name}.ready',String(process.pid));`
      : language === "python"
        ? `pathlib.Path('${name}.ready').write_text(str(os.getpid()))`
        : `file_put_contents('${name}.ready',(string)getmypid());`
    : lifecyclePidPublication(language, name);
  let args: string[];
  if (language === "javascript") {
    const instrumentation = `const publicationFS=require('node:fs');const originalWrite=publicationFS.writeFileSync;publicationFS.writeFileSync=function(file,...args){if(file==='${name}.pending'||file==='${name}.ready'){originalWrite.call(this,file,'');originalWrite.call(this,'publication.entered.pending',String(process.pid));publicationFS.renameSync('publication.entered.pending','publication.entered');while(!publicationFS.existsSync('publication.release'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}return originalWrite.call(this,file,...args);};`;
    args = [
      "--eval",
      instrumentation +
        (actualWorker ??
          `const fs=require('node:fs');${publication}setInterval(()=>{},100);`),
    ];
  } else if (language === "python") {
    args = [
      "-c",
      `import os,time,pathlib
original_write=pathlib.Path.write_text
def paused_write(self,data,*args,**kwargs):
    if str(self) in ('${name}.pending','${name}.ready'):
        original_write(self,'')
        original_write(pathlib.Path('publication.entered.pending'),str(os.getpid()))
        os.replace('publication.entered.pending','publication.entered')
        while not pathlib.Path('publication.release').exists():time.sleep(.01)
    return original_write(self,data,*args,**kwargs)
pathlib.Path.write_text=paused_write
${publication}
while True:time.sleep(.1)
`,
    ];
  } else {
    args = [
      "-r",
      `namespace ChecktrailFixture;function file_put_contents($file,$data,...$rest){if($file==='${name}.pending'||$file==='${name}.ready'){\\file_put_contents($file,'');\\file_put_contents('publication.entered.pending',(string)getmypid());\\rename('publication.entered.pending','publication.entered');while(!\\file_exists('publication.release')){\\clearstatcache(true,'publication.release');\\usleep(10000);}}return \\file_put_contents($file,$data,...$rest);}${publication}while(true)usleep(10000);`,
    ];
  }
  const child = spawn(commands[language], args, { cwd: root, stdio: "ignore" });
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  void closed.catch(() => {});
  try {
    assert.ok(child.pid, "The selected host interpreter must start");
    let entered = false;
    for (let i = 0; i < 300; i++) {
      try {
        await access(path.join(root, "publication.entered"));
        entered = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await delay(10);
    }
    assert.equal(
      entered,
      true,
      "The actual publisher must reach the deliberately paused empty write",
    );
    await assert.rejects(readFile(path.join(root, name + ".ready")), {
      code: "ENOENT",
    });
    assert.equal(
      await readFile(path.join(root, name + ".pending"), "utf8"),
      "",
    );
    await writeFile(path.join(root, "publication.release"), "go");
    let ready = "";
    for (let i = 0; i < 300; i++) {
      try {
        ready = await readFile(path.join(root, name + ".ready"), "utf8");
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await delay(10);
    }
    assert.equal(ready, String(child.pid));
    assertLifecyclePids({ parent: process.pid, child: Number(ready) });
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}
for (const language of ["javascript", "python", "php"] as const) {
  for (const name of ["parent", "child"] as const) {
    test(
      `lifecycle PID publication hides reached empty ${language} ${name} writes until the complete identity is available`,
      {
        skip: available[language]
          ? false
          : `Host ${language} interpreter unavailable; native profile qualification remains separate`,
        timeout: 15000,
      },
      async (t) => {
        await assert.rejects(
          pausedPublication(t, language, name, undefined, true),
          {
            code: "ERR_ASSERTION",
            message: /Missing expected rejection/,
          },
        );
        await pausedPublication(t, language, name);
      },
    );
  }
}
test(
  "the actual JavaScript lifecycle worker cannot publish a partially written child identity",
  { timeout: 15000 },
  async (t) =>
    pausedPublication(
      t,
      "javascript",
      "child",
      javascriptLifecycleWorker("cancel"),
    ),
);
test("lifecycle PID checks reject reserved group malformed and shared parent-child identities before process operations", () => {
  assertLifecyclePids({ parent: 2, child: 3 });
  for (const invalid of [
    0,
    1,
    -1,
    NaN,
    Infinity,
    2.5,
    Number.MAX_SAFE_INTEGER + 1,
    "",
    "7",
    null,
    undefined,
    {},
    true,
  ]) {
    for (const role of ["parent", "child"] as const) {
      assert.throws(
        () => assertLifecyclePids({ parent: 2, child: 3, [role]: invalid }),
        {
          code: "ERR_ASSERTION",
          message: new RegExp(
            `Native lifecycle ${role} PID must identify an individual process`,
          ),
        },
      );
    }
  }
  assert.throws(() => assertLifecyclePids({ parent: 2, child: 2 }), {
    code: "ERR_ASSERTION",
    message: /parent and child PIDs must be distinct/,
  });
});
