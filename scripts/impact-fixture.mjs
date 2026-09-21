import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fixtureGit, syntheticCommit } from "../dist/test/git-fixture.js";

export const projects = ["core", "other", "service", "utility", "web"];
export async function prepareImpactFixture(root, specification) {
  const manifest = JSON.stringify({
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  });
  const dependencies = [
    { consumer: "web", producer: "service" },
    { consumer: "service", producer: "core" },
  ];
  const files = {
    "checktrail.json": JSON.stringify({
      schemaVersion: 1,
      projects: projects.map((path) => ({
        path,
        checks: ["javascript.node-test"],
      })),
      workspace: {
        complete: specification.graph !== "declared-incomplete",
        dependencies:
          specification.graph === "misdeclared-complete"
            ? dependencies.filter((edge) => edge.producer !== "core")
            : dependencies,
      },
    }),
    "core/value.js": "export const value = 1;\n",
    "core/value.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.js'; test('core number',()=>assert.equal(typeof value, 'number'));\n",
    "service/value.js": "export {value} from '../core/value.js';\n",
    "service/value.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.js'; test('service contract',()=>assert.equal(value, 1));\n",
    "web/value.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../service/value.js'; test('web contract',()=>assert.equal(value, 1));\n",
    "utility/value.js": "export const value = 5;\n",
    "utility/value.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {value} from './value.js'; test('utility contract',()=>assert.equal(value, 5));\n",
    "other/value.test.js":
      "import {test} from 'node:test'; import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs'; import {value} from '../shared/value.mjs'; test('other contract',()=>{assert.equal(value, 1); assert.equal(JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8')).value, 1);});\n",
    "settings.json": '{"value":1}\n',
    "shared/value.mjs": "export const value = 1;\n",
  };
  for (const project of projects) files[`${project}/package.json`] = manifest;
  for (const [file, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), contents);
  }
  fixtureGit(root, ["init", "--quiet", "--object-format=sha1"]);
  const base = await syntheticCommit(root, files);
  return {
    base,
    files: Object.keys(files).length,
    applyChanges: async () => {
      for (const [file, contents] of Object.entries(specification.changes)) {
        assert.ok(
          Object.hasOwn(files, file),
          "Impact cases may only edit original fixture files",
        );
        await writeFile(path.join(root, file), contents);
      }
    },
  };
}
