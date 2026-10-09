import assert from "node:assert/strict";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fixture } from "./helpers.js";
const python = spawnSync("python3", ["--version"], {
  encoding: "utf8",
  timeout: 10000,
});
const skip =
  python.status === 0
    ? false
    : "Python archive preflight interpreter unavailable";
const script = await readFile(
  new URL(
    "../../scripts/extract-rust-extension-components.py",
    import.meta.url,
  ),
  "utf8",
);
async function prepare(root: string, bad: string) {
  await mkdir(path.join(root, ".checktrail/rust-extension-components"), {
    recursive: true,
  });
  const setup = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      `import io,tarfile,json,hashlib
from pathlib import Path
r=Path.cwd();records=[]
for i in range(6):
 prefix='component'+str(i);file=prefix+'.tar.xz';p=r/'.checktrail/rust-extension-components'/file
 with tarfile.open(p,'w:xz') as t:
  body=b'original synthetic component';m=tarfile.TarInfo(prefix+'/payload/value');m.size=len(body);t.addfile(m,io.BytesIO(body))
  alias=tarfile.TarInfo(prefix+'/payload/alias');alias.type=tarfile.SYMTYPE;alias.linkname='../../escaped' if i==5 and ${JSON.stringify(bad)}=='link' else 'value';t.addfile(alias)
 b=p.read_bytes();records.append({'file':file,'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
if ${JSON.stringify(bad)}=='hash':records[-1]['sha256']='0'*64
if ${JSON.stringify(bad)}=='bytes':records[-1]['bytes']-=1
(r/'scripts/rust-extension-components.json').write_text(json.dumps({'records':records}))
`,
    ],
    { cwd: root, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(setup.status, 0, setup.stderr);
}
test(
  "native component extraction preflights the last archive under Python optimization before writing any payload",
  { skip },
  async (t) => {
    for (const bad of ["hash", "bytes", "link"]) {
      const root = await fixture(t, {
        "scripts/extract-rust-extension-components.py": script,
      });
      await prepare(root, bad);
      const run = spawnSync(
        "python3",
        ["-I", "-O", "scripts/extract-rust-extension-components.py"],
        { cwd: root, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(
        run.status,
        1,
        `The last ${bad} violation must be rejected with optimization enabled`,
      );
      assert.match(
        run.stderr,
        /ValueError: Native component archive preflight violation/,
      );
      await assert.rejects(
        access(path.join(root, ".checktrail/rust-extension-payload")),
        { code: "ENOENT" },
      );
      await assert.rejects(access(path.join(root, ".checktrail/escaped")), {
        code: "ENOENT",
      });
    }
  },
);
test(
  "native component extraction accepts contained relative links and refuses to replace retained payload",
  { skip },
  async (t) => {
    const root = await fixture(t, {
      "scripts/extract-rust-extension-components.py": script,
    });
    await prepare(root, "");
    const run = spawnSync(
      "python3",
      ["-I", "-O", "scripts/extract-rust-extension-components.py"],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(
      JSON.parse(run.stdout).allArchivesPreflightedBeforeExtraction,
      true,
    );
    assert.equal(
      await readFile(
        path.join(
          root,
          ".checktrail/rust-extension-payload/component5/payload/alias",
        ),
        "utf8",
      ),
      "original synthetic component",
    );
    const marker = path.join(root, ".checktrail/rust-extension-payload/retain");
    await writeFile(marker, "retain original");
    const repeated = spawnSync(
      "python3",
      ["-I", "-O", "scripts/extract-rust-extension-components.py"],
      { cwd: root, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /Native payload already exists/);
    assert.equal(await readFile(marker, "utf8"), "retain original");
  },
);
