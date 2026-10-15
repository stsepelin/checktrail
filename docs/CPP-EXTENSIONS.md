# Selected C/C++ local CMake and SDK extensions

`cpp.build-extensions`, `cpp.ctest-extensions`, `cpp.clang-format-extensions`
and `cpp.clang-tidy-extensions` are explicit opt-ins through
`checktrail.cpp-extensions.json`. The original checks retain their contract in
[CPP-TOOLS.md](CPP-TOOLS.md). The shared engine supplies library, CLI and MCP
behavior. Discovery and planning read bounded data without evaluating CMake or
executing project code; execution requires operator trust at CLI invocation or
MCP startup.

The `declared-local-cmake-transitive-sdk-v1` profile selects Clang/LLVM 22.1.3,
CMake/CTest 4.2.3, GNU Make 4.4.1 and GNU Binutils 2.45.1 on
`aarch64-alpine-linux-musl`, with sysroot `/` and C++ `libstdc++`.
Its [schema](../schemas/cpp-extensions-config.schema.json) declares local
`add_subdirectory` directories, static/shared/executable targets, C17 `.c` and
C++20 `.cpp` sources, public/private include and link interfaces, headers,
integer `CT_` template variables and registered CTest executable callbacks.
CMake files must exactly equal the finite per-directory renderer. Remote
projects, arbitrary CMake statements, unselected options, target cycles,
undeclared or unused source/header scope and escaping paths are unsupported.

SDK pins bind bounded canonical physical paths, aliases, byte counts and SHA-256
identities. Trusted execution verifies the selected full header and finite
CRT/compiler-support/standard-library/musl cohort before project evaluation and
after execution. Native dependency observations reconcile the consumed subset.
This is a selected SDK closure; it does not establish the whole operating-system,
loader, publisher or license closure. The operator preparation uses the original
checksum-pinned, signature-verified APK runtime with networking disabled. It does
not disable package signatures. Atomic SDK publication explicitly grants directory
traversal and manifest read access to the native UID 1000 process.

Fresh owned source/build/cache directories prevent reuse of project outputs.
Protected compiler, linker, loader, CMake, CTest and analyzer overrides are removed.
The compiler explicitly selects `/usr/bin` GNU assembler/linker tooling, disables
its integrated assembler and default configuration/implicit modules, and records
native SARIF, dependency and DWARF evidence. With the pinned toolchain, the
standard-library fixture lacks file checksums under the integrated assembler;
the selected GNU assembler emits them with reversed MD5 byte order. The importer
normalizes that measured representation. Only the exact zero-hash virtual
`<stdin>` record is admitted. Missing hashes for real owned sources and consumed
SDK headers remain incomplete.

Native CMake file-API/codemodel, compilation databases and verbose compiler/linker
commands must match every declared directory, target, source role and interface.
Static private links propagate as link-only requirements; shared private links
stop at their owning shared target. Object DWARF checksums bind physical original,
generated and consumed SDK header bytes. Every raw archive member must equal its
compiled object. Independent linker traces and dependency files reconcile ordered
CRT, object, local library and language-specific runtime groups. Repeated native
GNU dependency entries and their phony rules retain order and multiplicity.
Additional consecutive `libgcc.a` symbol-resolution visits are bounded separately.

Linked binaries retain complete size/SHA-256 before-and-after witnesses, ELF
headers, dependency/soname/rpath/symbol observations and DWARF receipts; their raw
bytes are not retained in the packet. Raw object/archive bytes are retained.
Pinned CRT objects have separate native DWARF observations that account for
foreign upstream source metadata in the linked binaries. Their physical bytes
are pinned; those observations do not hash the unavailable upstream source.
Current receipt admission rechecks the complete physical project inventory and
policy, every ordered receipt/artifact role, generated before-and-after trees and
tool/SDK/binary identity. It establishes coherence under trusted execution, not
attestation against a forged receipt or an OS sandbox for project code.

CTest discovery, executable registration/backtraces, XML and console starts,
results and counters must agree with the declared nonempty callback cohort.
Counts describe executed CTest callbacks; assertion counts inside an executable
remain unknown. Failures cite the physical CMake registration and explicitly do
not identify the failing assertion. clang-format checks every declared original
source/header using native XML byte offsets without rewriting source. clang-tidy
runs every declared translation unit with the selected finite native rule/core
checker cohort and source-bound YAML diagnostics. Compiler errors retain partial
findings without becoming successful build evidence. Empty, skipped, stale,
cancelled, timed-out, malformed or truncated evidence cannot pass.

The [measurement](measurements/cpp-extensions-2026-10-10.json) records preserved source and installed callbacks, required extension callbacks and paired controls. Missing or changed selected SDK prerequisites remain unavailable before CMake evaluation; later SDK changes remain inconclusive. Native analyzer findings are tool observations and do not establish defect truth.

The native acceptance harness covers original regression/repair, public and
private transitive interfaces, pure-C and mixed C/C++ consumers, generated headers,
compiler/formatter/analyzer findings, current-source and physical-output guards,
CLI/MCP trust/privacy and reached descendant cancellation. A fresh offline
production installation runs the same required callbacks with its harness outside
the installed package. Paired guard controls change one compiled expression,
require assertion failure, restore the exact bytes and pass again while keeping
callbacks/fixtures unchanged. Native invocation controls separately require
successful compilation and both declared CTest callbacks to execute. Fresh native
processes do not establish independent AI host sessions.

CI separates preserved source/installed baselines, extension source/installed
acceptance and two guard shards. Wider CMake/toolchain/platform semantics, complete
artifact/license closure, the final runtime matrix and Gate A remain open. No
inference, held-out scoring or real-project field evaluation is invoked.
