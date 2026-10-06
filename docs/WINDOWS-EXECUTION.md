# Bounded Windows execution

The shared trusted runner has an experimental `windows-job-v1` profile for direct
local-drive `.exe` commands. A dedicated `windows-2025` x64 / Node 22.23.2 CI job
requires original argument, environment, descendant, cancellation, parent-loss,
guardian-crash, timeout, output and shared CLI/MCP controls. It repeats them in an
offline production installation with lifecycle scripts disabled. Native Windows
acceptance is pending until that job passes; macOS/Linux contract tests cannot
establish Windows behavior. Gate A remains open.

Operator execution trust is unchanged. Discovery and planning never invoke the
helper. Executed project code has the operator's privileges and is not sandboxed.
The process report explicitly records `executionSandboxed: false`.

## Launch and ownership

The runner resolves a canonical local-drive executable. Bare names use absolute
PATH entries only; ambiguous distinct matches fail before startup. Paths with
spaces and extensionless executable selections are supported. Drive-relative,
UNC/device paths and `.cmd`, `.bat` and other script wrappers are unavailable in
this profile. Wrapper and wider tool profiles remain required separately.

A fixed engine PowerShell bootstrap first assigns itself to an outer kill-on-close
job through fixed Reflection.Emit P/Invoke signatures. This owns compiler children
before the framework CodeDom compiler can launch them. It decodes compressed
engine-owned C# source and compiles it in owned temporary storage with fixed
framework references. Bounded JSON decoding and compilation use framework APIs
without bootstrap cmdlet/module auto-loading. Native Windows acceptance remains
required for this experimental profile.
Project commands, arguments, working directory and environment arrive as JSON
data in an exclusively created, bounded engine request file. A separate private
Windows named pipe carries a fixed stop byte or parent-disconnection EOF, read by
an engine-owned background thread; PowerShell stdin is
ignored so its pipeline reader cannot consume engine control data. The command
line carries a compressed fixed engine bootstrap; project data never enters its
script block. The receipt digest binds that actual launcher. The bootstrap uses the host SystemRoot's Windows
PowerShell executable, never PATH or a project shell command. It does not change
execution policy. Command data is quoted according to the documented Windows CRT
argument rules and bounded before startup. Runtime-specific argument parsers
outside that contract need their own acceptance profile.

The supervisor creates the suspended process with `PROC_THREAD_ATTRIBUTE_JOB_LIST`
and confirms membership before resuming it. The non-inherited Job Object has
kill-on-close, a bounded process count and no breakaway permission. Only duplicated
stdout/stderr and a NUL stdin handle are explicitly inherited. Descendant cleanup
uses the owned job and retained process handles, without PID scanning or taskkill.
The creation attribute requires Windows 10 / Server 2016 or later; only the named
CI profile is targeted for acceptance here. See the Microsoft documentation for
[creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute),
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
and [argument parsing](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments?view=msvc-170).

Cancellation, timeout and output exhaustion send one fixed stop byte while the
living parent retains the receipt directory. Parent loss closes the private pipe;
the guardian reads EOF, terminates the owned job and removes its owned directory. The guardian is detached from libuv's parent-exit job so it can perform that cleanup; its own native jobs continue to own the compiler and project children. Normal root exit also removes remaining
background descendants. Guardian death invokes kernel kill-on-close; it cannot
produce a completed receipt and is reported incomplete. Native controls include
multiple detached descendants and an unrelated sibling.

## Environment, evidence and limits

Inherited environment names are matched case-insensitively against the fixed
PATH/HOME/TMPDIR/TMP/TEMP/LANG/LC_ALL/SYSTEMROOT set. Undeclared values are omitted.
Case-colliding names, invalid/NUL values and excessive names/values fail. Operator
and command overlays remain explicit, and cannot replace SystemRoot. Temporary
compiler/helper files and optional command directories are owned by one unique
engine directory. Its marker binds parent-loss cleanup to the exact request.

A size-bounded regular receipt binds the request ID and actual supervisor PID.
It records assignment, resume, root exit and job active counts before and after
cleanup, plus the engine bootstrap digest. Only a completed confirmed zero-active
receipt can yield normal execution evidence. Missing, malformed, mismatched,
unfinished or unavailable cleanup stays an error. This is engine observation for
trusted execution, not an attestation against malicious project code. JSON schema
validation alone does not establish native truth.

Raw stdout/stderr byte accounting shares one retention limit. Truncation,
pre-start cancellation, timeout and cleanup failure cannot become passing checks.
Windows signals stay null; native exit codes are retained without inventing POSIX
signals. Temporary cleanup failures are reported rather than silently accepted.

This does not promote Windows Git selection, private journals/task storage,
framework tooling, all native adapters, arbitrary wrappers or all Node versions.
Static diagnosis reports limited platform support. Their E4/E5 requirements and
POSIX process controls remain separate and unchanged.
