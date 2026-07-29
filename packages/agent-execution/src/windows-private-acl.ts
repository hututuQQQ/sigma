import { execFile } from "node:child_process";

const PRIVATE_ACL_SCRIPT = `
$ErrorActionPreference = "Stop"
$target = [Environment]::GetEnvironmentVariable("SIGMA_PRIVATE_ACL_TARGET", "Process")
$userSidText = [Environment]::GetEnvironmentVariable("SIGMA_PRIVATE_ACL_USER_SID", "Process")
$isDirectory = [Environment]::GetEnvironmentVariable("SIGMA_PRIVATE_ACL_DIRECTORY", "Process") -eq "1"
if ([string]::IsNullOrWhiteSpace($target) -or [string]::IsNullOrWhiteSpace($userSidText)) {
  throw "Missing private ACL input."
}

$userSid = [System.Security.Principal.SecurityIdentifier]::new($userSidText)
$systemSid = [System.Security.Principal.SecurityIdentifier]::new("S-1-5-18")
$expectedInheritance = if ($isDirectory) {
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
function Test-PrivateAcl($candidate) {
  if (-not $candidate.AreAccessRulesProtected) {
    return $false
  }
  $allowedSids = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  [void]$allowedSids.Add($userSid.Value)
  [void]$allowedSids.Add($systemSid.Value)
  $seenSids = [System.Collections.Generic.HashSet[string]]::new(
    [System.StringComparer]::OrdinalIgnoreCase
  )
  foreach ($rule in @($candidate.Access)) {
    try {
      $resolvedSid = $rule.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } catch {
      return $false
    }
    if (-not $allowedSids.Contains($resolvedSid) -or
        $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        $rule.InheritanceFlags -ne $expectedInheritance) {
      return $false
    }
    [void]$seenSids.Add($resolvedSid)
  }
  return $seenSids.Contains($userSid.Value) -and $seenSids.Contains($systemSid.Value)
}

$acl = Get-Acl -LiteralPath $target
if (Test-PrivateAcl $acl) {
  exit 0
}
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
  [void]$acl.RemoveAccessRuleSpecific($rule)
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$rights = [System.Security.AccessControl.FileSystemRights]::FullControl
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
  $userSid, $rights, $expectedInheritance, $propagation, $allow
))
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
  $systemSid, $rights, $expectedInheritance, $propagation, $allow
))
Set-Acl -LiteralPath $target -AclObject $acl

$verified = Get-Acl -LiteralPath $target
if (-not (Test-PrivateAcl $verified)) {
  throw "Private ACL verification failed."
}
`;

function currentWindowsUserSid(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1_024
    }, (error, stdout) => {
      if (error) {
        reject(new Error("Windows identity lookup failed.", { cause: error }));
        return;
      }
      const sid = /"(S-[0-9-]+)"\s*$/u.exec(stdout.trim())?.[1];
      if (!sid) {
        reject(new Error("Could not resolve the current Windows user SID."));
        return;
      }
      resolve(sid);
    });
  });
}

/**
 * Restricts a product-owned file or directory to the current Windows user and
 * LocalSystem. Callers must pass an already resolved, product-owned path.
 */
export async function restrictWindowsPathToCurrentUser(
  target: string,
  options: { directory: boolean }
): Promise<void> {
  if (process.platform !== "win32") return;
  const sid = await currentWindowsUserSid();
  await new Promise<void>((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(PRIVATE_ACL_SCRIPT, "utf16le").toString("base64")
    ], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 64 * 1_024,
      env: {
        ...process.env,
        SIGMA_PRIVATE_ACL_TARGET: target,
        SIGMA_PRIVATE_ACL_USER_SID: sid,
        SIGMA_PRIVATE_ACL_DIRECTORY: options.directory ? "1" : "0"
      }
    }, (error) => {
      if (error) {
        reject(new Error("Windows ACL hardening failed.", { cause: error }));
        return;
      }
      resolve();
    });
  });
}
