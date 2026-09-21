# Checktrail naming

Checktrail replaces the development name Repo Verifier before the first npm
publication. The preview version remains `0.1.0-alpha.1`; the package identity and
bytes change, so previous tarball hashes and approvals do not apply to this package.

| Surface                 | Current identity                            |
| ----------------------- | ------------------------------------------- |
| GitHub                  | `stsepelin/checktrail`                      |
| npm                     | `@stsepelin/checktrail`                     |
| CLI and MCP server name | `checktrail`                                |
| MCP Registry            | `io.github.stsepelin/checktrail`            |
| Project policy          | `checktrail.json`                           |
| Native profiles         | `checktrail.<profile>.json`                 |
| Private local artifacts | `.checktrail/` and `.checktrail.local.json` |

For an existing source checkout:

1. Update the Git remote to `git@github.com:stsepelin/checktrail.git` and rebuild.
2. Rename `repo-verifier.json` and each `repo-verifier.<profile>.json` to its
   `checktrail` equivalent. The supported profiles are actionlint, django, dotnet,
   fastapi, java, laravel, nuxt and vue-router. A remaining legacy policy or profile
   causes planning to fail with a rename instruction; it cannot silently drop a
   requirement and proceed with defaults. Remove duplicate old files when both
   names exist.
3. Update scripts, imports and MCP client registration using [INSTALLATION.md](INSTALLATION.md).
   Registrations keep an absolute project root, so update that path if the
   checkout directory was moved. Execution still requires explicit startup trust.
4. Use `.checktrail/` for new reports and prepared development tools. Legacy
   `.repo-verifier/` and `.repo-verifier.local.json` remain excluded from inventory
   and Git to preserve the privacy of existing artifacts.

Internal native-runner markers, temporary paths and runtime producer names now use
Checktrail. Regenerate runtime captures with the new package when comparing them;
old producer identities are not rewritten into new observations. The runner-owned
temporary-directory environment variable is now `CHECKTRAIL_TEMP`.

## Historical evidence

Existing JSON measurements retain their original names, versions, hashes, URLs
and observations. They describe the measured source and artifacts under the old
name, not verification of a later Checktrail build. Old repository links may
redirect after the GitHub rename.

The original synthetic evaluation corpus is retained byte-for-byte at
`measurements/evaluation-corpus-repo-verifier.json` so its recorded digests and
case accounting remain independently checkable. `scripts/evaluation-corpus.json`
is now `synthetic-evaluation-v2` with the new configuration filenames. The old
measurements do not establish results for that revised corpus. Reproduction
commands elsewhere in the documentation use current names; consult the recorded
source identity to reproduce a historical run exactly.

The pre-rename hosted CI baselines remain historical evidence. The rename commit
requires its own hosted run, and the renamed package requires fresh installation
and client checks before publication.
