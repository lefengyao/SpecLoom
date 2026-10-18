import { randomUUID } from "node:crypto";

/** A kernel Job Object keeps descendant ownership after a shell exits or a child reparents itself. */
const nativeJobHost = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace SpecLoom {
  public static class OwnedJob {
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFO {
      public uint cb; public string reserved; public string desktop; public string title;
      public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
      public ushort showWindow, reserved2; public IntPtr reservedBytes, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
      public long processTime, jobTime; public uint flags; public UIntPtr minWorkingSet, maxWorkingSet;
      public uint activeProcessLimit; public UIntPtr affinity; public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory; }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING { public long userTime, kernelTime, periodUserTime, periodKernelTime; public uint pageFaults, totalProcesses, activeProcesses, terminatedProcesses; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref EXTENDED_LIMIT info, uint length);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out ACCOUNTING info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processAttrs, IntPtr threadAttrs, bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    static string Quote(string text) {
      var value = new StringBuilder("\""); int slashes = 0;
      foreach (char c in text) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') value.Append('\\', slashes * 2 + 1).Append(c);
        else value.Append('\\', slashes).Append(c);
        slashes = 0;
      }
      return value.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static int Run(string executable, string[] args) {
      IntPtr job = CreateJobObject(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new Win32Exception();
      PROCESS_INFORMATION child = new PROCESS_INFORMATION(); bool assigned = false;
      try {
        var limits = new EXTENDED_LIMIT(); limits.basic.flags = 0x00002000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(EXTENDED_LIMIT)))) throw new Win32Exception();
        var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO)); startup.flags = 0x00000100;
        startup.stdin = GetStdHandle(-10); startup.stdout = GetStdHandle(-11); startup.stderr = GetStdHandle(-12);
        foreach (IntPtr handle in new[] {startup.stdin, startup.stdout, startup.stderr}) SetHandleInformation(handle, 1, 1);
        var command = new StringBuilder(Quote(executable));
        // cmd /s /c consumes a raw command tail, unlike the CRT argv used by native executables.
        // Keep that already-approved script intact; CRT escaping would turn its quotes into literal backslashes.
        bool cmd = String.Equals(System.IO.Path.GetFileName(executable), "cmd.exe", StringComparison.OrdinalIgnoreCase);
        for (int index = 0; index < args.Length; index++) {
          command.Append(' ');
          if (cmd && index > 0 && String.Equals(args[index - 1], "/c", StringComparison.OrdinalIgnoreCase) && index == args.Length - 1) command.Append('"').Append(args[index]).Append('"');
          else if (cmd && (String.Equals(args[index], "/d", StringComparison.OrdinalIgnoreCase) || String.Equals(args[index], "/s", StringComparison.OrdinalIgnoreCase) || String.Equals(args[index], "/c", StringComparison.OrdinalIgnoreCase))) command.Append(args[index]);
          else command.Append(Quote(args[index]));
        }
        // Suspend before assignment: the target cannot launch an escaping grandchild between spawn and job ownership.
        if (!CreateProcess(null, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, null, ref startup, out child)) throw new Win32Exception();
        if (!AssignProcessToJobObject(job, child.process)) throw new Win32Exception(); assigned = true;
        if (ResumeThread(child.thread) == 0xffffffff) throw new Win32Exception();
        CloseHandle(child.thread); child.thread = IntPtr.Zero;
        ACCOUNTING accounting;
        do {
          if (!QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) throw new Win32Exception();
          if (accounting.activeProcesses != 0) Thread.Sleep(50);
        } while (accounting.activeProcesses != 0);
        uint code; if (!GetExitCodeProcess(child.process, out code)) throw new Win32Exception(); return unchecked((int)code);
      } finally {
        if (!assigned && child.process != IntPtr.Zero) TerminateProcess(child.process, 1);
        if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
        if (child.process != IntPtr.Zero) CloseHandle(child.process);
        CloseHandle(job);
      }
    }
  }
}`;

const supervisorScript = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
$utf8 = New-Object System.Text.UTF8Encoding($false);
[Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8; $OutputEncoding = $utf8;
try {
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json;
$header = [string]$payload.outputMarker + [Text.Encoding]::Default.CodePage + [char]10;
[Console]::Out.Write($header); [Console]::Out.Flush(); [Console]::Error.Write($header); [Console]::Error.Flush();
Add-Type -TypeDefinition @'\n${nativeJobHost}\n'@;
$result = [SpecLoom.OwnedJob]::Run([string]$payload.executable, [string[]]$payload.args);
exit $result;
} catch {
  $cause = $_.Exception.GetBaseException();
  $nativeCode = if ($cause -is [ComponentModel.Win32Exception]) { ' [Win32 ' + $cause.NativeErrorCode + ']' } else { '' };
  [Console]::Error.WriteLine('SpecLoom 无法安全启动受管进程（Windows Job Object）' + $nativeCode + '：' + $_.Exception.Message); exit 1;
}`;

export function windowsOwnedJob(executable: string, args: string[]): { executable: string; args: string[]; input: string; outputMarker: string } {
  const outputMarker = `\u001eSpecLoom:${randomUUID()}:`;
  return { executable: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(supervisorScript, "utf16le").toString("base64")], input: JSON.stringify({ executable, args, outputMarker }), outputMarker };
}
