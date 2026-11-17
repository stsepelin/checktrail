// Passive declaration parsing only. No Git/config command, URL resolution,
// interpolation, include, filesystem access or transport is used here.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { URL } from "node:url";
import {
  digest,
  gitObject,
  objectId,
  relativePath,
  selectedBlob,
} from "./emsdk-metadata-values.mjs";

export const gitmodulesLimits = Object.freeze({
  bytes: 1572864,
  lines: 32768,
  lineCharacters: 4096,
  modules: 2048,
  settingsPerModule: 32,
  valueCharacters: 2048,
});

function configValue(raw) {
  const value = raw.replace(/^[ \t]*/u, "");
  let parsed;
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    assert.ok(end > 0, "Unclosed .gitmodules value");
    assert.match(value.slice(end + 1), /^[ \t]*(?:[#;].*)?$/u);
    parsed = value.slice(1, end);
  } else {
    const comment = value.search(/[#;]/u);
    assert.ok(
      comment < 0 || comment === 0 || /[ \t]/u.test(value[comment - 1]),
      "Ambiguous .gitmodules value/comment boundary",
    );
    parsed = (comment < 0 ? value : value.slice(0, comment)).replace(
      /[ \t]*$/u,
      "",
    );
  }
  assert.ok(
    !/["\\]/u.test(parsed) && parsed.length <= gitmodulesLimits.valueCharacters,
    "Unsupported .gitmodules escapes, mixed quotes or value bound",
  );
  return parsed;
}

function moduleUrl(value) {
  assert.ok(
    value.length > 0 && value.length <= gitmodulesLimits.valueCharacters,
  );
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "Unsupported submodule URL scheme");
  assert.equal(url.username, "", "Submodule URL credentials are unsupported");
  assert.equal(url.password, "", "Submodule URL credentials are unsupported");
  assert.equal(url.port, "", "Submodule URL ports are unsupported");
  assert.equal(url.search, "", "Submodule URL query is unsupported");
  assert.equal(url.hash, "", "Submodule URL fragment is unsupported");
  assert.equal(url.href, value, "Noncanonical submodule URL");
  assert.ok(
    url.hostname.length <= 253 &&
      url.hostname
        .split(".")
        .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part)),
    "Unsupported submodule URL host",
  );
  relativePath(url.pathname.slice(1));
  return value;
}

// Deliberately finite Git-config subset: quoted submodule headers, explicit
// assignments, plain or wholly quoted single-line values, LF/CRLF, and comments.
// Escapes, continuations, bare boolean keys and foreign/include sections fail.
// Other submodule settings remain inert strings and are never applied.
export function parseGitmodules(bytes) {
  assert.ok(
    Buffer.isBuffer(bytes) && bytes.length <= gitmodulesLimits.bytes,
    ".gitmodules byte bound exceeded",
  );
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  for (const character of text) {
    const code = character.codePointAt(0);
    assert.ok(
      (code >= 32 && code !== 127 && code !== 0xfeff) ||
        code === 9 ||
        code === 10 ||
        code === 13,
      "Unsupported .gitmodules control character or byte-order mark",
    );
  }
  const lines = text.split(/\r?\n/u);
  assert.ok(
    lines.length <= gitmodulesLimits.lines,
    ".gitmodules line bound exceeded",
  );
  const sections = [],
    names = new Set();
  let current;
  for (const line of lines) {
    assert.ok(
      line.length <= gitmodulesLimits.lineCharacters && !line.includes("\r"),
      ".gitmodules line bound or line ending invalid",
    );
    if (/^[ \t]*(?:[#;].*)?$/u.test(line)) continue;
    const header =
      /^[ \t]*\[([A-Za-z]+)[ \t]+"([^"\\]+)"\][ \t]*(?:[#;].*)?$/u.exec(line);
    if (header) {
      assert.equal(
        header[1].toLowerCase(),
        "submodule",
        "Unsupported .gitmodules section",
      );
      const name = header[2];
      assert.ok(
        name.length <= 1024 && !names.has(name),
        "Duplicate or oversized submodule section",
      );
      assert.ok(
        sections.length < gitmodulesLimits.modules,
        ".gitmodules module bound exceeded",
      );
      names.add(name);
      current = { name, settings: new Map() };
      sections.push(current);
      continue;
    }
    const assignment = /^[ \t]*([A-Za-z][A-Za-z0-9-]*)[ \t]*=[ \t]*(.*)$/u.exec(
      line,
    );
    assert.ok(
      current && assignment,
      "Unsupported .gitmodules section or assignment",
    );
    const key = assignment[1].toLowerCase();
    assert.ok(!current.settings.has(key), "Duplicate .gitmodules key");
    assert.ok(
      current.settings.size < gitmodulesLimits.settingsPerModule,
      ".gitmodules setting bound exceeded",
    );
    current.settings.set(key, configValue(assignment[2]));
  }
  const paths = new Set();
  const modules = sections.map(({ name, settings }) => {
    assert.ok(
      settings.has("path") && settings.has("url"),
      "Missing submodule path or URL",
    );
    const path = relativePath(settings.get("path"));
    assert.ok(!paths.has(path), "Duplicate submodule path");
    paths.add(path);
    return {
      name,
      path,
      url: moduleUrl(settings.get("url")),
      uninterpretedSettings: [...settings]
        .filter(([key]) => key !== "path" && key !== "url")
        .map(([key, value]) => ({ key, value })),
    };
  });
  for (const modulePath of paths)
    for (
      let boundary = modulePath.indexOf("/");
      boundary >= 0;
      boundary = modulePath.indexOf("/", boundary + 1)
    )
      assert.ok(
        !paths.has(modulePath.slice(0, boundary)),
        "Overlapping submodule paths",
      );
  return modules;
}

// entries must come from the collector's recomputed root tree. Recheck that the
// exact bytes being parsed name that tree's regular .gitmodules blob. Retention
// already uses emsdk-metadata-file.mjs; no second filesystem reader is needed.
export function bindGitmoduleUrls(bytes, entries) {
  assert.ok(entries instanceof Map && entries.size <= gitmodulesLimits.modules);
  const gitBlob = selectedBlob(entries, {
    path: ".gitmodules",
    requiredTreeEntry: true,
  });
  assert.equal(
    gitObject("blob", bytes),
    gitBlob,
    ".gitmodules Git blob mismatch",
  );
  const modules = parseGitmodules(bytes);
  const declarations = modules.map((module) => {
    const parts = module.path.split("/");
    const entry = entries.get(parts[0]);
    assert.ok(
      entry,
      "Foreign submodule path is absent from the admitted root tree",
    );
    if (parts.length > 1) {
      assert.ok(
        entry.type === "tree" && entry.mode === 16384,
        "Nested submodule ancestry is not an admitted directory tree",
      );
      return {
        ...module,
        state: "unverified-nested-tree-not-admitted",
        commit: null,
        moduleUrlBindingVerified: false,
        sourceBodyRetained: false,
      };
    }
    assert.ok(
      entry.type === "commit" && entry.mode === 57344,
      "Submodule path is not an exact root Gitlink",
    );
    return {
      ...module,
      state: "exact-root-gitlink-bound",
      commit: objectId(entry.id),
      moduleUrlBindingVerified: true,
      sourceBodyRetained: false,
    };
  });
  const byPath = new Map(declarations.map((item) => [item.path, item]));
  const gitlinks = [...entries.values()]
    .filter((entry) => entry.type === "commit")
    .map((entry) => {
      assert.equal(entry.mode, 57344);
      const binding = byPath.get(entry.name);
      assert.ok(
        binding && binding.moduleUrlBindingVerified,
        "Root Gitlink has no exact .gitmodules binding",
      );
      return {
        path: entry.name,
        commit: objectId(entry.id),
        sourceBodyRetained: false,
        moduleUrlBindingVerified: true,
        moduleName: binding.name,
        moduleUrl: binding.url,
      };
    });
  return {
    gitlinks,
    moduleUrlBindings: {
      scope:
        "Declared URLs and exact root Gitlinks only; no URL fetch, nested source, notices or producer-build qualification.",
      gitBlob,
      sha256: digest(bytes),
      declarations,
      nestedSourceClosureVerified: false,
    },
  };
}
