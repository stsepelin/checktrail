import { gzipSync } from "node:zlib";

/** Engine-owned Windows supervisor. Project inputs arrive in an owned JSON data file; control uses a private pipe. */
export const windowsNativeCode = String.raw`
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class ChecktrailWindowsJobV1 {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr Minimum, Maximum; public uint Processes;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel;
    public uint Faults, Total, Active, Terminated;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, CharsX, CharsY, Fill, Flags;
    public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Basic; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread; public uint Id, ThreadId;
  }
  [StructLayout(LayoutKind.Sequential)] struct Security {
    public uint Size; public IntPtr Descriptor; public int Inherit;
  }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
    IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern bool CreateProcessW(string executable, StringBuilder command, IntPtr processSecurity,
    IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd,
    ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr source,
    IntPtr into, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(
    string name, uint access, uint sharing, ref Security security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool PeekNamedPipe(IntPtr pipe,
    IntPtr buffer, uint size, IntPtr read, IntPtr available, IntPtr remaining);
  static bool ParentClosed(NamedPipeClientStream control) {
    if (PeekNamedPipe(control.SafePipeHandle.DangerousGetHandle(), IntPtr.Zero, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero)) return false;
    int error = Marshal.GetLastWin32Error();
    if (error == 109 || error == 233) return true;
    throw new Win32Exception(error);
  }
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static uint Active(IntPtr job) {
    Accounting info; Check(QueryInformationJobObject(job, 1, out info, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
    return info.Active;
  }
  static IntPtr Inherited(int kind) {
    IntPtr result; var current = GetCurrentProcess();
    Check(DuplicateHandle(current, GetStdHandle(kind), current, out result, 0, true, 2)); return result;
  }
  static void Receipt(string file, string request, string phase, uint? child, bool assigned, bool resumed,
    uint? exit, uint? before, uint? after, string cleanup, int? error) {
    string contents = "{\"profile\":\"windows-job-v1\",\"requestId\":\"" + request +
      "\",\"phase\":\"" + phase + "\",\"supervisorPid\":" + System.Diagnostics.Process.GetCurrentProcess().Id +
      ",\"childPid\":" + (child.HasValue ? child.Value.ToString() : "null") +
      ",\"jobAssigned\":" + (assigned ? "true" : "false") + ",\"resumed\":" + (resumed ? "true" : "false") +
      ",\"childExitCode\":" + (exit.HasValue ? exit.Value.ToString() : "null") +
      ",\"activeBeforeCleanup\":" + (before.HasValue ? before.Value.ToString() : "null") +
      ",\"activeAfterCleanup\":" + (after.HasValue ? after.Value.ToString() : "null") +
      ",\"cleanup\":\"" + cleanup + "\",\"nativeError\":" + (error.HasValue ? error.Value.ToString() : "null") + "}";
    string temporary = file + ".new";
    File.WriteAllText(temporary, contents, new UTF8Encoding(false));
    if (File.Exists(file)) File.Replace(temporary, file, null); else File.Move(temporary, file);
  }
  public static int Run(string executable, string command, string[] environment, string cwd, string receipt, string request, string controlPipe) {
    Guid id; if (!Guid.TryParse(request, out id)) return 253;
    string owned = Path.GetDirectoryName(receipt);
    if (!String.Equals(owned, Environment.CurrentDirectory, StringComparison.OrdinalIgnoreCase) ||
      !Path.GetFileName(owned).StartsWith("checktrail-windows-", StringComparison.Ordinal) ||
      File.ReadAllText(Path.Combine(owned, "owner-id")) != request) return 253;
    IntPtr job = IntPtr.Zero, block = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, input = IntPtr.Zero;
    IntPtr attributes = IntPtr.Zero, jobs = IntPtr.Zero, handles = IntPtr.Zero; bool initialized = false;
    ProcessInfo process = new ProcessInfo(); bool assigned = false, resumed = false, completed = false;
    uint? child = null, code = null, before = null, after = null;
    NamedPipeClientStream control = null; bool parentClosed = false;
    try {
      if (controlPipe != "checktrail-" + request) throw new Win32Exception(87);
      control = new NamedPipeClientStream(".", controlPipe, PipeDirection.In); control.Connect(2000);
      if (parentClosed = ParentClosed(control)) { Receipt(receipt, request, "completed", null, false, false, null, null, 0, "not-started", null); return 0; }
      job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
      ExtendedLimit limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000 | 0x8; limits.Basic.Processes = 256;
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
      output = Inherited(-11); error = Inherited(-12);
      Security security = new Security(); security.Size = (uint)Marshal.SizeOf(typeof(Security)); security.Inherit = 1;
      input = CreateFileW("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
      if (input == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      if (size == IntPtr.Zero || size.ToInt64() > 65536) throw new Win32Exception(87);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref size)); initialized = true;
      jobs = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobs, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobs, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
      Marshal.WriteIntPtr(handles, 0, input); Marshal.WriteIntPtr(handles, IntPtr.Size, output); Marshal.WriteIntPtr(handles, 2 * IntPtr.Size, error);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(3 * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      StartupEx startup = new StartupEx(); startup.Basic.Size = (uint)Marshal.SizeOf(typeof(StartupEx)); startup.Attributes = attributes;
      startup.Basic.Flags = 0x100; startup.Basic.Input = input; startup.Basic.Output = output; startup.Basic.Error = error;
      block = Marshal.StringToHGlobalUni(String.Join("\0", environment) + "\0\0");
      Check(CreateProcessW(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true,
        0x4 | 0x400 | 0x80000, block, cwd, ref startup, out process)); child = process.Id;
      bool member; Check(IsProcessInJob(process.Process, job, out member));
      if (!member) throw new Win32Exception(87); assigned = true;
      Receipt(receipt, request, "assigned", child, assigned, false, null, null, null, "unavailable", null);
      // Prove both creation and replacement of the receipt before source resumes.
      Receipt(receipt, request, "assigned", child, assigned, false, null, null, null, "unavailable", null);
      if (!(parentClosed = ParentClosed(control))) {
        if (ResumeThread(process.Thread) == 0xffffffff) throw new Win32Exception(Marshal.GetLastWin32Error());
        resumed = true;
        Receipt(receipt, request, "running", child, assigned, resumed, null, null, null, "unavailable", null);
        while (!(parentClosed = ParentClosed(control))) {
          uint status = WaitForSingleObject(process.Process, 25);
          if (status == 0) { uint exit; Check(GetExitCodeProcess(process.Process, out exit)); code = exit; break; }
          if (status != 258) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
      }
      before = Active(job); Check(TerminateJobObject(job, 1));
      var deadline = DateTime.UtcNow.AddSeconds(2);
      do { after = Active(job); if (after == 0) break; Thread.Sleep(10); } while (DateTime.UtcNow < deadline);
      if (after != 0) throw new Win32Exception(1460);
      completed = true;
      Receipt(receipt, request, "completed", child, assigned, resumed, code, before, after, "confirmed", null);
      return code.HasValue ? unchecked((int)code.Value) : 0;
    } catch (Win32Exception failure) {
      if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      if (job != IntPtr.Zero) TerminateJobObject(job, 1);
      Receipt(receipt, request, "failed", child, assigned, resumed, code, before, after, "unavailable", failure.NativeErrorCode); return 253;
    } catch {
      if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      if (job != IntPtr.Zero) TerminateJobObject(job, 1);
      Receipt(receipt, request, "failed", child, assigned, resumed, code, before, after, "unavailable", 1); return 253;
    } finally {
      if (!completed && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (block != IntPtr.Zero) Marshal.FreeHGlobal(block);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobs != IntPtr.Zero) Marshal.FreeHGlobal(jobs); if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (output != IntPtr.Zero) CloseHandle(output); if (error != IntPtr.Zero) CloseHandle(error);
      if (input != IntPtr.Zero && input != new IntPtr(-1)) CloseHandle(input);
      if (control != null) control.Dispose();
      if (parentClosed) {
        try {
          if (File.ReadAllText(Path.Combine(owned, "owner-id")) == request) {
            Environment.CurrentDirectory = Path.GetPathRoot(owned); Directory.Delete(owned, true);
          }
        } catch { /* An absent parent cannot receive a cleanup failure; native acceptance checks the directory. */ }
      }
    }
  }
}
`;
// Compress only fixed engine source; project arguments remain JSON data.
export const windowsCompressedNative = gzipSync(
  Buffer.from(windowsNativeCode, "utf8"),
).toString("base64");
export const windowsSupervisorScript = `
$ErrorActionPreference = 'Stop'
# Own the bootstrap/compiler children before Add-Type may start csc.exe.
# Reflection.Emit defines only fixed P/Invoke signatures and does not compile source.
if ([IntPtr]::Size -ne 8) { throw 'WINDOWS_X64_PROFILE_REQUIRED' }
$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('ChecktrailBootstrapJob'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
$module = $assembly.DefineDynamicModule('Native')
$type = $module.DefineType('ChecktrailBootstrapJob', [Reflection.TypeAttributes]::Public)
$definitions = @(
  @('CreateJobObjectW',[IntPtr],[Type[]]@([IntPtr],[string])),
  @('GetCurrentProcess',[IntPtr],[Type[]]@()),
  @('SetInformationJobObject',[bool],[Type[]]@([IntPtr],[int],[IntPtr],[uint32])),
  @('AssignProcessToJobObject',[bool],[Type[]]@([IntPtr],[IntPtr]))
)
foreach ($definition in $definitions) {
  $method = $type.DefinePInvokeMethod($definition[0], 'kernel32.dll', [Reflection.MethodAttributes] 'Public,Static,PinvokeImpl', [Reflection.CallingConventions]::Standard, $definition[1], $definition[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
  $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
}
$api = $type.CreateType()
$outerJob = $api::CreateJobObjectW([IntPtr]::Zero,$null)
if ($outerJob -eq [IntPtr]::Zero) { throw 'WINDOWS_BOOTSTRAP_JOB_UNAVAILABLE' }
$limits = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
try {
  [Runtime.InteropServices.Marshal]::Copy([byte[]]::new(144),0,$limits,144)
  [Runtime.InteropServices.Marshal]::WriteInt32($limits,16,0x2000)
  if (-not $api::SetInformationJobObject($outerJob,9,$limits,144)) { throw 'WINDOWS_BOOTSTRAP_LIMIT_UNAVAILABLE' }
  if (-not $api::AssignProcessToJobObject($outerJob,$api::GetCurrentProcess())) { throw 'WINDOWS_BOOTSTRAP_OWNERSHIP_UNAVAILABLE' }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($limits) }
# Keep this non-inherited handle until process exit, including early/failed preparation.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$line = [IO.File]::ReadAllText([IO.Path]::Combine([Environment]::CurrentDirectory, 'request.json'), [Text.Encoding]::UTF8)
if ($null -eq $line -or $line.Length -gt 1048576) { exit 253 }
$request = ConvertFrom-Json -InputObject $line
$buffer = [Convert]::FromBase64String('${windowsCompressedNative}')
$stream = [IO.MemoryStream]::new($buffer)
$gzip = [IO.Compression.GZipStream]::new($stream, [IO.Compression.CompressionMode]::Decompress)
$reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
try { $source = $reader.ReadToEnd() } finally { $reader.Dispose(); $gzip.Dispose(); $stream.Dispose() }
Add-Type -TypeDefinition $source
$result = [ChecktrailWindowsJobV1]::Run([string]$request.executable, [string]$request.commandLine,
  [string[]]@($request.environment), [string]$request.cwd, [string]$request.receipt, [string]$request.requestId, [string]$request.controlPipe)
[Environment]::Exit($result)
`.replace(/^#.*\n/gm, "");
