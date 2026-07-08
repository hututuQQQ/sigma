param(
  [string]$Request,
  [switch]$Probe
)

$ErrorActionPreference = "Stop"

$source = @"
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace Sigma.WindowsSandbox {
  public static class NativeRunner {
    const UInt32 TOKEN_DUPLICATE = 0x0002;
    const UInt32 TOKEN_ASSIGN_PRIMARY = 0x0001;
    const UInt32 TOKEN_QUERY = 0x0008;
    const UInt32 TOKEN_ADJUST_PRIVILEGES = 0x0020;
    const UInt32 TOKEN_ADJUST_DEFAULT = 0x0080;
    const UInt32 TOKEN_ADJUST_SESSIONID = 0x0100;
    const UInt32 DISABLE_MAX_PRIVILEGE = 0x1;
    const UInt32 LUA_TOKEN = 0x4;
    const UInt32 WRITE_RESTRICTED = 0x8;
    const UInt32 STARTF_USESTDHANDLES = 0x00000100;
    const UInt32 CREATE_NO_WINDOW = 0x08000000;
    const UInt32 INFINITE = 0xffffffff;
    const UInt32 GENERIC_ALL = 0x10000000;
    const UInt32 ERROR_SUCCESS = 0;
    const UInt32 GRANT_ACCESS = 1;
    const UInt32 SE_PRIVILEGE_ENABLED = 0x00000002;
    const UInt32 SE_GROUP_LOGON_ID = 0xC0000000;
    const Int32 STD_INPUT_HANDLE = -10;
    const Int32 STD_OUTPUT_HANDLE = -11;
    const Int32 STD_ERROR_HANDLE = -12;
    const Int32 TokenGroups = 2;
    const Int32 TokenDefaultDacl = 6;
    const Int32 TRUSTEE_IS_SID = 0;
    const Int32 TRUSTEE_IS_UNKNOWN = 0;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES {
      public IntPtr Sid;
      public UInt32 Attributes;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
      public UInt32 cb;
      public string lpReserved;
      public string lpDesktop;
      public string lpTitle;
      public UInt32 dwX;
      public UInt32 dwY;
      public UInt32 dwXSize;
      public UInt32 dwYSize;
      public UInt32 dwXCountChars;
      public UInt32 dwYCountChars;
      public UInt32 dwFillAttribute;
      public UInt32 dwFlags;
      public UInt16 wShowWindow;
      public UInt16 cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public UInt32 dwProcessId;
      public UInt32 dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LUID {
      public UInt32 LowPart;
      public Int32 HighPart;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct LUID_AND_ATTRIBUTES {
      public LUID Luid;
      public UInt32 Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_PRIVILEGES_ONE {
      public UInt32 PrivilegeCount;
      public LUID_AND_ATTRIBUTES Privilege;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TRUSTEE {
      public IntPtr pMultipleTrustee;
      public Int32 MultipleTrusteeOperation;
      public Int32 TrusteeForm;
      public Int32 TrusteeType;
      public IntPtr ptstrName;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EXPLICIT_ACCESS {
      public UInt32 grfAccessPermissions;
      public UInt32 grfAccessMode;
      public UInt32 grfInheritance;
      public TRUSTEE Trustee;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_DEFAULT_DACL {
      public IntPtr DefaultDacl;
    }

    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GetStdHandle(Int32 nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern UInt32 WaitForSingleObject(IntPtr hHandle, UInt32 dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr hProcess, out UInt32 lpExitCode);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr ProcessHandle, UInt32 DesiredAccess, out IntPtr TokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(
      IntPtr TokenHandle,
      Int32 TokenInformationClass,
      IntPtr TokenInformation,
      Int32 TokenInformationLength,
      out Int32 ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(
      IntPtr ExistingTokenHandle,
      UInt32 Flags,
      UInt32 DisableSidCount,
      IntPtr SidsToDisable,
      UInt32 DeletePrivilegeCount,
      IntPtr PrivilegesToDelete,
      UInt32 RestrictedSidCount,
      SID_AND_ATTRIBUTES[] SidsToRestrict,
      out IntPtr NewTokenHandle);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool LookupPrivilegeValue(string lpSystemName, string lpName, out LUID lpLuid);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool AdjustTokenPrivileges(
      IntPtr TokenHandle,
      bool DisableAllPrivileges,
      ref TOKEN_PRIVILEGES_ONE NewState,
      UInt32 BufferLength,
      IntPtr PreviousState,
      IntPtr ReturnLength);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "SetEntriesInAclW")]
    static extern UInt32 SetEntriesInAcl(
      UInt32 cCountOfExplicitEntries,
      EXPLICIT_ACCESS[] pListOfExplicitEntries,
      IntPtr OldAcl,
      out IntPtr NewAcl);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetTokenInformation(
      IntPtr TokenHandle,
      Int32 TokenInformationClass,
      ref TOKEN_DEFAULT_DACL TokenInformation,
      UInt32 TokenInformationLength);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(
      IntPtr hToken,
      string lpApplicationName,
      StringBuilder lpCommandLine,
      IntPtr lpProcessAttributes,
      IntPtr lpThreadAttributes,
      bool bInheritHandles,
      UInt32 dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFO lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessWithTokenW(
      IntPtr hToken,
      UInt32 dwLogonFlags,
      string lpApplicationName,
      StringBuilder lpCommandLine,
      UInt32 dwCreationFlags,
      IntPtr lpEnvironment,
      string lpCurrentDirectory,
      ref STARTUPINFO lpStartupInfo,
      out PROCESS_INFORMATION lpProcessInformation);

    public static int Probe() {
      SecurityIdentifier sid = new SecurityIdentifier("S-1-5-21-1111111111-2222222222-3333333333-4444");
      IntPtr ptr = SidToPtr(sid);
      IntPtr logonPtr = SidToPtr(GetLogonSid());
      IntPtr everyonePtr = SidToPtr(new SecurityIdentifier(WellKnownSidType.WorldSid, null));
      try {
        IntPtr token = CreateRestrictedWriteToken(new [] { ptr, logonPtr, everyonePtr });
        CloseHandle(token);
        return 0;
      } finally {
        Marshal.FreeHGlobal(ptr);
        Marshal.FreeHGlobal(logonPtr);
        Marshal.FreeHGlobal(everyonePtr);
      }
    }

    public static int Run(string program, string[] args, string commandLine, string cwd, string capabilitySid, string[] writeRoots, string[] denyWrite) {
      if (String.IsNullOrWhiteSpace(program)) throw new ArgumentException("missing program");
      if (String.IsNullOrWhiteSpace(cwd)) cwd = Directory.GetCurrentDirectory();
      SecurityIdentifier cap = new SecurityIdentifier(capabilitySid);

      foreach (string root in writeRoots ?? new string[0]) {
        if (!String.IsNullOrWhiteSpace(root) && Directory.Exists(root)) AddRule(root, cap, AccessControlType.Allow, true);
        else if (!String.IsNullOrWhiteSpace(root) && File.Exists(root)) AddRule(root, cap, AccessControlType.Allow, false);
      }
      foreach (string target in denyWrite ?? new string[0]) {
        if (!String.IsNullOrWhiteSpace(target) && Directory.Exists(target)) AddRule(target, cap, AccessControlType.Deny, true);
        else if (!String.IsNullOrWhiteSpace(target) && File.Exists(target)) AddRule(target, cap, AccessControlType.Deny, false);
      }

      IntPtr sidPtr = SidToPtr(cap);
      IntPtr logonPtr = SidToPtr(GetLogonSid());
      IntPtr everyonePtr = SidToPtr(new SecurityIdentifier(WellKnownSidType.WorldSid, null));
      IntPtr restricted = IntPtr.Zero;
      try {
        restricted = CreateRestrictedWriteToken(new [] { sidPtr, logonPtr, everyonePtr });
        return SpawnAndWait(restricted, program, args ?? new string[0], commandLine, cwd);
      } finally {
        if (restricted != IntPtr.Zero) CloseHandle(restricted);
        Marshal.FreeHGlobal(sidPtr);
        Marshal.FreeHGlobal(logonPtr);
        Marshal.FreeHGlobal(everyonePtr);
      }
    }

    static IntPtr CreateRestrictedWriteToken(IntPtr[] restrictingSids) {
      IntPtr baseToken;
      UInt32 access = TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID | TOKEN_ADJUST_PRIVILEGES;
      if (!OpenProcessToken(GetCurrentProcess(), access, out baseToken)) ThrowLast("OpenProcessToken");
      try {
        SID_AND_ATTRIBUTES[] entries = new SID_AND_ATTRIBUTES[restrictingSids.Length];
        for (int i = 0; i < restrictingSids.Length; i++) {
          entries[i].Sid = restrictingSids[i];
          entries[i].Attributes = 0;
        }
        IntPtr restricted;
        if (!CreateRestrictedToken(baseToken, DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED, 0, IntPtr.Zero, 0, IntPtr.Zero, (UInt32)entries.Length, entries, out restricted)) {
          ThrowLast("CreateRestrictedToken");
        }
        SetDefaultDacl(restricted, restrictingSids);
        EnableSinglePrivilege(restricted, "SeChangeNotifyPrivilege");
        return restricted;
      } finally {
        CloseHandle(baseToken);
      }
    }

    static void SetDefaultDacl(IntPtr token, IntPtr[] sids) {
      EXPLICIT_ACCESS[] entries = new EXPLICIT_ACCESS[sids.Length];
      for (int i = 0; i < sids.Length; i++) {
        entries[i].grfAccessPermissions = GENERIC_ALL;
        entries[i].grfAccessMode = GRANT_ACCESS;
        entries[i].grfInheritance = 0;
        entries[i].Trustee = new TRUSTEE();
        entries[i].Trustee.pMultipleTrustee = IntPtr.Zero;
        entries[i].Trustee.MultipleTrusteeOperation = 0;
        entries[i].Trustee.TrusteeForm = TRUSTEE_IS_SID;
        entries[i].Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        entries[i].Trustee.ptstrName = sids[i];
      }
      IntPtr acl;
      UInt32 result = SetEntriesInAcl((UInt32)entries.Length, entries, IntPtr.Zero, out acl);
      if (result != ERROR_SUCCESS) throw new InvalidOperationException("SetEntriesInAcl failed: " + result.ToString());
      try {
        TOKEN_DEFAULT_DACL info = new TOKEN_DEFAULT_DACL();
        info.DefaultDacl = acl;
        if (!SetTokenInformation(token, TokenDefaultDacl, ref info, (UInt32)Marshal.SizeOf(typeof(TOKEN_DEFAULT_DACL)))) {
          ThrowLast("SetTokenInformation(TokenDefaultDacl)");
        }
      } finally {
        if (acl != IntPtr.Zero) LocalFree(acl);
      }
    }

    static void EnableSinglePrivilege(IntPtr token, string name) {
      LUID luid;
      if (!LookupPrivilegeValue(null, name, out luid)) ThrowLast("LookupPrivilegeValue");
      TOKEN_PRIVILEGES_ONE privileges = new TOKEN_PRIVILEGES_ONE();
      privileges.PrivilegeCount = 1;
      privileges.Privilege = new LUID_AND_ATTRIBUTES();
      privileges.Privilege.Luid = luid;
      privileges.Privilege.Attributes = SE_PRIVILEGE_ENABLED;
      if (!AdjustTokenPrivileges(token, false, ref privileges, 0, IntPtr.Zero, IntPtr.Zero)) ThrowLast("AdjustTokenPrivileges");
    }

    static SecurityIdentifier GetLogonSid() {
      IntPtr token;
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) ThrowLast("OpenProcessToken(TokenGroups)");
      try {
        Int32 needed = 0;
        GetTokenInformation(token, TokenGroups, IntPtr.Zero, 0, out needed);
        if (needed <= 0) ThrowLast("GetTokenInformation(TokenGroups size)");
        IntPtr buffer = Marshal.AllocHGlobal(needed);
        try {
          if (!GetTokenInformation(token, TokenGroups, buffer, needed, out needed)) ThrowLast("GetTokenInformation(TokenGroups)");
          Int32 groupCount = Marshal.ReadInt32(buffer);
          IntPtr entry = IntPtr.Add(buffer, IntPtr.Size);
          Int32 entrySize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
          for (Int32 i = 0; i < groupCount; i++) {
            SID_AND_ATTRIBUTES item = (SID_AND_ATTRIBUTES)Marshal.PtrToStructure(IntPtr.Add(entry, i * entrySize), typeof(SID_AND_ATTRIBUTES));
            if ((item.Attributes & SE_GROUP_LOGON_ID) == SE_GROUP_LOGON_ID) {
              return new SecurityIdentifier(item.Sid);
            }
          }
        } finally {
          Marshal.FreeHGlobal(buffer);
        }
      } finally {
        CloseHandle(token);
      }
      throw new InvalidOperationException("Current token does not include a logon SID.");
    }

    static int SpawnAndWait(IntPtr token, string program, string[] args, string commandLine, string cwd) {
      STARTUPINFO si = new STARTUPINFO();
      si.cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO));
      si.lpDesktop = "winsta0\\default";
      si.dwFlags = STARTF_USESTDHANDLES;
      si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
      si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
      si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
      PROCESS_INFORMATION pi;
      StringBuilder cmdline = new StringBuilder(String.IsNullOrWhiteSpace(commandLine) ? BuildCommandLine(program, args) : commandLine);
      bool ok = CreateProcessAsUser(token, null, cmdline, IntPtr.Zero, IntPtr.Zero, true, CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi);
      if (!ok) {
        cmdline = new StringBuilder(String.IsNullOrWhiteSpace(commandLine) ? BuildCommandLine(program, args) : commandLine);
        ok = CreateProcessWithTokenW(token, 0, null, cmdline, CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi);
      }
      if (!ok) ThrowLast("CreateProcessAsUser/CreateProcessWithTokenW");
      try {
        WaitForSingleObject(pi.hProcess, INFINITE);
        UInt32 exitCode;
        if (!GetExitCodeProcess(pi.hProcess, out exitCode)) ThrowLast("GetExitCodeProcess");
        return unchecked((int)exitCode);
      } finally {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
      }
    }

    static void AddRule(string path, SecurityIdentifier sid, AccessControlType type, bool directory) {
      FileSystemRights rights = FileSystemRights.Modify | FileSystemRights.Synchronize;
      if (directory) {
        DirectoryInfo info = new DirectoryInfo(path);
        DirectorySecurity security = info.GetAccessControl();
        FileSystemAccessRule rule = new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, type);
        security.SetAccessRule(rule);
        info.SetAccessControl(security);
      } else {
        FileInfo info = new FileInfo(path);
        FileSecurity security = info.GetAccessControl();
        FileSystemAccessRule rule = new FileSystemAccessRule(sid, rights, AccessControlType.Allow);
        if (type == AccessControlType.Deny) rule = new FileSystemAccessRule(sid, rights, AccessControlType.Deny);
        security.SetAccessRule(rule);
        info.SetAccessControl(security);
      }
    }

    static IntPtr SidToPtr(SecurityIdentifier sid) {
      byte[] bytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(bytes, 0);
      IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
      Marshal.Copy(bytes, 0, ptr, bytes.Length);
      return ptr;
    }

    static string BuildCommandLine(string program, string[] args) {
      StringBuilder builder = new StringBuilder();
      AppendQuoted(builder, program);
      foreach (string arg in args) {
        builder.Append(' ');
        AppendQuoted(builder, arg ?? "");
      }
      return builder.ToString();
    }

    static void AppendQuoted(StringBuilder builder, string value) {
      builder.Append('"');
      int slashCount = 0;
      foreach (char ch in value) {
        if (ch == '\\') {
          slashCount++;
          continue;
        }
        if (ch == '"') {
          builder.Append('\\', slashCount * 2 + 1);
          builder.Append('"');
          slashCount = 0;
          continue;
        }
        builder.Append('\\', slashCount);
        slashCount = 0;
        builder.Append(ch);
      }
      builder.Append('\\', slashCount * 2);
      builder.Append('"');
    }

    static void ThrowLast(string operation) {
      int error = Marshal.GetLastWin32Error();
      System.ComponentModel.Win32Exception ex = new System.ComponentModel.Win32Exception(error);
      throw new System.ComponentModel.Win32Exception(error, operation + " failed: " + ex.Message + " (" + error.ToString() + ")");
    }
  }
}
"@

Add-Type -TypeDefinition $source

if ($Probe) {
  exit [Sigma.WindowsSandbox.NativeRunner]::Probe()
}

if (-not $Request) {
  throw "Missing -Request"
}

$jsonText = [System.IO.File]::ReadAllText($Request, [System.Text.Encoding]::UTF8)
$json = $jsonText | ConvertFrom-Json
Remove-Item -LiteralPath $Request -Force -ErrorAction SilentlyContinue

function ToStringArray($value) {
  if ($null -eq $value) { return [string[]]@() }
  return [string[]]@($value)
}

exit [Sigma.WindowsSandbox.NativeRunner]::Run(
  [string]$json.program,
  (ToStringArray $json.args),
  [string]$json.commandLine,
  [string]$json.cwd,
  [string]$json.capabilitySid,
  (ToStringArray $json.writeRoots),
  (ToStringArray $json.denyWrite)
)
