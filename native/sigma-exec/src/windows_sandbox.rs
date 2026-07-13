use crate::platform::PlatformGuard;
use crate::protocol::RpcError;
use crate::sandbox::{NetworkMode, PreparedCommand, ProcessParams, SandboxMode, minimal_roots};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::{OsStr, c_void};
use std::io::Write;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::MetadataExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, ERROR_FILE_NOT_FOUND, ERROR_INVALID_PARAMETER,
    ERROR_LOCK_VIOLATION, ERROR_PATH_NOT_FOUND, FILETIME, GetLastError, HANDLE,
    HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, LocalFree, WAIT_ABANDONED, WAIT_OBJECT_0,
    WAIT_TIMEOUT,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GRANT_ACCESS, GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo,
};
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
    DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{
    ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION, AclSizeInformation,
    AddAccessAllowedAceEx, AddAce, CONTAINER_INHERIT_ACE, CreateWellKnownSid,
    DACL_SECURITY_INFORMATION, DeriveCapabilitySidsFromName, EqualSid, FreeSid, GetAce,
    GetAclInformation, GetLengthSid, GetSecurityDescriptorControl, INHERITED_ACE, InitializeAcl,
    InitializeSecurityDescriptor, OBJECT_INHERIT_ACE, PROTECTED_DACL_SECURITY_INFORMATION, PSID,
    SE_DACL_PROTECTED, SECURITY_CAPABILITIES, SECURITY_DESCRIPTOR, SID_AND_ATTRIBUTES,
    SetSecurityDescriptorDacl, UNPROTECTED_DACL_SECURITY_INFORMATION, WinBuiltinAnyPackageSid,
    WinCapabilityInternetClientServerSid, WinCapabilityInternetClientSid,
    WinCapabilityPrivateNetworkClientServerSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, DELETE, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_ID_INFO, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_TRAVERSE, FileAttributeTagInfo, FileIdInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx, GetFinalPathNameByHandleW, LOCKFILE_EXCLUSIVE_LOCK,
    LOCKFILE_FAIL_IMMEDIATELY, LockFileEx, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    MoveFileExW, OPEN_EXISTING, READ_CONTROL, ReadFile, SYNCHRONIZE, UnlockFileEx, VOLUME_NAME_DOS,
    WRITE_DAC, WriteFile,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, GetStdHandle, HPCON, STD_ERROR_HANDLE,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::IO::OVERLAPPED;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateMutexW, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetCurrentProcess,
    GetExitCodeProcess, GetProcessTimes, InitializeProcThreadAttributeList, OpenProcess,
    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, ReleaseMutex, ResumeThread,
    STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject,
};

const BASE_PROFILE: &str = "SigmaCode.Execution.v3";
const INTERNAL_LAUNCHER: &str = "--internal-appcontainer-launcher";
const INTERNAL_PROBE: &str = "--internal-appcontainer-probe";
const INTERNAL_CONTAINMENT_PROBE: &str = "--internal-appcontainer-containment-probe";
const MAX_BOOTSTRAP_BYTES: usize = 8 * 1024 * 1024;
const ERROR_ALREADY_EXISTS_HRESULT: i32 = 0x8007_00b7_u32 as i32;
const ERROR_NOT_FOUND_HRESULT: i32 = 0x8007_0490_u32 as i32;
const INFINITE: u32 = u32::MAX;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const SE_GROUP_ENABLED: u32 = 4;
const PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT: u32 = 1;
const SECURITY_DESCRIPTOR_REVISION_VALUE: u32 = 1;
const TOKEN_SECURITY_ATTRIBUTE_TYPE_INT64: u16 = 1;
const TOKEN_SECURITY_ATTRIBUTE_TYPE_UINT64: u16 = 2;
const RECOVERY_SCHEMA_VERSION: u32 = 3;
const RECOVERY_PRODUCT: &str = "sigma-exec";
const RECOVERY_DIRECTORY: &str = "sandbox-recovery";
const RECOVERY_MUTEX_PREFIX: &str = "Global\\SigmaCode.sigma-exec.sandbox-acl.v3";
const MAX_RECOVERY_JOURNAL_BYTES: u64 = 16 * 1024 * 1024;
const MAX_RECOVERY_ENTRIES: usize = 100_000;
const MAX_RECOVERY_SCAN_DEPTH: usize = 256;
const ACCESS_ALLOWED_ACE_TYPE_VALUE: u8 = 0;
const SANDBOX_REPARSE_TARGET_UNRESOLVABLE: &str = "sandbox_reparse_target_unresolvable";
static PROFILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherBootstrap {
    params: ProcessParams,
    failure_nonce: String,
}

struct LauncherFailure {
    nonce: Option<String>,
    error: RpcError,
}

#[repr(C)]
struct NativeUnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *mut u16,
}

#[repr(C)]
struct TokenSecurityAttributeV1 {
    name: NativeUnicodeString,
    value_type: u16,
    reserved: u16,
    flags: u32,
    value_count: u32,
    values: *const u64,
}

#[repr(C)]
struct TokenSecurityAttributesInformation {
    version: u16,
    reserved: u16,
    attribute_count: u32,
    attributes: *const TokenSecurityAttributeV1,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryAclEntry {
    path: PathBuf,
    identity: RecoveryFileIdentity,
    permissions: u32,
    inherit: bool,
    preexisting_ace_count: u32,
    #[serde(default)]
    preexisting_sid_ace_count: u32,
    #[serde(default)]
    read_reparse_target: Option<RecoveryRootIdentity>,
    writable_root: Option<RecoveryRootIdentity>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryFileIdentity {
    volume_serial_number: u64,
    file_id: [u8; 16],
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryRootIdentity {
    path: PathBuf,
    identity: RecoveryFileIdentity,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoverySnapshot {
    schema_version: u32,
    product: String,
    profile_name: String,
    owner_process_id: u32,
    owner_process_creation_time: u64,
    entries: Vec<RecoveryAclEntry>,
}

struct RecoveryJournal {
    directory: PathBuf,
    path: PathBuf,
    snapshot: RecoverySnapshot,
}

struct PlannedAcl {
    path: PathBuf,
    permissions: u32,
    inherit: bool,
    propagate_inheritance: bool,
    read_reparse_target: Option<RecoveryRootIdentity>,
    writable_root: Option<PathBuf>,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSetSecurityObject(
        handle: HANDLE,
        security_information: u32,
        security_descriptor: *mut SECURITY_DESCRIPTOR,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
    fn NtQuerySecurityAttributesToken(
        token: HANDLE,
        attributes: *mut NativeUnicodeString,
        number_of_attributes: u32,
        buffer: *mut c_void,
        length: u32,
        return_length: *mut u32,
    ) -> i32;
}

pub(crate) fn try_run_internal_mode() -> Option<i32> {
    match std::env::args().nth(1).as_deref() {
        Some(INTERNAL_LAUNCHER) => Some(match run_launcher() {
            Ok(code) => code,
            Err(failure) => {
                if let Some(nonce) = failure.nonce {
                    let marker = json!({
                        "phase": "sandbox_launch",
                        "code": failure.error.code,
                        "message": failure.error.message,
                    });
                    eprintln!(
                        "{}{}:{}",
                        crate::process::INTERNAL_LAUNCH_FAILURE_MARKER_PREFIX,
                        nonce,
                        marker
                    );
                } else {
                    eprintln!(
                        "sigma-exec sandbox launch failed [{}]: {}",
                        failure.error.code, failure.error.message
                    );
                }
                125
            }
        }),
        Some(INTERNAL_PROBE) => Some(run_probe()),
        Some(INTERNAL_CONTAINMENT_PROBE) => Some(run_containment_probe()),
        _ => None,
    }
}

pub(crate) fn prepare_command(params: &ProcessParams) -> Result<PreparedCommand, RpcError> {
    validate_writable_acl_trees(params)?;
    let failure_nonce = secure_nonce("launch failure marker")?;
    let payload = serde_json::to_vec(&LauncherBootstrap {
        params: params.clone(),
        failure_nonce: failure_nonce.clone(),
    })
    .map_err(|error| {
        RpcError::new(
            "broker_protocol_error",
            format!("failed to encode Windows sandbox request: {error}"),
        )
    })?;
    if payload.is_empty() || payload.len() > MAX_BOOTSTRAP_BYTES {
        return Err(RpcError::new(
            "policy_denied",
            "Windows sandbox request exceeds the 8 MiB bootstrap limit",
        ));
    }
    let mut bootstrap = Vec::with_capacity(payload.len() + 4);
    bootstrap.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bootstrap.extend_from_slice(&payload);
    let executable = std::env::current_exe().map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("cannot resolve sigma-exec executable: {error}"),
        )
    })?;
    let mut command = Command::new(executable);
    command.arg(INTERNAL_LAUNCHER);
    command.current_dir(&params.command.cwd);
    command.env_clear();
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    Ok(PreparedCommand {
        command,
        bootstrap_stdin: bootstrap,
        protected_path_guards: Vec::new(),
        launch_failure_nonce: Some(failure_nonce),
    })
}

fn validate_writable_acl_trees(params: &ProcessParams) -> Result<(), RpcError> {
    let read = canonical_unique(&params.policy.read_roots)?;
    let write = minimal_windows_roots(&canonical_unique(&params.policy.write_roots)?);
    let mut protected = params.policy.protected_paths.clone();
    protected.extend(
        minimal_roots(&read)
            .into_iter()
            .flat_map(|root| [root.join(".git"), root.join(".agent")]),
    );
    let protected = canonical_protected(&protected, &write)?;
    let mut scanned = 0;
    for root in &write {
        validate_writable_acl_tree(root, root, &protected, &mut scanned, 0)?;
    }
    Ok(())
}

fn validate_writable_acl_tree(
    path: &Path,
    writable_root: &Path,
    protected: &[PathBuf],
    scanned: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    check_acl_tree_limits(scanned, depth, "writable ACL validation")?;
    let is_directory = inspect_acl_target_path(path, Some(writable_root))?;
    if protected.iter().any(|item| recovery_path_eq(item, path)) {
        return Ok(());
    }
    if !is_directory {
        return Ok(());
    }
    let entries = std::fs::read_dir(path).map_err(|error| {
        RpcError::new(
            "policy_denied",
            format!(
                "cannot inspect writable ACL tree '{}': {error}",
                path.display()
            ),
        )
    })?;
    for entry in entries {
        validate_writable_acl_tree(
            &entry.map_err(RpcError::from)?.path(),
            writable_root,
            protected,
            scanned,
            depth + 1,
        )?;
    }
    Ok(())
}

pub(crate) fn setup() -> Result<(), RpcError> {
    match create_profile(BASE_PROFILE, false) {
        Ok(profile) => {
            let recovery = recovery_directory_for_sid(profile.sid)?;
            let recovered = recover_stale_profiles(&recovery);
            drop(profile);
            recovered?;
        }
        Err(error) if error.code == "sandbox_profile_exists" => {
            let sid = derive_profile_sid(BASE_PROFILE)?;
            let recovery = recovery_directory_for_sid(sid);
            unsafe { FreeSid(sid) };
            let recovery = recovery?;
            let recovered = recover_stale_profiles(&recovery);
            recovered?;
        }
        Err(error) => return Err(error),
    }
    self_test()
}

pub(crate) fn detect() -> Result<(), RpcError> {
    let sid = derive_profile_sid(BASE_PROFILE).map_err(|error| {
        if error.code == "sandbox_unavailable" {
            RpcError::new(
                "sandbox_setup_required",
                "AppContainer profile is not prepared; run 'agent sandbox setup'",
            )
        } else {
            error
        }
    })?;
    let recovery = recovery_directory_for_sid(sid);
    unsafe { FreeSid(sid) };
    let recovery = recovery?;
    let recovered = recover_stale_profiles(&recovery);
    recovered?;
    self_test()
}

pub(crate) fn recover_after_process_quiesced() -> Result<(), RpcError> {
    let recovery = base_recovery_directory()?;
    recover_stale_profiles(&recovery)
}

fn run_launcher() -> Result<i32, LauncherFailure> {
    let bytes = read_bootstrap().map_err(|error| LauncherFailure { nonce: None, error })?;
    let bootstrap: LauncherBootstrap =
        serde_json::from_slice(&bytes).map_err(|error| LauncherFailure {
            nonce: None,
            error: RpcError::new(
                "broker_protocol_error",
                format!("invalid Windows sandbox bootstrap: {error}"),
            ),
        })?;
    let nonce = bootstrap.failure_nonce;
    run_launcher_with_params(bootstrap.params).map_err(|error| LauncherFailure {
        nonce: Some(nonce),
        error,
    })
}

fn run_launcher_with_params(params: ProcessParams) -> Result<i32, RpcError> {
    validate_launcher_params(&params)?;
    let profile_name = ephemeral_profile_name()?;
    // Persist the profile intent before profile creation. A hard kill in the
    // narrow create/journal window can therefore still be recovered exactly.
    let recovery = base_recovery_directory()?;
    let mut journal = RecoveryJournal::create(&recovery, &profile_name)?;
    let mut profile = match create_profile(&profile_name, true) {
        Ok(profile) => profile,
        Err(error) => {
            let _ = journal.remove();
            return Err(error);
        }
    };
    let appcontainer_profile = appcontainer_folder(profile.sid)?;
    let user_profile = host_user_profile(&appcontainer_profile)?;
    // Serialize each ACL read-modify-write phase across sessions without
    // serializing user command execution. AppContainer tokens do not have
    // WRITE_DAC, so releasing the lock after grant cannot race another DACL
    // writer from inside the sandbox.
    let granted = {
        let _acl_transaction = RecoveryMutex::acquire(&recovery)?;
        grant_policy_access(&params, profile.sid, &user_profile, &mut journal)
    };
    let result = match granted {
        Ok(()) => launch_appcontainer(&params, profile.sid),
        Err(error) => Err(error),
    };
    // Cleanup is deliberately delegated to the broker's outer PlatformGuard.
    // The launcher is itself a Job member, so only the broker can terminate
    // every remaining descendant, prove ActiveProcesses == 0, and then run
    // recovery without racing a grandchild. Keep the profile and journal live
    // until that quiescence boundary.
    profile.delete_on_drop = false;
    drop(profile);
    drop(journal);
    result
}

fn validate_launcher_params(params: &ProcessParams) -> Result<(), RpcError> {
    if params.policy.sandbox != SandboxMode::Required {
        return Err(RpcError::new(
            "policy_denied",
            "internal AppContainer launcher only accepts required sandbox requests",
        ));
    }
    if params.policy.network == NetworkMode::Full && !params.policy.network_approved {
        return Err(RpcError::new(
            "policy_denied",
            "full network requires per-call approval",
        ));
    }
    if !params.command.cwd.is_absolute() {
        return Err(RpcError::new(
            "policy_denied",
            "command cwd must be absolute",
        ));
    }
    for root in params
        .policy
        .read_roots
        .iter()
        .chain(params.policy.write_roots.iter())
        .chain(params.policy.execution_roots.iter())
    {
        if !root.is_absolute() {
            return Err(RpcError::new(
                "policy_denied",
                "all AppContainer roots must be absolute paths",
            ));
        }
        canonicalize_policy_root(root)?;
    }
    Ok(())
}

struct Profile {
    name: String,
    sid: PSID,
    delete_on_drop: bool,
}

impl Profile {
    #[cfg(test)]
    fn delete(&mut self) -> Result<(), RpcError> {
        if !self.delete_on_drop {
            return Ok(());
        }
        delete_profile(&self.name)?;
        self.delete_on_drop = false;
        Ok(())
    }
}

impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            if self.delete_on_drop {
                let name = wide_null(&self.name);
                DeleteAppContainerProfile(name.as_ptr());
            }
            FreeSid(self.sid);
        }
    }
}

fn delete_profile(name: &str) -> Result<(), RpcError> {
    let name = wide_null(name);
    let result = unsafe { DeleteAppContainerProfile(name.as_ptr()) };
    if result < 0 && result != ERROR_NOT_FOUND_HRESULT {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "DeleteAppContainerProfile failed with HRESULT 0x{:08x}",
                result as u32
            ),
        ));
    }
    Ok(())
}

fn create_profile(name: &str, delete_on_drop: bool) -> Result<Profile, RpcError> {
    let wide_name = wide_null(name);
    let display = wide_null("Sigma Code isolated execution");
    let description = wide_null("Ephemeral Sigma Code AppContainer sandbox");
    let mut sid: PSID = null_mut();
    let result = unsafe {
        CreateAppContainerProfile(
            wide_name.as_ptr(),
            display.as_ptr(),
            description.as_ptr(),
            null(),
            0,
            &mut sid,
        )
    };
    if result == ERROR_ALREADY_EXISTS_HRESULT {
        return Err(RpcError::new(
            "sandbox_profile_exists",
            format!("AppContainer profile '{name}' already exists"),
        ));
    }
    if result < 0 || sid.is_null() {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "CreateAppContainerProfile failed with HRESULT 0x{:08x}",
                result as u32
            ),
        ));
    }
    Ok(Profile {
        name: name.into(),
        sid,
        delete_on_drop,
    })
}

fn derive_profile_sid(name: &str) -> Result<PSID, RpcError> {
    let name = wide_null(name);
    let mut sid: PSID = null_mut();
    let result = unsafe { DeriveAppContainerSidFromAppContainerName(name.as_ptr(), &mut sid) };
    if result < 0 || sid.is_null() {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "DeriveAppContainerSidFromAppContainerName failed with HRESULT 0x{:08x}",
                result as u32
            ),
        ));
    }
    Ok(sid)
}

fn ephemeral_profile_name() -> Result<String, RpcError> {
    let nonce = secure_nonce("profile nonce")?;
    Ok(format!("SigmaCode.Exec.{}.{}", std::process::id(), nonce))
}

fn secure_nonce(label: &str) -> Result<String, RpcError> {
    let mut nonce = [0_u8; 16];
    let status = unsafe {
        BCryptGenRandom(
            null_mut(),
            nonce.as_mut_ptr(),
            nonce.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!("BCryptGenRandom({label}) failed with NTSTATUS 0x{status:08x}"),
        ));
    }
    let nonce = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(nonce)
}

fn grant_policy_access(
    params: &ProcessParams,
    sid: PSID,
    user_profile: &Path,
    journal: &mut RecoveryJournal,
) -> Result<(), RpcError> {
    let workspace_read = canonical_unique(&params.policy.read_roots)?;
    let mut read_and_execute = params.policy.read_roots.clone();
    read_and_execute.extend(params.policy.execution_roots.iter().cloned());
    let declared_read = canonical_unique(&read_and_execute)?;
    let read = minimal_windows_roots(&declared_read);
    let write = minimal_windows_roots(&canonical_unique(&params.policy.write_roots)?);
    let mut plan = Vec::new();
    let mut planned_objects = 0;
    for path in policy_ancestor_paths(params, user_profile)? {
        plan.push(PlannedAcl {
            path,
            permissions: FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            inherit: false,
            propagate_inheritance: false,
            read_reparse_target: None,
            writable_root: None,
        });
    }
    for path in &read {
        plan_read_tree(
            path,
            &declared_read,
            &write,
            &mut plan,
            &mut planned_objects,
            0,
        )?;
    }
    let mut protected = params.policy.protected_paths.clone();
    protected.extend(
        minimal_roots(&workspace_read)
            .into_iter()
            .flat_map(|root| [root.join(".git"), root.join(".agent")]),
    );
    let protected = canonical_protected(&protected, &write)?;
    for path in &write {
        plan_write_tree(
            path,
            path,
            &protected,
            &read,
            &mut plan,
            &mut planned_objects,
            0,
        )?;
    }
    journal.prepare(&plan, sid)?;
    journal.apply(&plan, sid)
}

fn policy_ancestor_paths(
    params: &ProcessParams,
    user_profile: &Path,
) -> Result<Vec<PathBuf>, RpcError> {
    let mut declared = params.policy.read_roots.clone();
    declared.extend(params.policy.write_roots.iter().cloned());
    declared.extend(params.policy.execution_roots.iter().cloned());
    let roots = canonical_unique(&declared)?;
    let root_keys = roots
        .iter()
        .map(|path| path.to_string_lossy().to_lowercase())
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut ancestors = Vec::new();
    for root in roots {
        for ancestor in root.ancestors().skip(1) {
            let canonical = ancestor.canonicalize().map_err(|error| {
                RpcError::new(
                    "policy_denied",
                    format!(
                        "cannot canonicalize sandbox root ancestor '{}': {error}",
                        ancestor.display()
                    ),
                )
            })?;
            if protected_ancestor_boundary(user_profile, &canonical) {
                continue;
            }
            let key = canonical.to_string_lossy().to_lowercase();
            if !root_keys.contains(&key) && seen.insert(key) {
                ancestors.push(canonical);
            }
        }
    }
    Ok(ancestors)
}

fn protected_ancestor_boundary(user_profile: &Path, path: &Path) -> bool {
    // Never rewrite security on a volume root, the profiles root, or the user
    // profile boundary. A standard broker user generally does not own those
    // objects, and mutating their DACL would widen the sandbox's host impact.
    // Runtime manifests must avoid metadata probes on the logical volume root;
    // intermediate caller-owned ancestors still receive minimal traversal below.
    if path.parent().is_none() {
        return true;
    }
    let profile_root = user_profile.parent();
    path.to_string_lossy()
        .eq_ignore_ascii_case(&user_profile.to_string_lossy())
        || profile_root.is_some_and(|root| {
            path.to_string_lossy()
                .eq_ignore_ascii_case(&root.to_string_lossy())
        })
}

fn host_user_profile(appcontainer_profile: &Path) -> Result<PathBuf, RpcError> {
    // GetAppContainerFolderPath returns
    // <user>\AppData\Local\Packages\<package>\AC. Derive the owning user profile
    // from that OS-owned path instead of trusting a caller-provided environment
    // variable (the launcher deliberately starts with an empty environment).
    let local_app_data = host_local_app_data(appcontainer_profile)?;
    local_app_data
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| {
            RpcError::new(
                "sandbox_unavailable",
                format!(
                    "cannot derive the host user profile from AppContainer folder '{}'",
                    appcontainer_profile.display()
                ),
            )
        })?
        .canonicalize()
        .map_err(|error| {
            RpcError::new(
                "sandbox_unavailable",
                format!("cannot resolve the host user profile: {error}"),
            )
        })
}

fn plan_write_tree(
    path: &Path,
    writable_root: &Path,
    protected: &[PathBuf],
    read_roots: &[PathBuf],
    plan: &mut Vec<PlannedAcl>,
    planned_objects: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    check_acl_plan_limits(plan, planned_objects, depth)?;
    let is_directory = inspect_acl_target_path(path, Some(writable_root))?;
    let protected_here = protected.iter().any(|item| windows_path_within(item, path));
    if protected_here {
        let read_covers = read_roots
            .iter()
            .any(|root| windows_path_within(root, path));
        let has_read_descendant = read_roots
            .iter()
            .any(|root| windows_path_within(path, root));
        if read_covers {
            plan.push(PlannedAcl {
                path: path.to_owned(),
                permissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                inherit: is_directory,
                propagate_inheritance: false,
                read_reparse_target: None,
                // The target is physically inside a mutable policy root. Keep
                // its durable root available if host activity relocates it.
                writable_root: Some(writable_root.to_owned()),
            });
            if is_directory {
                for child in read_acl_directory(path, "protected read ACL tree")? {
                    plan_read_tree_within_write_root(
                        &child,
                        writable_root,
                        plan,
                        planned_objects,
                        depth + 1,
                    )?;
                }
            }
            return Ok(());
        }
        if !has_read_descendant || !is_directory {
            return Ok(());
        }
        for entry in read_acl_directory(path, "protected writable ACL tree")? {
            plan_write_tree(
                &entry,
                writable_root,
                protected,
                read_roots,
                plan,
                planned_objects,
                depth + 1,
            )?;
        }
        return Ok(());
    }
    let has_protected_descendant = protected.iter().any(|item| windows_path_within(path, item));
    plan.push(PlannedAcl {
        path: path.to_owned(),
        permissions: FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
        inherit: !has_protected_descendant && is_directory,
        // Existing descendants are each journaled and receive their own
        // explicit ACE. NtSetSecurityObject avoids creating unjournaled
        // inherited ACEs while preserving inheritance for future children.
        propagate_inheritance: false,
        read_reparse_target: None,
        writable_root: Some(writable_root.to_owned()),
    });
    if !is_directory {
        return Ok(());
    }
    for child in read_acl_directory(path, "writable ACL tree")? {
        plan_write_tree(
            &child,
            writable_root,
            protected,
            read_roots,
            plan,
            planned_objects,
            depth + 1,
        )?;
    }
    Ok(())
}

fn plan_read_tree_within_write_root(
    path: &Path,
    writable_root: &Path,
    plan: &mut Vec<PlannedAcl>,
    planned_objects: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    check_acl_plan_limits(plan, planned_objects, depth)?;
    let is_directory = inspect_acl_target_path(path, Some(writable_root))?;
    plan.push(PlannedAcl {
        path: path.to_owned(),
        permissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        inherit: is_directory,
        propagate_inheritance: false,
        read_reparse_target: None,
        writable_root: Some(writable_root.to_owned()),
    });
    if !is_directory {
        return Ok(());
    }
    for child in read_acl_directory(path, "protected read ACL tree")? {
        plan_read_tree_within_write_root(&child, writable_root, plan, planned_objects, depth + 1)?;
    }
    Ok(())
}

fn plan_read_tree(
    path: &Path,
    read_roots: &[PathBuf],
    write_roots: &[PathBuf],
    plan: &mut Vec<PlannedAcl>,
    planned_objects: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    // A writable planner visits every existing object and supplies at least
    // read/execute access. It also handles protected read-only subtrees.
    if write_roots
        .iter()
        .any(|root| windows_path_within(root, path))
    {
        return Ok(());
    }
    check_acl_plan_limits(plan, planned_objects, depth)?;
    let inspected = inspect_read_acl_target_path(path, read_roots);
    let Some((is_directory, read_reparse_target)) = (match inspected {
        // A descendant discovered while enumerating a declared read tree is
        // not itself an authorization request. If its reparse target no
        // longer resolves, leave the link object and target ungranted and
        // continue planning the unrelated tree. An explicitly declared root
        // (depth zero) still fails closed with the stable sandbox code.
        Err(error) if depth > 0 && error.code == SANDBOX_REPARSE_TARGET_UNRESOLVABLE => {
            return Ok(());
        }
        result => result?,
    }) else {
        // An existing read-only link outside every declared read root gets no
        // ACE and is never traversed. Parent grants are path-local, so the
        // AppContainer cannot acquire access through it.
        return Ok(());
    };
    let has_write_descendant = write_roots
        .iter()
        .any(|root| windows_path_within(path, root));
    plan.push(PlannedAcl {
        path: path.to_owned(),
        permissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
        inherit: read_reparse_target.is_none() && is_directory && !has_write_descendant,
        // Journal every object that exists before the grant. The explicit
        // inheritable ACE still covers children created later, while avoiding
        // unjournaled inherited ACEs on the pre-existing tree.
        propagate_inheritance: false,
        read_reparse_target,
        writable_root: None,
    });
    if !is_directory
        || plan
            .last()
            .is_some_and(|entry| entry.read_reparse_target.is_some())
    {
        return Ok(());
    }
    for child in read_acl_directory(path, "read ACL tree")? {
        plan_read_tree(
            &child,
            read_roots,
            write_roots,
            plan,
            planned_objects,
            depth + 1,
        )?;
    }
    Ok(())
}

fn read_acl_directory(path: &Path, context: &str) -> Result<Vec<PathBuf>, RpcError> {
    std::fs::read_dir(path)
        .map_err(|error| {
            RpcError::new(
                "policy_denied",
                format!("cannot enumerate {context} '{}': {error}", path.display()),
            )
        })?
        .map(|entry| entry.map(|item| item.path()).map_err(RpcError::from))
        .collect()
}

fn check_acl_tree_limits(scanned: &mut usize, depth: usize, context: &str) -> Result<(), RpcError> {
    *scanned += 1;
    if *scanned > MAX_RECOVERY_ENTRIES || depth > MAX_RECOVERY_SCAN_DEPTH {
        return Err(RpcError::new(
            "policy_denied",
            format!("{context} exceeds sandbox ACL traversal limits"),
        ));
    }
    Ok(())
}

fn check_acl_plan_limits(
    plan: &[PlannedAcl],
    planned_objects: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    *planned_objects += 1;
    if plan.len() >= MAX_RECOVERY_ENTRIES
        || *planned_objects > MAX_RECOVERY_ENTRIES
        || depth > MAX_RECOVERY_SCAN_DEPTH
    {
        return Err(RpcError::new(
            "policy_denied",
            "sandbox ACL plan exceeds durable recovery limits",
        ));
    }
    Ok(())
}

fn canonical_protected(
    paths: &[PathBuf],
    write_roots: &[PathBuf],
) -> Result<Vec<PathBuf>, RpcError> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let canonical = if path.exists() {
            path.canonicalize().map_err(RpcError::from)?
        } else {
            let parent = path
                .parent()
                .ok_or_else(|| RpcError::new("policy_denied", "protected path has no parent"))?;
            let parent = parent.canonicalize().map_err(|error| {
                RpcError::new(
                    "policy_denied",
                    format!(
                        "cannot resolve protected path '{}': {error}",
                        path.display()
                    ),
                )
            })?;
            let unresolved = parent.join(path.file_name().ok_or_else(|| {
                RpcError::new("policy_denied", "protected path has no file name")
            })?);
            if write_roots.iter().any(|root| unresolved.starts_with(root)) {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "protected path '{}' must exist before granting a containing writable root",
                        unresolved.display()
                    ),
                ));
            }
            unresolved
        };
        let key = canonical.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            result.push(canonical);
        }
    }
    Ok(result)
}

fn canonical_unique(paths: &[PathBuf]) -> Result<Vec<PathBuf>, RpcError> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for path in paths {
        let canonical = canonicalize_policy_root(path)?;
        let key = canonical.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            result.push(canonical);
        }
    }
    Ok(result)
}

pub(crate) fn canonicalize_policy_root(path: &Path) -> Result<PathBuf, RpcError> {
    path.canonicalize().map_err(|error| {
        let is_reparse_point = std::fs::symlink_metadata(path)
            .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(false);
        if is_reparse_point {
            RpcError::new(
                SANDBOX_REPARSE_TARGET_UNRESOLVABLE,
                format!(
                    "cannot resolve sandbox reparse root '{}': {error}",
                    path.display()
                ),
            )
        } else {
            RpcError::new(
                "policy_denied",
                format!(
                    "cannot canonicalize sandbox root '{}': {error}",
                    path.display()
                ),
            )
        }
    })
}

fn minimal_windows_roots(roots: &[PathBuf]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter(|root| {
            !roots.iter().any(|candidate| {
                !windows_path_within(root, candidate) && windows_path_within(candidate, root)
            })
        })
        .cloned()
        .collect()
}

fn update_acl(
    path: &Path,
    sid: PSID,
    permissions: u32,
    mode: i32,
    inherit: bool,
) -> Result<(), RpcError> {
    update_acl_scoped(path, sid, permissions, mode, inherit, None)
}

fn update_acl_scoped(
    path: &Path,
    sid: PSID,
    permissions: u32,
    mode: i32,
    inherit: bool,
    writable_root: Option<&Path>,
) -> Result<(), RpcError> {
    let handle = open_acl_target(path)?;
    assert_acl_handle_target(&handle, path, writable_root)?;
    update_acl_handle(&handle, path, sid, permissions, mode, inherit, inherit)
}

fn open_acl_target(path: &Path) -> Result<OwnedHandle, RpcError> {
    let path_wide = wide_null(path.as_os_str());
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            READ_CONTROL | WRITE_DAC,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateFileW(ACL target)"));
    }
    Ok(OwnedHandle(handle))
}

fn open_recovery_root_for_scan(path: &Path) -> Result<OwnedHandle, RpcError> {
    let path_wide = wide_null(path.as_os_str());
    let handle = unsafe {
        CreateFileW(
            path_wide.as_ptr(),
            READ_CONTROL | WRITE_DAC,
            // Denying FILE_SHARE_DELETE pins the durable root name and
            // identity for the complete recovery scan.
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error("CreateFileW(recovery scan root)"));
    }
    Ok(OwnedHandle(handle))
}

fn update_acl_handle(
    handle: &OwnedHandle,
    _path: &Path,
    sid: PSID,
    permissions: u32,
    mode: i32,
    inherit: bool,
    propagate_inheritance: bool,
) -> Result<(), RpcError> {
    if mode != GRANT_ACCESS {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "unsupported sandbox ACL update mode",
        ));
    }
    let mut old_acl = null_mut();
    let mut security_descriptor = null_mut();
    let get = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if get != 0 {
        return Err(win32_code_error("GetNamedSecurityInfoW", get));
    }
    let mut storage = append_exact_allowed_ace(
        old_acl,
        sid,
        permissions,
        expected_explicit_ace_flags(inherit),
    )?;
    let set = apply_acl_handle(
        handle,
        storage.as_mut_ptr().cast::<ACL>(),
        propagate_inheritance,
    );
    unsafe {
        LocalFree(security_descriptor);
    }
    set
}

/// Append one distinct product-owned allow ACE without coalescing a user's
/// pre-existing ACE for the same SID. Keep explicit entries before inherited
/// entries so the resulting DACL remains in Windows canonical order.
fn append_exact_allowed_ace(
    old_acl: *mut ACL,
    sid: PSID,
    permissions: u32,
    flags: u8,
) -> Result<Vec<usize>, RpcError> {
    let mut information = ACL_SIZE_INFORMATION::default();
    let revision = if old_acl.is_null() {
        ACL_REVISION
    } else {
        if unsafe {
            GetAclInformation(
                old_acl,
                (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(last_error("GetAclInformation(ACL grant target)"));
        }
        unsafe { (*old_acl).AclRevision as u32 }
    };
    let ace_bytes = size_of::<ACCESS_ALLOWED_ACE>() as u32 - size_of::<u32>() as u32
        + unsafe { GetLengthSid(sid) };
    let required = (size_of::<ACL>() as u32)
        .max(information.AclBytesInUse)
        .checked_add(ace_bytes)
        .ok_or_else(|| RpcError::new("sandbox_recovery_failed", "sandbox ACL size overflow"))?;
    let mut storage = vec![0_usize; (required as usize).div_ceil(size_of::<usize>())];
    let new_acl = storage.as_mut_ptr().cast::<ACL>();
    if unsafe { InitializeAcl(new_acl, required, revision) } == 0 {
        return Err(last_error("InitializeAcl(ACL grant target)"));
    }
    let mut inserted = false;
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        if unsafe { GetAce(old_acl, index, &mut raw_ace) } == 0 {
            return Err(last_error("GetAce(ACL grant target)"));
        }
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if !inserted && header.AceFlags & INHERITED_ACE as u8 != 0 {
            if unsafe { AddAccessAllowedAceEx(new_acl, revision, flags as u32, permissions, sid) }
                == 0
            {
                return Err(last_error("AddAccessAllowedAceEx(ACL grant target)"));
            }
            inserted = true;
        }
        if unsafe {
            AddAce(
                new_acl,
                revision,
                u32::MAX,
                raw_ace,
                u32::from(header.AceSize),
            )
        } == 0
        {
            return Err(last_error("AddAce(ACL grant target)"));
        }
    }
    if !inserted
        && unsafe { AddAccessAllowedAceEx(new_acl, revision, flags as u32, permissions, sid) } == 0
    {
        return Err(last_error("AddAccessAllowedAceEx(ACL grant target)"));
    }
    Ok(storage)
}

fn apply_acl_handle(
    handle: &OwnedHandle,
    acl: *mut ACL,
    propagate_inheritance: bool,
) -> Result<(), RpcError> {
    let set = if propagate_inheritance {
        unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null_mut(),
            )
        }
    } else {
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        if unsafe {
            InitializeSecurityDescriptor(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                SECURITY_DESCRIPTOR_REVISION_VALUE,
            )
        } == 0
        {
            return Err(last_error("InitializeSecurityDescriptor"));
        }
        if unsafe {
            SetSecurityDescriptorDacl(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                1,
                acl,
                0,
            )
        } == 0
        {
            return Err(last_error("SetSecurityDescriptorDacl"));
        }
        let status =
            unsafe { NtSetSecurityObject(handle.0, DACL_SECURITY_INFORMATION, &mut descriptor) };
        if status == 0 {
            0
        } else {
            unsafe { RtlNtStatusToDosError(status) }
        }
    };
    if set != 0 {
        return Err(win32_code_error("SetSecurityInfo(ACL target)", set));
    }
    Ok(())
}

fn remove_exact_acl_entry(
    handle: &OwnedHandle,
    sid: PSID,
    permissions: u32,
    inherit: bool,
    preexisting_ace_count: u32,
) -> Result<(), RpcError> {
    let mut old_acl = null_mut();
    let mut security_descriptor = null_mut();
    let get = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if get != 0 {
        return Err(win32_code_error(
            "GetSecurityInfo(ACL recovery target)",
            get,
        ));
    }
    let expected_flags = expected_explicit_ace_flags(inherit);
    let result = (|| {
        let exact_count = count_exact_acl_entries(old_acl, sid, permissions, expected_flags)?;
        if exact_count > preexisting_ace_count {
            let Some(mut storage) =
                rebuild_acl_without_one_exact_entry(old_acl, sid, permissions, expected_flags)?
            else {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    "sandbox ACL recovery could not rebuild an excess exact ACE",
                ));
            };
            apply_acl_handle(handle, storage.as_mut_ptr().cast::<ACL>(), inherit)
        } else if inherit {
            // Reapplying an inheritable parent DACL makes cleanup retryable if
            // an earlier propagation was interrupted after its explicit ACE
            // had already been removed.
            apply_acl_handle(handle, old_acl, true)
        } else {
            Ok(())
        }
    })();
    unsafe {
        LocalFree(security_descriptor);
    }
    result?;

    let actual = count_exact_acl_entries_for_handle(handle, sid, permissions, expected_flags)?;
    if actual != preexisting_ace_count {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox ACL exact-entry recovery did not reach its baseline (expected {preexisting_ace_count}, found {actual})"
            ),
        ));
    }
    Ok(())
}

fn count_exact_acl_entries(
    acl: *mut ACL,
    sid: PSID,
    permissions: u32,
    expected_flags: u8,
) -> Result<u32, RpcError> {
    if acl.is_null() {
        return Ok(0);
    }
    let mut information = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(last_error("GetAclInformation(ACL recovery baseline)"));
    }
    let mut count = 0;
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        if unsafe { GetAce(acl, index, &mut raw_ace) } == 0 {
            return Err(last_error("GetAce(ACL recovery baseline)"));
        }
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE_VALUE || header.AceFlags != expected_flags {
            continue;
        }
        let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        let ace_sid = (&allowed.SidStart as *const u32)
            .cast_mut()
            .cast::<c_void>();
        if allowed.Mask == permissions && unsafe { EqualSid(ace_sid, sid) } != 0 {
            count += 1;
        }
    }
    Ok(count)
}

fn count_exact_acl_entries_for_handle(
    handle: &OwnedHandle,
    sid: PSID,
    permissions: u32,
    expected_flags: u8,
) -> Result<u32, RpcError> {
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let get = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if get != 0 {
        return Err(win32_code_error(
            "GetSecurityInfo(ACL recovery baseline)",
            get,
        ));
    }
    let result = count_exact_acl_entries(acl, sid, permissions, expected_flags);
    unsafe { LocalFree(descriptor) };
    result
}

fn count_allowed_acl_entries(acl: *mut ACL, sid: PSID) -> Result<u32, RpcError> {
    if acl.is_null() {
        return Ok(0);
    }
    let mut information = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(last_error("GetAclInformation(ACL SID baseline)"));
    }
    let mut count = 0;
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        if unsafe { GetAce(acl, index, &mut raw_ace) } == 0 {
            return Err(last_error("GetAce(ACL SID baseline)"));
        }
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        if header.AceType != ACCESS_ALLOWED_ACE_TYPE_VALUE {
            continue;
        }
        let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        let ace_sid = (&allowed.SidStart as *const u32)
            .cast_mut()
            .cast::<c_void>();
        if unsafe { EqualSid(ace_sid, sid) } != 0 {
            count += 1;
        }
    }
    Ok(count)
}

fn count_allowed_acl_entries_for_handle(handle: &OwnedHandle, sid: PSID) -> Result<u32, RpcError> {
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    let get = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if get != 0 {
        return Err(win32_code_error("GetSecurityInfo(ACL SID baseline)", get));
    }
    let result = count_allowed_acl_entries(acl, sid);
    unsafe { LocalFree(descriptor) };
    result
}

fn expected_explicit_ace_flags(inherit: bool) -> u8 {
    if inherit {
        (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
    } else {
        0
    }
}

/// Rebuild an ACL while removing at most one product-owned allow ACE.
///
/// Recovery journals describe the exact ACE sigma-exec intended to add. Other
/// explicit permissions for the same AppContainer SID may belong to the user or
/// another process and must survive recovery.
fn rebuild_acl_without_one_exact_entry(
    old_acl: *mut ACL,
    sid: PSID,
    permissions: u32,
    expected_flags: u8,
) -> Result<Option<Vec<usize>>, RpcError> {
    if old_acl.is_null() {
        return Ok(None);
    }
    let mut information = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            old_acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(last_error("GetAclInformation(ACL recovery target)"));
    }
    if information.AclBytesInUse < size_of::<ACL>() as u32 {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery target contains a malformed ACL",
        ));
    }
    let word_count = (information.AclBytesInUse as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; word_count];
    let new_acl = storage.as_mut_ptr().cast::<ACL>();
    let revision = unsafe { (*old_acl).AclRevision as u32 }.max(ACL_REVISION);
    if unsafe { InitializeAcl(new_acl, information.AclBytesInUse, revision) } == 0 {
        return Err(last_error("InitializeAcl(ACL recovery target)"));
    }
    let mut removed = false;
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        if unsafe { GetAce(old_acl, index, &mut raw_ace) } == 0 {
            return Err(last_error("GetAce(ACL recovery target)"));
        }
        if raw_ace.is_null() {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "sandbox recovery target contains a null ACL entry",
            ));
        }
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        let is_exact = if !removed && header.AceType == ACCESS_ALLOWED_ACE_TYPE_VALUE {
            let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            let ace_sid = (&allowed.SidStart as *const u32)
                .cast_mut()
                .cast::<c_void>();
            header.AceFlags == expected_flags
                && allowed.Mask == permissions
                && unsafe { EqualSid(ace_sid, sid) } != 0
        } else {
            false
        };
        if is_exact {
            removed = true;
            continue;
        }
        if unsafe {
            AddAce(
                new_acl,
                revision,
                u32::MAX,
                raw_ace,
                u32::from(header.AceSize),
            )
        } == 0
        {
            return Err(last_error("AddAce(ACL recovery target)"));
        }
    }
    Ok(removed.then_some(storage))
}

/// Remove allow ACEs attributable to an inheritable journal grant from an
/// object that did not exist when the recovery journal was prepared.
///
/// Windows can normalize an inherited ACE into an explicit-looking ACE while
/// an ancestor DACL is being recovered. A matching journal permission mask is
/// therefore also required for that fallback; unrelated explicit same-SID
/// permissions remain untouched.
fn rebuild_acl_without_inherited_sid_entries(
    old_acl: *mut ACL,
    sid: PSID,
    inherited_permissions: &[u32],
) -> Result<Option<Vec<usize>>, RpcError> {
    if old_acl.is_null() {
        return Ok(None);
    }
    let mut information = ACL_SIZE_INFORMATION::default();
    if unsafe {
        GetAclInformation(
            old_acl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(last_error(
            "GetAclInformation(inherited ACL recovery target)",
        ));
    }
    if information.AclBytesInUse < size_of::<ACL>() as u32 {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox inherited recovery target contains a malformed ACL",
        ));
    }
    let word_count = (information.AclBytesInUse as usize).div_ceil(size_of::<usize>());
    let mut storage = vec![0_usize; word_count];
    let new_acl = storage.as_mut_ptr().cast::<ACL>();
    let revision = unsafe { (*old_acl).AclRevision as u32 }.max(ACL_REVISION);
    if unsafe { InitializeAcl(new_acl, information.AclBytesInUse, revision) } == 0 {
        return Err(last_error("InitializeAcl(inherited ACL recovery target)"));
    }
    let mut removed = false;
    for index in 0..information.AceCount {
        let mut raw_ace = null_mut();
        if unsafe { GetAce(old_acl, index, &mut raw_ace) } == 0 {
            return Err(last_error("GetAce(inherited ACL recovery target)"));
        }
        if raw_ace.is_null() {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "sandbox inherited recovery target contains a null ACL entry",
            ));
        }
        let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
        let journal_grant_for_sid = if header.AceType == ACCESS_ALLOWED_ACE_TYPE_VALUE {
            let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            let ace_sid = (&allowed.SidStart as *const u32)
                .cast_mut()
                .cast::<c_void>();
            (unsafe { EqualSid(ace_sid, sid) }) != 0
                && (header.AceFlags & INHERITED_ACE as u8 != 0
                    || inherited_permissions.contains(&allowed.Mask))
        } else {
            false
        };
        if journal_grant_for_sid {
            removed = true;
            continue;
        }
        if unsafe {
            AddAce(
                new_acl,
                revision,
                u32::MAX,
                raw_ace,
                u32::from(header.AceSize),
            )
        } == 0
        {
            return Err(last_error("AddAce(inherited ACL recovery target)"));
        }
    }
    Ok(removed.then_some(storage))
}

fn remove_inherited_sid_acl_entries(
    handle: &OwnedHandle,
    sid: PSID,
    inherited_permissions: &[u32],
) -> Result<(), RpcError> {
    let mut old_acl = null_mut();
    let mut security_descriptor = null_mut();
    let get = unsafe {
        GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut security_descriptor,
        )
    };
    if get != 0 {
        return Err(win32_code_error(
            "GetSecurityInfo(inherited ACL recovery target)",
            get,
        ));
    }
    let result = (|| {
        let mut control = 0;
        let mut revision = 0;
        if unsafe { GetSecurityDescriptorControl(security_descriptor, &mut control, &mut revision) }
            == 0
        {
            return Err(last_error(
                "GetSecurityDescriptorControl(inherited ACL recovery target)",
            ));
        }
        let Some(mut storage) =
            rebuild_acl_without_inherited_sid_entries(old_acl, sid, inherited_permissions)?
        else {
            return Ok(());
        };
        let acl = storage.as_mut_ptr().cast::<ACL>();
        // Applying an unprotected DACL without an explicit protection flag can
        // cause Windows to immediately materialize the stale inherited ACE
        // again. First pin the filtered ACL as protected, then restore the
        // object's original inheritance mode. The parent has already been
        // cleaned, so unprotecting deterministically recomputes inheritance
        // without the ephemeral run SID.
        let protect = unsafe {
            SetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null_mut(),
            )
        };
        if protect != 0 {
            return Err(win32_code_error(
                "SetSecurityInfo(protected inherited ACL recovery target)",
                protect,
            ));
        }
        if control & SE_DACL_PROTECTED == 0 {
            let unprotect = unsafe {
                SetSecurityInfo(
                    handle.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | UNPROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl,
                    null_mut(),
                )
            };
            if unprotect != 0 {
                return Err(win32_code_error(
                    "SetSecurityInfo(unprotected inherited ACL recovery target)",
                    unprotect,
                ));
            }
        }
        Ok(())
    })();
    unsafe { LocalFree(security_descriptor) };
    result
}

fn inspect_acl_target_path(path: &Path, writable_root: Option<&Path>) -> Result<bool, RpcError> {
    let handle = open_acl_target(path)?;
    assert_acl_handle_target(&handle, path, writable_root)?;
    assert_single_link_file(&handle, path)?;
    Ok(acl_target_information(handle.0)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0)
}

fn inspect_read_acl_target_path(
    path: &Path,
    read_roots: &[PathBuf],
) -> Result<Option<(bool, Option<RecoveryRootIdentity>)>, RpcError> {
    // Some Windows filesystems reject a WRITE_DAC handle to a dangling
    // junction before FILE_FLAG_OPEN_REPARSE_POINT can expose the link object.
    // Classify the target failure through a metadata-only preflight first;
    // the durable handle and identity checks below still guard every valid
    // reparse target against retargeting races.
    let preflight_resolved = std::fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .map(|_| resolve_read_reparse_target(path))
        .transpose()?;
    let handle = open_acl_target(path)?;
    let information = acl_target_information(handle.0)?;
    let tag = acl_target_tag(handle.0)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        assert_acl_handle_target(&handle, path, None)?;
        if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
            && information.nNumberOfLinks != 1
            && !read_roots.iter().any(|root| windows_path_eq(root, path))
        {
            // A descendant read grant would affect every hard-link alias.
            // Skip it unless this exact object path was explicitly declared;
            // aliases of an explicitly authorized file expose no new content.
            return Ok(None);
        }
        return Ok(Some((
            information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0,
            None,
        )));
    }

    let resolved = match preflight_resolved {
        Some(resolved) => resolved,
        None => resolve_read_reparse_target(path)?,
    };
    if !read_roots
        .iter()
        .any(|root| windows_path_within(root, &resolved))
    {
        return Ok(None);
    }
    let target_handle = open_acl_target(&resolved)?;
    assert_acl_handle_target(&target_handle, &resolved, None)?;
    let target = RecoveryRootIdentity {
        path: final_handle_path(target_handle.0)?,
        identity: acl_target_identity(target_handle.0)?,
    };
    assert_read_reparse_target(&handle, path, &target)?;
    // Never inherit through or enumerate a reparse point. The resolved target
    // is covered independently through its real path under a declared root.
    Ok(Some((false, Some(target))))
}

fn resolve_read_reparse_target(path: &Path) -> Result<PathBuf, RpcError> {
    path.canonicalize().map_err(|error| {
        RpcError::new(
            SANDBOX_REPARSE_TARGET_UNRESOLVABLE,
            format!(
                "cannot resolve read-only sandbox reparse target '{}': {error}",
                path.display()
            ),
        )
    })
}

fn assert_read_reparse_target(
    handle: &OwnedHandle,
    link_path: &Path,
    expected_target: &RecoveryRootIdentity,
) -> Result<(), RpcError> {
    let tag = acl_target_tag(handle.0)?;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox read-only reparse object changed type: '{}'",
                link_path.display()
            ),
        ));
    }
    let expected_link = canonical_link_path(link_path)?;
    let actual_link = final_handle_path(handle.0)?;
    if !windows_path_eq(&expected_link, &actual_link) {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox read-only reparse object changed path: expected '{}', opened '{}'",
                expected_link.display(),
                actual_link.display()
            ),
        ));
    }
    let actual_target = link_path.canonicalize().map_err(|error| {
        RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox read-only reparse target disappeared '{}': {error}",
                link_path.display()
            ),
        )
    })?;
    if !windows_path_eq(&expected_target.path, &actual_target) {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox read-only reparse target changed: expected '{}', resolved '{}'",
                expected_target.path.display(),
                actual_target.display()
            ),
        ));
    }
    let target_handle = open_acl_target(&actual_target)?;
    assert_acl_handle_target(&target_handle, &actual_target, None)?;
    if acl_target_identity(target_handle.0)? != expected_target.identity {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox read-only reparse target identity changed: '{}'",
                actual_target.display()
            ),
        ));
    }
    Ok(())
}

fn canonical_link_path(path: &Path) -> Result<PathBuf, RpcError> {
    let parent = path.parent().ok_or_else(|| {
        RpcError::new(
            "sandbox_recovery_failed",
            "sandbox reparse path has no parent",
        )
    })?;
    let name = path.file_name().ok_or_else(|| {
        RpcError::new(
            "sandbox_recovery_failed",
            "sandbox reparse path has no file name",
        )
    })?;
    Ok(parent.canonicalize().map_err(RpcError::from)?.join(name))
}

#[cfg(test)]
fn validate_acl_target_path(path: &Path, writable_root: &Path) -> Result<(), RpcError> {
    inspect_acl_target_path(path, Some(writable_root)).map(|_| ())
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

struct RecoveryClaim {
    path: PathBuf,
    canonical_path: PathBuf,
    handle: OwnedHandle,
}

impl RecoveryClaim {
    fn acquire(path: &Path) -> Result<Option<Self>, RpcError> {
        let canonical_path = canonical_recovery_journal_path(path)?;
        let claim_path = recovery_claim_path(&canonical_path)?;
        if recovery_path_eq(path, &canonical_path) {
            let source = wide_null(path.as_os_str());
            let destination = wide_null(claim_path.as_os_str());
            if unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                let error = unsafe { GetLastError() };
                if matches!(error, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
                    || (error == ERROR_ALREADY_EXISTS
                        && !path.try_exists().map_err(RpcError::from)?)
                {
                    return Ok(None);
                }
                return Err(win32_code_error(
                    "MoveFileExW(claim sandbox recovery journal)",
                    error,
                ));
            }
        }
        let path_wide = wide_null(claim_path.as_os_str());
        let handle = unsafe {
            CreateFileW(
                path_wide.as_ptr(),
                FILE_GENERIC_READ | DELETE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            let error = unsafe { GetLastError() };
            if matches!(error, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
                return Ok(None);
            }
            return Err(win32_code_error(
                "CreateFileW(sandbox recovery claim)",
                error,
            ));
        }
        let handle = OwnedHandle(handle);
        let mut overlapped = OVERLAPPED::default();
        if unsafe {
            LockFileEx(
                handle.0,
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                u32::MAX,
                u32::MAX,
                &mut overlapped,
            )
        } == 0
        {
            let error = unsafe { GetLastError() };
            if error == ERROR_LOCK_VIOLATION {
                return Ok(None);
            }
            return Err(win32_code_error(
                "LockFileEx(sandbox recovery claim)",
                error,
            ));
        }
        let claim = Self {
            path: claim_path,
            canonical_path,
            handle,
        };
        claim.validate_file()?;
        Ok(Some(claim))
    }

    fn validate_file(&self) -> Result<(), RpcError> {
        let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                self.handle.0,
                FileAttributeTagInfo,
                (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        } == 0
        {
            return Err(last_error("GetFileInformationByHandleEx(recovery claim)"));
        }
        let information = acl_target_information(self.handle.0)?;
        let length =
            (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
        if tag.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) != 0
            || length > MAX_RECOVERY_JOURNAL_BYTES
        {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                format!("invalid sandbox recovery claim '{}'", self.path.display()),
            ));
        }
        Ok(())
    }

    fn read(&self) -> Result<Vec<u8>, RpcError> {
        let information = acl_target_information(self.handle.0)?;
        let length = ((u64::from(information.nFileSizeHigh) << 32)
            | u64::from(information.nFileSizeLow)) as usize;
        let mut bytes = vec![0_u8; length];
        let mut offset = 0;
        while offset < bytes.len() {
            let mut read = 0;
            if unsafe {
                ReadFile(
                    self.handle.0,
                    bytes[offset..].as_mut_ptr(),
                    (bytes.len() - offset).min(u32::MAX as usize) as u32,
                    &mut read,
                    null_mut(),
                )
            } == 0
            {
                return Err(last_error("ReadFile(sandbox recovery claim)"));
            }
            if read == 0 {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    "sandbox recovery claim was truncated while locked",
                ));
            }
            offset += read as usize;
        }
        Ok(bytes)
    }

    fn restore_canonical(self) -> Result<(), RpcError> {
        let source = wide_null(self.path.as_os_str());
        let destination = wide_null(self.canonical_path.as_os_str());
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(last_error(
                "MoveFileExW(release live sandbox recovery claim)",
            ));
        }
        Ok(())
    }

    fn remove(self) -> Result<(), RpcError> {
        remove_recovery_file(&self.path)
    }
}

impl Drop for RecoveryClaim {
    fn drop(&mut self) {
        let mut overlapped = OVERLAPPED::default();
        unsafe {
            UnlockFileEx(self.handle.0, 0, u32::MAX, u32::MAX, &mut overlapped);
        }
    }
}

fn recovery_claim_path(canonical: &Path) -> Result<PathBuf, RpcError> {
    let name = canonical
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| RpcError::new("sandbox_recovery_failed", "invalid recovery file name"))?;
    Ok(canonical.with_file_name(format!("{name}.claim")))
}

fn canonical_recovery_journal_path(path: &Path) -> Result<PathBuf, RpcError> {
    let name = path
        .file_name()
        .and_then(OsStr::to_str)
        .ok_or_else(|| RpcError::new("sandbox_recovery_failed", "invalid recovery file name"))?;
    let canonical_name = name.strip_suffix(".claim").unwrap_or(name);
    if !canonical_name.starts_with("sigmacode.exec.") || !canonical_name.ends_with(".json") {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!("invalid sandbox recovery journal name '{name}'"),
        ));
    }
    Ok(path.with_file_name(canonical_name))
}

struct RecoveryMutex(HANDLE);

impl RecoveryMutex {
    fn acquire(directory: &Path) -> Result<Self, RpcError> {
        let name = wide_null(recovery_mutex_name(directory));
        let handle = unsafe { CreateMutexW(null(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(last_error("CreateMutexW(sandbox recovery)"));
        }
        let wait = unsafe { WaitForSingleObject(handle, INFINITE) };
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            unsafe { CloseHandle(handle) };
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                format!("failed to serialize sandbox ACL transactions (wait result {wait})"),
            ));
        }
        Ok(Self(handle))
    }
}

fn recovery_mutex_name(directory: &Path) -> String {
    let identity = recovery_path_key(directory);
    let digest = Sha256::digest(identity.as_bytes());
    let suffix = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{RECOVERY_MUTEX_PREFIX}.{suffix}")
}

impl Drop for RecoveryMutex {
    fn drop(&mut self) {
        unsafe {
            ReleaseMutex(self.0);
            CloseHandle(self.0);
        }
    }
}

fn assert_acl_handle_target(
    handle: &OwnedHandle,
    expected: &Path,
    writable_root: Option<&Path>,
) -> Result<(), RpcError> {
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle.0,
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error("GetFileInformationByHandleEx"));
    }
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(RpcError::new(
            "policy_denied",
            format!(
                "sandbox ACL target is a reparse point: '{}'",
                expected.display()
            ),
        ));
    }
    let actual = final_handle_path(handle.0)?;
    let expected = expected.canonicalize().map_err(RpcError::from)?;
    if !actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy())
    {
        return Err(RpcError::new(
            "policy_denied",
            format!(
                "sandbox ACL target changed during validation: expected '{}', opened '{}'",
                expected.display(),
                actual.display()
            ),
        ));
    }
    if let Some(root) = writable_root {
        let root = root.canonicalize().map_err(RpcError::from)?;
        if !windows_path_within(&root, &actual) {
            return Err(RpcError::new(
                "policy_denied",
                format!(
                    "sandbox ACL target escaped writable root '{}': '{}'",
                    root.display(),
                    actual.display()
                ),
            ));
        }
    }
    Ok(())
}

fn assert_planned_acl_target(handle: &OwnedHandle, item: &PlannedAcl) -> Result<(), RpcError> {
    if let Some(target) = item.read_reparse_target.as_ref() {
        if item.writable_root.is_some() || item.inherit {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "read-only reparse ACL plan has an unsafe writable or inheritable shape",
            ));
        }
        assert_read_reparse_target(handle, &item.path, target)
    } else {
        assert_acl_handle_target(handle, &item.path, item.writable_root.as_deref())
    }
}

fn windows_path_within(root: &Path, candidate: &Path) -> bool {
    let root = windows_path_key(root);
    let candidate = windows_path_key(candidate);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
}

fn windows_path_eq(left: &Path, right: &Path) -> bool {
    windows_path_key(left) == windows_path_key(right)
}

fn windows_path_key(path: &Path) -> String {
    let value = path.to_string_lossy().replace('/', "\\");
    let value = if let Some(rest) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = value.strip_prefix("\\\\?\\") {
        rest.to_owned()
    } else {
        value
    };
    value.trim_end_matches('\\').to_lowercase()
}

fn final_handle_path(handle: HANDLE) -> Result<PathBuf, RpcError> {
    let required = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, VOLUME_NAME_DOS) };
    if required == 0 {
        return Err(last_error("GetFinalPathNameByHandleW(size)"));
    }
    let mut output = vec![0_u16; required as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            output.as_mut_ptr(),
            output.len() as u32,
            VOLUME_NAME_DOS,
        )
    };
    if written == 0 || written as usize >= output.len() {
        return Err(last_error("GetFinalPathNameByHandleW"));
    }
    let value = String::from_utf16_lossy(&output[..written as usize]);
    Ok(PathBuf::from(value))
}

fn acl_target_information(handle: HANDLE) -> Result<BY_HANDLE_FILE_INFORMATION, RpcError> {
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
        return Err(last_error("GetFileInformationByHandle(ACL target)"));
    }
    Ok(information)
}

fn acl_target_tag(handle: HANDLE) -> Result<FILE_ATTRIBUTE_TAG_INFO, RpcError> {
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error(
            "GetFileInformationByHandleEx(FileAttributeTagInfo)",
        ));
    }
    Ok(tag)
}

fn acl_target_identity(handle: HANDLE) -> Result<RecoveryFileIdentity, RpcError> {
    let mut information = FILE_ID_INFO::default();
    if unsafe {
        GetFileInformationByHandleEx(
            handle,
            FileIdInfo,
            (&mut information as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error("GetFileInformationByHandleEx(FileIdInfo)"));
    }
    Ok(RecoveryFileIdentity {
        volume_serial_number: information.VolumeSerialNumber,
        file_id: information.FileId.Identifier,
    })
}

fn assert_single_link_file(handle: &OwnedHandle, path: &Path) -> Result<(), RpcError> {
    let information = acl_target_information(handle.0)?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        && information.nNumberOfLinks != 1
    {
        return Err(RpcError::new(
            "policy_denied",
            format!(
                "writable sandbox files must have exactly one hard link before ACL changes: '{}'",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn process_creation_time(handle: HANDLE) -> Result<u64, RpcError> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(last_error("GetProcessTimes(recovery owner)"));
    }
    Ok((u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime))
}

fn current_process_identity() -> Result<(u32, u64), RpcError> {
    Ok((
        std::process::id(),
        process_creation_time(unsafe { GetCurrentProcess() })?,
    ))
}

fn recovery_owner_is_active(snapshot: &RecoverySnapshot) -> Result<bool, RpcError> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
            0,
            snapshot.owner_process_id,
        )
    };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        if error == ERROR_INVALID_PARAMETER {
            return Ok(false);
        }
        return Err(win32_code_error("OpenProcess(recovery owner)", error));
    }
    let handle = OwnedHandle(handle);
    recovery_process_handle_is_active(handle.0, snapshot.owner_process_creation_time)
}

fn recovery_process_handle_is_active(
    handle: HANDLE,
    expected_creation_time: u64,
) -> Result<bool, RpcError> {
    if process_creation_time(handle)? != expected_creation_time {
        return Ok(false);
    }
    match unsafe { WaitForSingleObject(handle, 0) } {
        WAIT_TIMEOUT => Ok(true),
        WAIT_OBJECT_0 => Ok(false),
        result => Err(RpcError::new(
            "sandbox_recovery_failed",
            format!("cannot determine sandbox recovery owner liveness (wait result {result})"),
        )),
    }
}

impl RecoveryJournal {
    fn create(directory: &Path, profile_name: &str) -> Result<Self, RpcError> {
        validate_ephemeral_profile_name(profile_name)?;
        std::fs::create_dir_all(directory).map_err(|error| {
            RpcError::new(
                "sandbox_recovery_failed",
                format!(
                    "cannot create sandbox recovery directory '{}': {error}",
                    directory.display()
                ),
            )
        })?;
        validate_recovery_directory(directory)?;
        let path = directory.join(recovery_journal_file_name(profile_name));
        let (owner_process_id, owner_process_creation_time) = current_process_identity()?;
        let journal = Self {
            directory: directory.to_owned(),
            path,
            snapshot: RecoverySnapshot {
                schema_version: RECOVERY_SCHEMA_VERSION,
                product: RECOVERY_PRODUCT.into(),
                profile_name: profile_name.into(),
                owner_process_id,
                owner_process_creation_time,
                entries: Vec::new(),
            },
        };
        journal.persist_atomic(false)?;
        Ok(journal)
    }

    fn prepare(&mut self, plan: &[PlannedAcl], sid: PSID) -> Result<(), RpcError> {
        if plan.len() > MAX_RECOVERY_ENTRIES {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "sandbox recovery journal contains too many ACL entries",
            ));
        }
        let mut writable_roots = HashMap::new();
        for root in plan.iter().filter_map(|item| item.writable_root.as_ref()) {
            let key = recovery_path_key(root);
            if writable_roots.contains_key(&key) {
                continue;
            }
            let handle = open_acl_target(root)?;
            assert_acl_handle_target(&handle, root, Some(root))?;
            let information = acl_target_information(handle.0)?;
            if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "sandbox write root must be a directory: '{}'",
                        root.display()
                    ),
                ));
            }
            let path = final_handle_path(handle.0)?;
            let identity = acl_target_identity(handle.0)?;
            writable_roots.insert(key, RecoveryRootIdentity { path, identity });
        }
        let mut entries = Vec::with_capacity(plan.len());
        for item in plan {
            if !allowed_recovery_acl(item.permissions, item.inherit) {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    "refusing to journal an unknown sandbox ACL shape",
                ));
            }
            let handle = open_acl_target(&item.path)?;
            assert_planned_acl_target(&handle, item)?;
            let information = acl_target_information(handle.0)?;
            if item.inherit && information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "inheritable sandbox ACL target is not a directory: '{}'",
                        item.path.display()
                    ),
                ));
            }
            if item.writable_root.is_some() {
                assert_single_link_file(&handle, &item.path)?;
            }
            let preexisting_ace_count = count_exact_acl_entries_for_handle(
                &handle,
                sid,
                item.permissions,
                expected_explicit_ace_flags(item.inherit),
            )?;
            let preexisting_sid_ace_count = count_allowed_acl_entries_for_handle(&handle, sid)?;
            let path = final_handle_path(handle.0)?;
            let identity = acl_target_identity(handle.0)?;
            let writable_root = item
                .writable_root
                .as_ref()
                .and_then(|root| writable_roots.get(&recovery_path_key(root)))
                .cloned();
            if item.writable_root.is_some() && writable_root.is_none() {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    "sandbox recovery root identity was not preflighted",
                ));
            }
            if writable_root
                .as_ref()
                .is_some_and(|root| !recovery_path_within(&path, &root.path))
            {
                return Err(RpcError::new(
                    "policy_denied",
                    format!(
                        "sandbox ACL target escaped its durable write root: '{}'",
                        item.path.display()
                    ),
                ));
            }
            entries.push(RecoveryAclEntry {
                path,
                identity,
                permissions: item.permissions,
                inherit: item.inherit,
                preexisting_ace_count,
                preexisting_sid_ace_count,
                read_reparse_target: item.read_reparse_target.clone(),
                writable_root,
            });
        }
        self.snapshot.entries = entries;
        self.persist()
    }

    fn apply(&self, plan: &[PlannedAcl], sid: PSID) -> Result<(), RpcError> {
        if plan.len() != self.snapshot.entries.len() {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "sandbox ACL plan no longer matches its durable journal",
            ));
        }
        // Apply descendants before ancestors. NtSetSecurityObject avoids tree
        // propagation, but setting a child's DACL after its parent has gained
        // an inheritable ACE lets Windows recompute that child as inherited.
        // Reverse order guarantees every pre-existing object receives the
        // explicit, journal-owned ACE described by its entry.
        for (item, entry) in plan.iter().zip(&self.snapshot.entries).rev() {
            let handle = open_acl_target(&item.path)?;
            assert_planned_acl_target(&handle, item)?;
            let information = acl_target_information(handle.0)?;
            if item.inherit && information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err(RpcError::new(
                    "policy_denied",
                    "inheritable sandbox ACL target changed type after journaling",
                ));
            }
            if item.writable_root.is_some() {
                assert_single_link_file(&handle, &item.path)?;
            }
            let actual = final_handle_path(handle.0)?;
            let identity = acl_target_identity(handle.0)?;
            if !recovery_path_eq(&actual, &entry.path) || identity != entry.identity {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    format!(
                        "sandbox ACL target identity changed after journaling: '{}'",
                        item.path.display()
                    ),
                ));
            }
            update_acl_handle(
                &handle,
                &item.path,
                sid,
                item.permissions,
                GRANT_ACCESS,
                item.inherit,
                item.propagate_inheritance,
            )?;
        }
        Ok(())
    }

    fn persist(&self) -> Result<(), RpcError> {
        self.persist_atomic(true)
    }

    fn persist_atomic(&self, replace_existing: bool) -> Result<(), RpcError> {
        let mut bytes = serde_json::to_vec(&self.snapshot).map_err(|error| {
            RpcError::new(
                "sandbox_recovery_failed",
                format!("cannot serialize sandbox recovery journal: {error}"),
            )
        })?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_RECOVERY_JOURNAL_BYTES {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "sandbox recovery journal exceeds its size limit",
            ));
        }
        let sequence = PROFILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let file_name = self
            .path
            .file_name()
            .and_then(OsStr::to_str)
            .ok_or_else(|| {
                RpcError::new("sandbox_recovery_failed", "invalid recovery file name")
            })?;
        let temporary = self.directory.join(format!(".{file_name}.{sequence}.tmp"));
        let write_result = (|| {
            let mut file = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            let source = wide_null(temporary.as_os_str());
            let destination = wide_null(self.path.as_os_str());
            let flags = MOVEFILE_WRITE_THROUGH
                | if replace_existing {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                };
            if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } == 0 {
                return Err(last_error("MoveFileExW(recovery journal)"));
            }
            Ok::<(), RpcError>(())
        })();
        if write_result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        write_result
    }

    fn remove(&self) -> Result<(), RpcError> {
        remove_recovery_file(&self.path)
    }
}

fn remove_recovery_file(path: &Path) -> Result<(), RpcError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "cannot remove completed recovery journal '{}': {error}",
                path.display()
            ),
        )),
    }
}

fn recovery_directory_for_sid(sid: PSID) -> Result<PathBuf, RpcError> {
    recovery_directory_from_appcontainer(&appcontainer_folder(sid)?)
}

fn base_recovery_directory() -> Result<PathBuf, RpcError> {
    let sid = derive_profile_sid(BASE_PROFILE)?;
    let result = recovery_directory_for_sid(sid);
    unsafe { FreeSid(sid) };
    result
}

fn recovery_directory_from_appcontainer(appcontainer_profile: &Path) -> Result<PathBuf, RpcError> {
    Ok(host_local_app_data(appcontainer_profile)?
        .join("SigmaCode")
        .join(RECOVERY_DIRECTORY))
}

fn host_local_app_data(appcontainer_profile: &Path) -> Result<PathBuf, RpcError> {
    let local_app_data = appcontainer_profile.ancestors().nth(3).ok_or_else(|| {
        RpcError::new(
            "sandbox_unavailable",
            format!(
                "AppContainer profile folder has an unexpected layout: '{}'",
                appcontainer_profile.display()
            ),
        )
    })?;
    if !local_app_data.join("Packages").is_dir() {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "AppContainer profile is outside a recognized LocalAppData root: '{}'",
                appcontainer_profile.display()
            ),
        ));
    }
    local_app_data.canonicalize().map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("cannot resolve the host LocalAppData directory: {error}"),
        )
    })
}

fn recovery_journal_file_name(profile_name: &str) -> String {
    format!("{}.json", profile_name.to_ascii_lowercase())
}

fn validate_ephemeral_profile_name(profile_name: &str) -> Result<(), RpcError> {
    let Some(suffix) = profile_name.strip_prefix("SigmaCode.Exec.") else {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "recovery journal profile is not a Sigma ephemeral profile",
        ));
    };
    let parts = suffix.split('.').collect::<Vec<_>>();
    if parts.len() != 2
        || parts[0].is_empty()
        || parts[0].len() > 10
        || !parts[0].bytes().all(|byte| byte.is_ascii_digit())
        || parts[1].len() != 32
        || !parts[1].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "recovery journal contains an invalid ephemeral profile name",
        ));
    }
    Ok(())
}

fn validate_recovery_directory(directory: &Path) -> Result<(), RpcError> {
    let product_directory = directory.parent().ok_or_else(|| {
        RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery directory has no product parent",
        )
    })?;
    let trusted_local_app_data = product_directory.parent().ok_or_else(|| {
        RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery directory has no trusted LocalAppData parent",
        )
    })?;
    let trusted = trusted_local_app_data
        .canonicalize()
        .map_err(RpcError::from)?;
    for (path, expected) in [
        (product_directory, trusted.join("SigmaCode")),
        (
            directory,
            trusted.join("SigmaCode").join(RECOVERY_DIRECTORY),
        ),
    ] {
        let metadata = std::fs::symlink_metadata(path).map_err(RpcError::from)?;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                format!(
                    "sandbox recovery path component must be a real directory: '{}'",
                    path.display()
                ),
            ));
        }
        let actual = path.canonicalize().map_err(RpcError::from)?;
        if !recovery_path_eq(&actual, &expected) {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                format!(
                    "sandbox recovery path escaped trusted LocalAppData: '{}'",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn validate_recovery_snapshot(
    snapshot: &RecoverySnapshot,
    journal_path: &Path,
) -> Result<(), RpcError> {
    if snapshot.schema_version != RECOVERY_SCHEMA_VERSION || snapshot.product != RECOVERY_PRODUCT {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery journal has an unsupported schema or product",
        ));
    }
    validate_ephemeral_profile_name(&snapshot.profile_name)?;
    let profile_pid = snapshot
        .profile_name
        .strip_prefix("SigmaCode.Exec.")
        .and_then(|suffix| suffix.split('.').next())
        .and_then(|value| value.parse::<u32>().ok());
    if profile_pid != Some(snapshot.owner_process_id) || snapshot.owner_process_creation_time == 0 {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery journal owner does not match its profile",
        ));
    }
    let expected_name = recovery_journal_file_name(&snapshot.profile_name);
    if journal_path.file_name().and_then(OsStr::to_str) != Some(expected_name.as_str()) {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery journal file name does not match its profile",
        ));
    }
    if snapshot.entries.len() > MAX_RECOVERY_ENTRIES {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox recovery journal contains too many entries",
        ));
    }
    for entry in &snapshot.entries {
        if !entry.path.is_absolute()
            || entry.identity.file_id == [0; 16]
            || !allowed_recovery_acl(entry.permissions, entry.inherit)
            || entry.preexisting_ace_count > entry.preexisting_sid_ace_count
            || entry.read_reparse_target.as_ref().is_some_and(|target| {
                !target.path.is_absolute()
                    || target.identity.file_id == [0; 16]
                    || entry.inherit
                    || entry.writable_root.is_some()
            })
            || entry.writable_root.as_ref().is_some_and(|root| {
                !root.path.is_absolute()
                    || root.identity.file_id == [0; 16]
                    || !recovery_path_within(&entry.path, &root.path)
            })
        {
            return Err(RpcError::new(
                "sandbox_recovery_failed",
                "sandbox recovery journal contains an invalid ACL entry",
            ));
        }
    }
    Ok(())
}

fn allowed_recovery_acl(permissions: u32, inherit: bool) -> bool {
    (permissions == (FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE) && !inherit)
        || permissions == (FILE_GENERIC_READ | FILE_GENERIC_EXECUTE)
        || (permissions == (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE))
}

fn recover_stale_profiles(directory: &Path) -> Result<(), RpcError> {
    if !directory.try_exists().map_err(RpcError::from)? {
        return Ok(());
    }
    let _mutex = RecoveryMutex::acquire(directory)?;
    validate_recovery_directory(directory)?;
    let mut journals = Vec::new();
    for entry in std::fs::read_dir(directory).map_err(RpcError::from)? {
        let path = entry.map_err(RpcError::from)?.path();
        let name = path.file_name().and_then(OsStr::to_str).unwrap_or_default();
        if name.starts_with(".sigmacode.exec.") && name.ends_with(".tmp") {
            let metadata = match std::fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(RpcError::from(error)),
            };
            if !metadata.is_file()
                || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
                || metadata.len() > MAX_RECOVERY_JOURNAL_BYTES
            {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    format!("invalid temporary recovery journal '{}'", path.display()),
                ));
            }
            // A temporary file is written and flushed before its atomic rename.
            // Never remove a complete temp owned by a live launcher. If a dead
            // launcher left a complete temp without the canonical journal, no
            // ACL application could have started, so deleting its profile is safe.
            if let Ok(bytes) = std::fs::read(&path)
                && let Ok(snapshot) = serde_json::from_slice::<RecoverySnapshot>(&bytes)
            {
                let canonical = directory.join(recovery_journal_file_name(&snapshot.profile_name));
                validate_recovery_snapshot(&snapshot, &canonical)?;
                let expected_prefix =
                    format!(".{}.", recovery_journal_file_name(&snapshot.profile_name));
                if !name.starts_with(&expected_prefix) {
                    return Err(RpcError::new(
                        "sandbox_recovery_failed",
                        format!(
                            "temporary recovery journal owner does not match its name: '{}'",
                            path.display()
                        ),
                    ));
                }
                if recovery_owner_is_active(&snapshot)? {
                    continue;
                }
                if !canonical.try_exists().map_err(RpcError::from)? {
                    delete_profile(&snapshot.profile_name)?;
                }
                remove_recovery_file(&path)?;
            }
            continue;
        }
        if name.starts_with("sigmacode.exec.")
            && (name.ends_with(".json") || name.ends_with(".json.claim"))
        {
            journals.push(path);
        }
    }
    journals.sort();
    for path in journals {
        let canonical = canonical_recovery_journal_path(&path)?;
        if recovery_path_eq(&path, &canonical) {
            let Some(snapshot) = read_recovery_snapshot(&path, &canonical)? else {
                continue;
            };
            if recovery_owner_is_active(&snapshot)? {
                continue;
            }
        }
        let Some(claim) = RecoveryClaim::acquire(&path)? else {
            continue;
        };
        let bytes = claim.read()?;
        let snapshot: RecoverySnapshot = serde_json::from_slice(&bytes).map_err(|error| {
            RpcError::new(
                "sandbox_recovery_failed",
                format!(
                    "invalid sandbox recovery journal '{}': {error}",
                    claim.path.display()
                ),
            )
        })?;
        validate_recovery_snapshot(&snapshot, &canonical)?;
        if recovery_owner_is_active(&snapshot)? {
            claim.restore_canonical()?;
            continue;
        }
        let sid = derive_profile_sid(&snapshot.profile_name)?;
        let cleanup = cleanup_recovery_snapshot(&snapshot, sid);
        unsafe { FreeSid(sid) };
        cleanup?;
        delete_profile(&snapshot.profile_name)?;
        claim.remove()?;
    }
    Ok(())
}

fn read_recovery_snapshot(
    path: &Path,
    canonical: &Path,
) -> Result<Option<RecoverySnapshot>, RpcError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(RpcError::from(error)),
    };
    if !metadata.is_file()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || metadata.len() > MAX_RECOVERY_JOURNAL_BYTES
    {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!("invalid sandbox recovery journal '{}'", path.display()),
        ));
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(RpcError::from(error)),
    };
    let snapshot = serde_json::from_slice::<RecoverySnapshot>(&bytes).map_err(|error| {
        RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "invalid sandbox recovery journal '{}': {error}",
                path.display()
            ),
        )
    })?;
    validate_recovery_snapshot(&snapshot, canonical)?;
    Ok(Some(snapshot))
}

fn cleanup_recovery_snapshot(snapshot: &RecoverySnapshot, sid: PSID) -> Result<(), RpcError> {
    let writable_roots = snapshot
        .entries
        .iter()
        .filter_map(|entry| entry.writable_root.as_ref())
        .fold(Vec::<RecoveryRootIdentity>::new(), |mut roots, root| {
            if !roots.iter().any(|item| item.identity == root.identity) {
                roots.push(root.clone());
            }
            roots
        });
    let mut located: Option<HashMap<RecoveryFileIdentity, PathBuf>> = None;
    for entry in snapshot.entries.iter().rev() {
        let original_path_exists = entry.path.try_exists().map_err(RpcError::from)?;
        let mut handle = open_matching_recovery_entry(&entry.path, entry, &writable_roots)?;
        if handle.is_none() {
            if entry.writable_root.is_none() {
                if !original_path_exists {
                    // Read-only roots and traversal-only ancestors cannot be
                    // renamed or deleted by the AppContainer. If the host
                    // removed one after a broker crash, its object (and ACE)
                    // is gone; treating that as deletion lets the next normal
                    // setup converge without weakening writable recovery.
                    continue;
                }
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    format!(
                        "sandbox ACL target identity changed without a controlled write root: '{}'",
                        entry.path.display()
                    ),
                ));
            }
            if located.is_none() {
                located = Some(scan_recovery_roots(&writable_roots)?);
            }
            if let Some(relocated) = located
                .as_ref()
                .and_then(|items| items.get(&entry.identity))
                .cloned()
            {
                handle = open_matching_recovery_entry(&relocated, entry, &writable_roots)?;
                if handle.is_none() {
                    return Err(RpcError::new(
                        "sandbox_recovery_failed",
                        format!(
                            "sandbox ACL target changed after recovery scan: '{}'",
                            relocated.display()
                        ),
                    ));
                }
            }
            // A complete, identity-checked scan of the durable write root is
            // positive evidence that an unlocated object was deleted. The
            // sandbox cannot move it outside that root, and pre-existing
            // external hard links are rejected before any ACL is changed.
        }
        if let Some(handle) = handle {
            remove_exact_acl_entry(
                &handle,
                sid,
                entry.permissions,
                entry.inherit,
                entry.preexisting_ace_count,
            )?;
        }
    }
    verify_recovery_scopes(snapshot, sid, &writable_roots)
}

fn verify_recovery_scopes(
    snapshot: &RecoverySnapshot,
    sid: PSID,
    writable_roots: &[RecoveryRootIdentity],
) -> Result<(), RpcError> {
    let mut baselines = HashMap::new();
    for entry in &snapshot.entries {
        match baselines.entry(entry.identity) {
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(entry.preexisting_sid_ace_count);
            }
            std::collections::hash_map::Entry::Occupied(slot)
                if *slot.get() != entry.preexisting_sid_ace_count =>
            {
                return Err(RpcError::new(
                    "sandbox_recovery_failed",
                    "sandbox recovery journal has conflicting SID baselines for one object",
                ));
            }
            std::collections::hash_map::Entry::Occupied(_) => {}
        }
    }

    let mut roots = writable_roots.to_vec();
    let inheritable_grants = snapshot
        .entries
        .iter()
        .filter(|entry| entry.inherit)
        .map(|entry| (entry.path.clone(), entry.permissions))
        .collect::<Vec<_>>();
    roots.extend(
        snapshot
            .entries
            .iter()
            .filter(|entry| entry.inherit && entry.writable_root.is_none())
            .map(|entry| RecoveryRootIdentity {
                path: entry.path.clone(),
                identity: entry.identity,
            }),
    );
    roots.sort_by(|left, right| {
        left.path
            .components()
            .count()
            .cmp(&right.path.components().count())
            .then_with(|| recovery_path_key(&left.path).cmp(&recovery_path_key(&right.path)))
    });
    let mut minimal_roots = Vec::<RecoveryRootIdentity>::new();
    for root in roots {
        if minimal_roots
            .iter()
            .any(|parent| recovery_path_within(&root.path, &parent.path))
        {
            continue;
        }
        minimal_roots.push(root);
    }

    let mut scanned = 0;
    for root in &minimal_roots {
        verify_recovery_scope(root, &baselines, &inheritable_grants, sid, &mut scanned)?;
    }
    Ok(())
}

fn verify_recovery_scope(
    root: &RecoveryRootIdentity,
    baselines: &HashMap<RecoveryFileIdentity, u32>,
    inheritable_grants: &[(PathBuf, u32)],
    sid: PSID,
    scanned: &mut usize,
) -> Result<(), RpcError> {
    if !root.path.try_exists().map_err(RpcError::from)? {
        return Ok(());
    }
    // Pin the root name and identity while walking it. Once its inheritable
    // ACE is gone, children created later cannot acquire the run SID.
    let root_handle = open_recovery_root_for_scan(&root.path)?;
    assert_acl_handle_target(&root_handle, &root.path, Some(&root.path))?;
    let information = acl_target_information(root_handle.0)?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
        || acl_target_identity(root_handle.0)? != root.identity
    {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox ACL verification root identity changed: '{}'",
                root.path.display()
            ),
        ));
    }
    verify_recovery_tree(
        &root.path,
        &root.path,
        baselines,
        inheritable_grants,
        sid,
        scanned,
        0,
    )?;
    if acl_target_identity(root_handle.0)? != root.identity {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox ACL verification root changed during the postcondition scan",
        ));
    }
    Ok(())
}

fn verify_recovery_tree(
    path: &Path,
    root: &Path,
    baselines: &HashMap<RecoveryFileIdentity, u32>,
    inheritable_grants: &[(PathBuf, u32)],
    sid: PSID,
    scanned: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    *scanned += 1;
    if *scanned > MAX_RECOVERY_ENTRIES || depth > MAX_RECOVERY_SCAN_DEPTH {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "sandbox ACL recovery verification exceeds traversal limits",
        ));
    }
    let handle = open_acl_target(path)?;
    let tag = acl_target_tag(handle.0)?;
    let is_reparse = tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    if is_reparse {
        assert_reparse_object_path(&handle, path, root)?;
    } else {
        assert_acl_handle_target(&handle, path, Some(root))?;
    }
    let information = acl_target_information(handle.0)?;
    let identity = acl_target_identity(handle.0)?;
    if !baselines.contains_key(&identity) {
        // Descendants created after the grant have no journal entry. Derive
        // their possible product-owned permissions only from inheritable
        // ancestor entries in the durable journal.
        let inherited_permissions = inheritable_grants
            .iter()
            .filter(|(grant_root, _)| recovery_path_within(path, grant_root))
            .map(|(_, permissions)| *permissions)
            .collect::<Vec<_>>();
        remove_inherited_sid_acl_entries(&handle, sid, &inherited_permissions)?;
    }
    let expected = baselines.get(&identity).copied().unwrap_or(0);
    let actual = count_allowed_acl_entries_for_handle(&handle, sid)?;
    if actual != expected {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox ACL recovery left a run-SID grant on '{}' (expected {expected}, found {actual})",
                path.display()
            ),
        ));
    }
    let is_directory = !is_reparse && information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    drop(handle);
    if !is_directory {
        return Ok(());
    }
    for child in std::fs::read_dir(path).map_err(|error| {
        RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "cannot enumerate sandbox ACL verification scope '{}': {error}",
                path.display()
            ),
        )
    })? {
        verify_recovery_tree(
            &child.map_err(RpcError::from)?.path(),
            root,
            baselines,
            inheritable_grants,
            sid,
            scanned,
            depth + 1,
        )?;
    }
    Ok(())
}

fn assert_reparse_object_path(
    handle: &OwnedHandle,
    path: &Path,
    root: &Path,
) -> Result<(), RpcError> {
    let expected = canonical_link_path(path)?;
    let actual = final_handle_path(handle.0)?;
    if !windows_path_eq(&expected, &actual) || !windows_path_within(root, &actual) {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "sandbox recovery reparse object escaped its verification scope: '{}'",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn open_matching_recovery_entry(
    path: &Path,
    entry: &RecoveryAclEntry,
    writable_roots: &[RecoveryRootIdentity],
) -> Result<Option<OwnedHandle>, RpcError> {
    if !path.try_exists().map_err(RpcError::from)? {
        return Ok(None);
    }
    let handle = open_acl_target(path)?;
    let actual = final_handle_path(handle.0)?;
    let identity = acl_target_identity(handle.0)?;
    if identity != entry.identity {
        return Ok(None);
    }
    if let Some(target) = entry.read_reparse_target.as_ref() {
        assert_read_reparse_target(&handle, path, target)?;
    }
    if entry.writable_root.as_ref().is_some_and(|_| {
        !writable_roots
            .iter()
            .any(|root| recovery_path_within(&actual, &root.path))
    }) {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "relocated sandbox ACL target escaped its durable write root: '{}'",
                actual.display()
            ),
        ));
    }
    Ok(Some(handle))
}

fn scan_recovery_roots(
    roots: &[RecoveryRootIdentity],
) -> Result<HashMap<RecoveryFileIdentity, PathBuf>, RpcError> {
    let mut located = HashMap::new();
    let mut scanned = 0;
    for root in roots {
        scan_recovery_root(root, &mut located, &mut scanned)?;
    }
    Ok(located)
}

fn scan_recovery_root(
    root: &RecoveryRootIdentity,
    located: &mut HashMap<RecoveryFileIdentity, PathBuf>,
    scanned: &mut usize,
) -> Result<(), RpcError> {
    if !root.path.try_exists().map_err(RpcError::from)? {
        // A sandbox can relocate a root only into another declared writable
        // root; scan every surviving root before concluding its identities
        // were deleted. If the host removed the complete workspace after a
        // broker crash, the vanished objects no longer carry ACLs and recovery
        // can still converge.
        return Ok(());
    }
    let handle = open_recovery_root_for_scan(&root.path)?;
    assert_acl_handle_target(&handle, &root.path, Some(&root.path))?;
    let information = acl_target_information(handle.0)?;
    let identity = acl_target_identity(handle.0)?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 || identity != root.identity {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "durable sandbox write root identity changed before recovery: '{}'",
                root.path.display()
            ),
        ));
    }
    scan_recovery_tree(&root.path, &root.path, located, scanned, 0)?;
    let final_identity = acl_target_identity(handle.0)?;
    if final_identity != root.identity {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "durable sandbox write root changed during recovery scan",
        ));
    }
    Ok(())
}

fn scan_recovery_tree(
    path: &Path,
    root: &Path,
    located: &mut HashMap<RecoveryFileIdentity, PathBuf>,
    scanned: &mut usize,
    depth: usize,
) -> Result<(), RpcError> {
    *scanned += 1;
    if *scanned > MAX_RECOVERY_ENTRIES || depth > MAX_RECOVERY_SCAN_DEPTH {
        return Err(RpcError::new(
            "sandbox_recovery_failed",
            "durable sandbox write root exceeds recovery scan limits",
        ));
    }
    let handle = open_acl_target(path)?;
    assert_acl_handle_target(&handle, path, Some(root))?;
    let actual = final_handle_path(handle.0)?;
    let information = acl_target_information(handle.0)?;
    let identity = acl_target_identity(handle.0)?;
    located.entry(identity).or_insert(actual);
    let is_directory = information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
    drop(handle);
    if !is_directory {
        return Ok(());
    }
    for child in std::fs::read_dir(path).map_err(|error| {
        RpcError::new(
            "sandbox_recovery_failed",
            format!(
                "cannot scan durable sandbox write root '{}': {error}",
                path.display()
            ),
        )
    })? {
        scan_recovery_tree(
            &child.map_err(RpcError::from)?.path(),
            root,
            located,
            scanned,
            depth + 1,
        )?;
    }
    Ok(())
}

fn recovery_path_eq(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn recovery_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn recovery_path_within(candidate: &Path, root: &Path) -> bool {
    let candidate = recovery_path_key(candidate);
    let root = recovery_path_key(root);
    candidate == root || candidate.starts_with(&format!("{root}\\"))
}

fn launch_appcontainer(params: &ProcessParams, sid: PSID) -> Result<i32, RpcError> {
    let executable = resolve_executable(params)?;
    let mut command_line = windows_command_line(&executable, &params.command.args);
    let cwd = wide_null(params.command.cwd.as_os_str());
    let profile_folder = appcontainer_folder(sid)?;
    let environment = environment_block(&params.command.env, &profile_folder)?;
    let stdin = std_handle(STD_INPUT_HANDLE)?;
    let stdout = std_handle(STD_OUTPUT_HANDLE)?;
    let stderr = std_handle(STD_ERROR_HANDLE)?;
    let mut capability_storage = capability_sids(params.policy.network == NetworkMode::Full)?;
    let mut capability_entries = capability_storage
        .iter_mut()
        .map(|bytes| SID_AND_ATTRIBUTES {
            Sid: bytes.as_mut_ptr().cast(),
            Attributes: SE_GROUP_ENABLED,
        })
        .collect::<Vec<_>>();
    let security = SECURITY_CAPABILITIES {
        AppContainerSid: sid,
        Capabilities: capability_entries.as_mut_ptr(),
        CapabilityCount: capability_entries.len() as u32,
        Reserved: 0,
    };
    let mut pseudo = params
        .pty
        .then(|| PseudoConsole::new(params.pty_columns, params.pty_rows))
        .transpose()?;
    let mut inherited_handles = [stdin, stdout, stderr];
    let mut attributes = AttributeList::new(3)?;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES as usize,
        (&security as *const SECURITY_CAPABILITIES).cast(),
        size_of::<SECURITY_CAPABILITIES>(),
    )?;
    let all_application_packages_policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    attributes.update(
        PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY as usize,
        (&all_application_packages_policy as *const u32).cast(),
        size_of::<u32>(),
    )?;
    if let Some(console) = pseudo.as_ref() {
        attributes.update(
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            console.handle as *const c_void,
            size_of::<HPCON>(),
        )?;
    } else {
        for handle in inherited_handles {
            if unsafe {
                windows_sys::Win32::Foundation::SetHandleInformation(
                    handle,
                    HANDLE_FLAG_INHERIT,
                    HANDLE_FLAG_INHERIT,
                )
            } == 0
            {
                return Err(last_error("SetHandleInformation"));
            }
        }
        attributes.update(
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            inherited_handles.as_mut_ptr().cast(),
            size_of_val(&inherited_handles),
        )?;
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    if pseudo.is_none() {
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdin;
        startup.StartupInfo.hStdOutput = stdout;
        startup.StartupInfo.hStdError = stderr;
    }
    startup.lpAttributeList = attributes.pointer();
    let mut process = PROCESS_INFORMATION::default();
    let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED;
    let created = unsafe {
        CreateProcessW(
            null(),
            command_line.as_mut_ptr(),
            null(),
            null(),
            i32::from(pseudo.is_none()),
            flags,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if created == 0 {
        return Err(last_error("CreateProcessW(AppContainer)"));
    }
    let process_handles = ProcessHandles(process);
    let mut in_broker_job = 0;
    if unsafe { IsProcessInJob(process_handles.0.hProcess, null_mut(), &mut in_broker_job) } == 0
        || in_broker_job == 0
    {
        unsafe { TerminateProcess(process_handles.0.hProcess, 125) };
        return Err(RpcError::new(
            "process_containment_failed",
            "AppContainer child did not inherit the broker Job Object",
        ));
    }
    if unsafe { ResumeThread(process_handles.0.hThread) } == u32::MAX {
        unsafe { TerminateProcess(process_handles.0.hProcess, 125) };
        return Err(last_error("ResumeThread"));
    }
    let output_proxy = if let Some(console) = pseudo.as_mut() {
        Some(console.start_proxy(stdin, stdout)?)
    } else {
        None
    };
    let waited = unsafe { WaitForSingleObject(process_handles.0.hProcess, INFINITE) };
    if waited != WAIT_OBJECT_0 {
        return Err(RpcError::new(
            "process_containment_failed",
            format!("waiting for AppContainer process failed (wait result {waited})"),
        ));
    }
    let mut exit_code = 125;
    if unsafe { GetExitCodeProcess(process_handles.0.hProcess, &mut exit_code) } == 0 {
        return Err(last_error("GetExitCodeProcess"));
    }
    if let Some(console) = pseudo.as_mut() {
        console.close_session();
    }
    if let Some(proxy) = output_proxy {
        let _ = proxy.join();
    }
    Ok(exit_code as i32)
}

struct PseudoConsole {
    handle: HPCON,
    input_read: HANDLE,
    input_write: HANDLE,
    output_read: HANDLE,
    output_write: HANDLE,
}

impl PseudoConsole {
    fn new(columns: u16, rows: u16) -> Result<Self, RpcError> {
        let mut input_read = null_mut();
        let mut input_write = null_mut();
        let mut output_read = null_mut();
        let mut output_write = null_mut();
        if unsafe { CreatePipe(&mut input_read, &mut input_write, null(), 0) } == 0 {
            return Err(last_error("CreatePipe(ConPTY input)"));
        }
        if unsafe { CreatePipe(&mut output_read, &mut output_write, null(), 0) } == 0 {
            unsafe {
                CloseHandle(input_read);
                CloseHandle(input_write);
            }
            return Err(last_error("CreatePipe(ConPTY output)"));
        }
        let mut handle: HPCON = 0;
        let result = unsafe {
            CreatePseudoConsole(
                COORD {
                    X: columns as i16,
                    Y: rows as i16,
                },
                input_read,
                output_write,
                0,
                &mut handle,
            )
        };
        if result < 0 || handle == 0 {
            unsafe {
                CloseHandle(input_read);
                CloseHandle(input_write);
                CloseHandle(output_read);
                CloseHandle(output_write);
            }
            return Err(RpcError::new(
                "pty_unavailable",
                format!(
                    "CreatePseudoConsole failed with HRESULT 0x{:08x}",
                    result as u32
                ),
            ));
        }
        Ok(Self {
            handle,
            input_read,
            input_write,
            output_read,
            output_write,
        })
    }

    fn start_proxy(
        &mut self,
        launcher_input: HANDLE,
        launcher_output: HANDLE,
    ) -> Result<std::thread::JoinHandle<()>, RpcError> {
        close_handle(&mut self.input_read);
        close_handle(&mut self.output_write);
        let input_write = std::mem::replace(&mut self.input_write, null_mut()) as isize;
        let output_read = std::mem::replace(&mut self.output_read, null_mut()) as isize;
        let input_source = launcher_input as isize;
        let output_target = launcher_output as isize;
        std::thread::spawn(move || {
            copy_handle(input_source as HANDLE, input_write as HANDLE);
            unsafe {
                CloseHandle(input_write as HANDLE);
            }
        });
        Ok(std::thread::spawn(move || {
            copy_handle(output_read as HANDLE, output_target as HANDLE);
            unsafe {
                CloseHandle(output_read as HANDLE);
            }
        }))
    }

    fn close_session(&mut self) {
        if self.handle != 0 {
            unsafe {
                ClosePseudoConsole(self.handle);
            }
            self.handle = 0;
        }
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        self.close_session();
        close_handle(&mut self.input_read);
        close_handle(&mut self.input_write);
        close_handle(&mut self.output_read);
        close_handle(&mut self.output_write);
    }
}

fn close_handle(handle: &mut HANDLE) {
    if !handle.is_null() && *handle != INVALID_HANDLE_VALUE {
        unsafe {
            CloseHandle(*handle);
        }
        *handle = null_mut();
    }
}

fn copy_handle(input: HANDLE, output: HANDLE) {
    let mut buffer = [0_u8; 8192];
    loop {
        let mut read = 0;
        if unsafe {
            ReadFile(
                input,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                null_mut(),
            )
        } == 0
            || read == 0
        {
            return;
        }
        let mut offset = 0;
        while offset < read as usize {
            let mut written = 0;
            if unsafe {
                WriteFile(
                    output,
                    buffer[offset..read as usize].as_ptr(),
                    (read as usize - offset) as u32,
                    &mut written,
                    null_mut(),
                )
            } == 0
                || written == 0
            {
                return;
            }
            offset += written as usize;
        }
    }
}

struct AttributeList {
    storage: Vec<usize>,
}

impl AttributeList {
    fn new(count: u32) -> Result<Self, RpcError> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(last_error("InitializeProcThreadAttributeList(size)"));
        }
        let words = bytes.div_ceil(size_of::<usize>());
        let mut value = Self {
            storage: vec![0; words],
        };
        if unsafe { InitializeProcThreadAttributeList(value.pointer(), count, 0, &mut bytes) } == 0
        {
            return Err(last_error("InitializeProcThreadAttributeList"));
        }
        Ok(value)
    }

    fn pointer(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr().cast()
    }

    fn update(
        &mut self,
        attribute: usize,
        value: *const c_void,
        bytes: usize,
    ) -> Result<(), RpcError> {
        if unsafe {
            UpdateProcThreadAttribute(
                self.pointer(),
                0,
                attribute,
                value,
                bytes,
                null_mut(),
                null(),
            )
        } == 0
        {
            return Err(last_error("UpdateProcThreadAttribute"));
        }
        Ok(())
    }
}

impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.pointer());
        }
    }
}

struct ProcessHandles(PROCESS_INFORMATION);

impl Drop for ProcessHandles {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0.hThread);
            CloseHandle(self.0.hProcess);
        }
    }
}

fn capability_sids(full_network: bool) -> Result<Vec<Vec<u8>>, RpcError> {
    // LPAC deliberately ignores ALL_APPLICATION_PACKAGES. Winsock's provider catalog is
    // readable through the built-in registryRead capability; without it WSAStartup fails
    // before runtimes such as Node can even parse their command line. registryRead does not
    // grant a network capability: AppContainer network isolation still denies sockets when
    // policy.network is none (covered by the real self-test and release smoke).
    let mut capabilities = vec![derive_capability_sid("registryRead")?];
    if full_network {
        capabilities.extend(
            [
                WinCapabilityInternetClientSid,
                WinCapabilityInternetClientServerSid,
                WinCapabilityPrivateNetworkClientServerSid,
            ]
            .into_iter()
            .map(|kind| {
                let mut bytes = vec![0_u8; 68];
                let mut length = bytes.len() as u32;
                if unsafe {
                    CreateWellKnownSid(kind, null_mut(), bytes.as_mut_ptr().cast(), &mut length)
                } == 0
                {
                    return Err(last_error("CreateWellKnownSid(network capability)"));
                }
                bytes.truncate(length as usize);
                Ok(bytes)
            })
            .collect::<Result<Vec<_>, _>>()?,
        );
    }
    Ok(capabilities)
}

fn derive_capability_sid(name: &str) -> Result<Vec<u8>, RpcError> {
    let capability_name = name;
    let wide_name = wide_null(capability_name);
    let mut group_sids: *mut PSID = null_mut();
    let mut group_count = 0_u32;
    let mut capability_sids: *mut PSID = null_mut();
    let mut capability_count = 0_u32;
    if unsafe {
        DeriveCapabilitySidsFromName(
            wide_name.as_ptr(),
            &mut group_sids,
            &mut group_count,
            &mut capability_sids,
            &mut capability_count,
        )
    } == 0
    {
        return Err(last_error("DeriveCapabilitySidsFromName"));
    }

    let result = if capability_count == 1 && !capability_sids.is_null() {
        let sid = unsafe { *capability_sids };
        if sid.is_null() {
            Err(RpcError::new(
                "sandbox_unavailable",
                format!("capability '{capability_name}' returned a null SID"),
            ))
        } else {
            let length = unsafe { GetLengthSid(sid) } as usize;
            if length == 0 {
                Err(last_error("GetLengthSid"))
            } else {
                Ok(unsafe { std::slice::from_raw_parts(sid.cast::<u8>(), length) }.to_vec())
            }
        }
    } else {
        Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "capability derivation returned {capability_count} SIDs; exactly one is required"
            ),
        ))
    };

    unsafe {
        if !group_sids.is_null() {
            for index in 0..group_count as usize {
                let sid = *group_sids.add(index);
                if !sid.is_null() {
                    LocalFree(sid.cast());
                }
            }
            LocalFree(group_sids.cast());
        }
        if !capability_sids.is_null() {
            for index in 0..capability_count as usize {
                let sid = *capability_sids.add(index);
                if !sid.is_null() {
                    LocalFree(sid.cast());
                }
            }
            LocalFree(capability_sids.cast());
        }
    }
    result
}

fn resolve_executable(params: &ProcessParams) -> Result<PathBuf, RpcError> {
    let requested = PathBuf::from(&params.command.executable);
    let mut candidates = Vec::new();
    if requested.is_absolute() {
        candidates.push(requested);
    } else if requested.components().count() > 1 {
        candidates.push(params.command.cwd.join(requested));
    } else {
        let extensions = env_value(&params.command.env, "PATHEXT")
            .unwrap_or(".COM;.EXE;.BAT;.CMD")
            .split(';')
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let names = if Path::new(&params.command.executable).extension().is_some() {
            vec![params.command.executable.clone()]
        } else {
            extensions
                .iter()
                .map(|extension| format!("{}{}", params.command.executable, extension))
                .collect()
        };
        if let Some(system_root) = env_value(&params.command.env, "SystemRoot") {
            candidates.extend(
                names
                    .iter()
                    .map(|name| Path::new(system_root).join("System32").join(name)),
            );
        }
        if let Some(search) = env_value(&params.command.env, "PATH") {
            for directory in std::env::split_paths(OsStr::new(search)) {
                candidates.extend(names.iter().map(|name| directory.join(name)));
            }
        }
    }
    let resolved = candidates
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
        .ok_or_else(|| {
            RpcError::new(
                "executable_not_found",
                format!("cannot resolve executable '{}'", params.command.executable),
            )
        })?;
    authorize_executable(params, &resolved)?;
    Ok(resolved)
}

fn authorize_executable(params: &ProcessParams, executable: &Path) -> Result<(), RpcError> {
    let explicitly_trusted = canonical_unique(&params.policy.execution_roots)?
        .iter()
        .any(|root| windows_path_within(root, executable));
    let broker_self = std::env::current_exe()
        .ok()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|path| windows_path_within(&path, executable));
    let verified_shell =
        verified_cmd_executable().is_some_and(|path| windows_path_within(&path, executable));
    if explicitly_trusted || broker_self || verified_shell {
        return Ok(());
    }
    Err(RpcError::new(
        "policy_denied",
        format!(
            "resolved executable '{}' is not a verified shell or inside a declared execution root",
            executable.display()
        ),
    ))
}

pub(crate) fn verified_cmd_executable() -> Option<PathBuf> {
    let mut buffer = vec![0_u16; 32_768];
    let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
    if length == 0 || length >= buffer.len() {
        return None;
    }
    PathBuf::from(String::from_utf16(&buffer[..length]).ok()?)
        .join("cmd.exe")
        .canonicalize()
        .ok()
}

fn environment_block(
    environment: &BTreeMap<String, String>,
    profile_folder: &Path,
) -> Result<Vec<u16>, RpcError> {
    let mut entries = environment
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.to_ascii_uppercase().as_str(),
                "APPDATA" | "HOME" | "LOCALAPPDATA" | "TEMP" | "TMP" | "USERPROFILE"
            )
        })
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>();
    // CreateProcess rewrites paths below the host LocalAppData directory into the
    // per-profile AppContainer storage. Passing the already redirected profile path
    // would therefore redirect it a second time (..\AC\Packages\<profile>\AC\Temp).
    // Seed the host roots and let Windows produce the unique writable AC\Temp path.
    let local_app_data = host_local_app_data(profile_folder)?;
    let host_temp = local_app_data.join("Temp");
    entries.push(format!("LOCALAPPDATA={}", local_app_data.to_string_lossy()));
    entries.push(format!("TEMP={}", host_temp.to_string_lossy()));
    entries.push(format!("TMP={}", host_temp.to_string_lossy()));
    entries.sort_by_key(|value| value.to_ascii_lowercase());
    let mut block = Vec::new();
    for entry in entries {
        block.extend(OsStr::new(&entry).encode_wide());
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

fn appcontainer_folder(sid: PSID) -> Result<PathBuf, RpcError> {
    let mut sid_string = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut sid_string) } == 0 {
        return Err(last_error("ConvertSidToStringSidW"));
    }
    let mut folder = null_mut();
    let result = unsafe { GetAppContainerFolderPath(sid_string, &mut folder) };
    unsafe {
        LocalFree(sid_string.cast());
    }
    if result < 0 || folder.is_null() {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "GetAppContainerFolderPath failed with HRESULT 0x{:08x}",
                result as u32
            ),
        ));
    }
    let length = unsafe {
        let mut count = 0;
        while *folder.add(count) != 0 {
            count += 1;
        }
        count
    };
    let value = PathBuf::from(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(folder, length)
    }));
    unsafe {
        CoTaskMemFree(folder.cast());
    }
    Ok(value)
}

fn env_value<'a>(environment: &'a BTreeMap<String, String>, key: &str) -> Option<&'a str> {
    environment
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(key))
        .map(|(_, value)| value.as_str())
}

fn windows_command_line(executable: &Path, arguments: &[String]) -> Vec<u16> {
    let mut values = Vec::with_capacity(arguments.len() + 1);
    values.push(executable.to_string_lossy().into_owned());
    values.extend(arguments.iter().cloned());
    let line = values
        .iter()
        .map(|value| quote_windows_argument(value))
        .collect::<Vec<_>>()
        .join(" ");
    wide_null(line)
}

fn quote_windows_argument(argument: &str) -> String {
    if !argument.is_empty()
        && !argument
            .chars()
            .any(|character| character.is_whitespace() || character == '"')
    {
        return argument.into();
    }
    let mut result = String::from("\"");
    let mut backslashes = 0;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else if character == '"' {
            result.push_str(&"\\".repeat(backslashes * 2 + 1));
            result.push('"');
            backslashes = 0;
        } else {
            result.push_str(&"\\".repeat(backslashes));
            backslashes = 0;
            result.push(character);
        }
    }
    result.push_str(&"\\".repeat(backslashes * 2));
    result.push('"');
    result
}

fn read_bootstrap() -> Result<Vec<u8>, RpcError> {
    let input = std_handle(STD_INPUT_HANDLE)?;
    let mut header = [0_u8; 4];
    read_handle_exact(input, &mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > MAX_BOOTSTRAP_BYTES {
        return Err(RpcError::new(
            "broker_protocol_error",
            format!("invalid Windows sandbox bootstrap length {length}"),
        ));
    }
    let mut payload = vec![0_u8; length];
    read_handle_exact(input, &mut payload)?;
    Ok(payload)
}

fn read_handle_exact(handle: HANDLE, mut output: &mut [u8]) -> Result<(), RpcError> {
    while !output.is_empty() {
        let requested = output.len().min(u32::MAX as usize) as u32;
        let mut read = 0;
        if unsafe {
            ReadFile(
                handle,
                output.as_mut_ptr(),
                requested,
                &mut read,
                null_mut(),
            )
        } == 0
        {
            return Err(last_error("ReadFile(sandbox bootstrap)"));
        }
        if read == 0 {
            return Err(RpcError::new(
                "broker_protocol_error",
                "unexpected EOF reading Windows sandbox bootstrap",
            ));
        }
        output = &mut output[read as usize..];
    }
    Ok(())
}

fn std_handle(kind: u32) -> Result<HANDLE, RpcError> {
    let handle = unsafe { GetStdHandle(kind) };
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(last_error("GetStdHandle"));
    }
    Ok(handle)
}

fn self_test() -> Result<(), RpcError> {
    let unique = ephemeral_profile_name()?.replace('.', "-");
    let root = std::env::temp_dir().join(format!("sigma-sandbox-test-{unique}"));
    let outside = std::env::temp_dir().join(format!("sigma-host-secret-{unique}.txt"));
    let all_packages = std::env::temp_dir().join(format!("sigma-all-packages-{unique}.txt"));
    let network_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(RpcError::from)?;
    let network_probe_port = network_listener
        .local_addr()
        .map_err(RpcError::from)?
        .port();
    std::fs::create_dir_all(root.join(".git")).map_err(RpcError::from)?;
    std::fs::create_dir_all(root.join(".agent")).map_err(RpcError::from)?;
    std::fs::write(root.join(".git").join("sentinel"), b"protected").map_err(RpcError::from)?;
    std::fs::write(&outside, b"host-secret").map_err(RpcError::from)?;
    std::fs::write(&all_packages, b"regular-appcontainer-readable").map_err(RpcError::from)?;
    let mut all_packages_sid = vec![0_u8; 68];
    let mut all_packages_sid_bytes = all_packages_sid.len() as u32;
    if unsafe {
        CreateWellKnownSid(
            WinBuiltinAnyPackageSid,
            null_mut(),
            all_packages_sid.as_mut_ptr().cast(),
            &mut all_packages_sid_bytes,
        )
    } == 0
    {
        return Err(last_error("CreateWellKnownSid(ALL APPLICATION PACKAGES)"));
    }
    update_acl(
        &all_packages,
        all_packages_sid.as_mut_ptr().cast(),
        FILE_GENERIC_READ,
        GRANT_ACCESS,
        false,
    )?;
    let _cleanup = SelfTestCleanup {
        root: root.clone(),
        outside: outside.clone(),
        all_packages: all_packages.clone(),
    };
    let mut env = BTreeMap::new();
    for key in ["SystemRoot", "WINDIR", "PATH", "PATHEXT", "USERPROFILE"] {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.into(), value);
        }
    }
    env.insert(
        "SIGMA_PROBE_ALLOWED".into(),
        root.to_string_lossy().into_owned(),
    );
    env.insert(
        "SIGMA_PROBE_OUTSIDE".into(),
        outside.to_string_lossy().into_owned(),
    );
    env.insert(
        "SIGMA_PROBE_ALL_PACKAGES".into(),
        all_packages.to_string_lossy().into_owned(),
    );
    env.insert(
        "SIGMA_PROBE_NETWORK_PORT".into(),
        network_probe_port.to_string(),
    );
    let params = ProcessParams {
        command: crate::sandbox::CommandSpec {
            executable: std::env::current_exe()
                .map_err(RpcError::from)?
                .to_string_lossy()
                .into_owned(),
            args: vec![INTERNAL_PROBE.into()],
            cwd: root.clone(),
            env,
            stdin: None,
        },
        policy: crate::sandbox::ExecutionPolicy {
            sandbox: SandboxMode::Required,
            network: NetworkMode::None,
            network_approved: false,
            read_roots: vec![root.clone()],
            write_roots: vec![root.clone()],
            execution_roots: Vec::new(),
            protected_paths: vec![root.join(".git"), root.join(".agent")],
            unsafe_host_exec_approved: false,
        },
        max_output_bytes: 64 * 1024,
        timeout_ms: Some(15_000),
        idle_timeout_ms: None,
        pty: false,
        pty_columns: 120,
        pty_rows: 30,
    };
    let output = run_self_test_process(&params)?;
    if !output.status.success() {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "AppContainer self-test exited with {:?}: stdout={} stderr={}",
                output.status.code(),
                String::from_utf8_lossy(&output.stdout).trim(),
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    let report: Value = serde_json::from_slice(&output.stdout).map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("AppContainer self-test returned invalid output: {error}"),
        )
    })?;
    let passed = report.get("isAppContainer") == Some(&Value::Bool(true))
        && report.get("allApplicationPackagesReadDenied") == Some(&Value::Bool(true))
        && report.get("allowedWrite") == Some(&Value::Bool(true))
        && report.get("outsideReadDenied") == Some(&Value::Bool(true))
        && report.get("outsideWriteDenied") == Some(&Value::Bool(true))
        && report.get("networkDenied") == Some(&Value::Bool(true))
        && report.get("gitWriteDenied") == Some(&Value::Bool(true))
        && report.get("agentWriteDenied") == Some(&Value::Bool(true));
    if !passed {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!("AppContainer isolation self-test failed: {report}"),
        ));
    }
    let mut pty_params = params.clone();
    pty_params.pty = true;
    pty_params.command.executable = verified_cmd_executable()
        .map(|path| path.to_string_lossy().into_owned())
        .ok_or_else(|| {
            RpcError::new(
                "sandbox_unavailable",
                "ConPTY self-test cannot resolve cmd.exe",
            )
        })?;
    pty_params.command.args = vec![
        "/d".into(),
        "/s".into(),
        "/c".into(),
        "echo sigma-conpty-self-test".into(),
    ];
    let pty_output = run_self_test_process(&pty_params)?;
    let pty_text = String::from_utf8_lossy(&pty_output.stdout);
    if !pty_output.status.success() || !pty_text.contains("sigma-conpty-self-test") {
        return Err(RpcError::new(
            "sandbox_unavailable",
            format!(
                "ConPTY AppContainer self-test failed (code={:?}, stdout={}, stderr={})",
                pty_output.status.code(),
                pty_text.trim(),
                String::from_utf8_lossy(&pty_output.stderr).trim()
            ),
        ));
    }
    Ok(())
}

struct SelfTestCleanup {
    root: PathBuf,
    outside: PathBuf,
    all_packages: PathBuf,
}

impl Drop for SelfTestCleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
        let _ = std::fs::remove_file(&self.outside);
        let _ = std::fs::remove_file(&self.all_packages);
        let _ = std::fs::remove_file(self.outside.with_extension("write"));
    }
}

fn run_self_test_process(params: &ProcessParams) -> Result<std::process::Output, RpcError> {
    let mut prepared = prepare_command(params)?;
    let mut child = prepared.command.spawn().map_err(|error| {
        RpcError::new(
            "sandbox_unavailable",
            format!("sandbox self-test launcher failed: {error}"),
        )
    })?;
    let guard = PlatformGuard::attach(&mut child, true)?;
    let mut stdin = child.stdin.take().ok_or_else(|| {
        RpcError::new(
            "sandbox_unavailable",
            "sandbox self-test stdin is unavailable",
        )
    })?;
    stdin.write_all(&prepared.bootstrap_stdin)?;
    let output = if params.pty {
        let output = child.wait_with_output().map_err(RpcError::from)?;
        drop(stdin);
        output
    } else {
        drop(stdin);
        child.wait_with_output().map_err(RpcError::from)?
    };
    drop(guard);
    Ok(output)
}

fn run_probe() -> i32 {
    let report = probe_report();
    println!("{}", Value::Object(report.clone()));
    if report
        .iter()
        .filter(|(name, _)| name.as_str() != "tokenReportsLpac")
        .all(|(_, value)| value == &Value::Bool(true))
    {
        0
    } else {
        1
    }
}

fn run_containment_probe() -> i32 {
    let report = containment_report();
    println!("{report}");
    i32::from(!containment_report_passed(&report))
}

fn containment_report() -> Value {
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    let mut in_job = 0;
    let job_query_succeeded =
        unsafe { IsProcessInJob(GetCurrentProcess(), null_mut(), &mut in_job) } != 0;
    let is_appcontainer = is_appcontainer_token();
    let token_reports_lpac = is_less_privileged_appcontainer_token();
    let token_has_lpac_attribute = token_has_lpac_attribute();
    let in_job = job_query_succeeded && in_job != 0;
    serde_json::json!({
        "isAppContainer": is_appcontainer,
        "tokenReportsLpac": token_reports_lpac,
        "tokenHasLpacAttribute": token_has_lpac_attribute,
        "inJob": in_job,
    })
}

fn containment_report_passed(report: &Value) -> bool {
    report.get("isAppContainer") == Some(&Value::Bool(true))
        && report.get("tokenHasLpacAttribute") == Some(&Value::Bool(true))
        && report.get("inJob") == Some(&Value::Bool(true))
}

fn token_has_lpac_attribute() -> bool {
    use windows_sys::Win32::Security::TOKEN_QUERY;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let token = OwnedHandle(token);
    let mut name_storage = wide_null("WIN://NOALLAPPPKG");
    let mut name = NativeUnicodeString {
        length: ((name_storage.len() - 1) * size_of::<u16>()) as u16,
        maximum_length: (name_storage.len() * size_of::<u16>()) as u16,
        buffer: name_storage.as_mut_ptr(),
    };
    let mut required = 0;
    unsafe {
        NtQuerySecurityAttributesToken(token.0, &mut name, 1, null_mut(), 0, &mut required);
    }
    if required == 0 {
        return false;
    }
    let mut storage = vec![0_usize; (required as usize).div_ceil(size_of::<usize>())];
    let status = unsafe {
        NtQuerySecurityAttributesToken(
            token.0,
            &mut name,
            1,
            storage.as_mut_ptr().cast(),
            required,
            &mut required,
        )
    };
    if status != 0 {
        return false;
    }
    let information = unsafe {
        &*storage
            .as_ptr()
            .cast::<TokenSecurityAttributesInformation>()
    };
    if information.attribute_count == 0 || information.attributes.is_null() {
        return false;
    }
    let attribute = unsafe { &*information.attributes };
    matches!(
        attribute.value_type,
        TOKEN_SECURITY_ATTRIBUTE_TYPE_INT64 | TOKEN_SECURITY_ATTRIBUTE_TYPE_UINT64
    ) && attribute.value_count > 0
        && !attribute.values.is_null()
        && unsafe { *attribute.values } != 0
}

fn probe_report() -> serde_json::Map<String, Value> {
    let allowed = std::env::var_os("SIGMA_PROBE_ALLOWED")
        .map(PathBuf::from)
        .unwrap_or_default();
    let outside = std::env::var_os("SIGMA_PROBE_OUTSIDE")
        .map(PathBuf::from)
        .unwrap_or_default();
    let all_packages = std::env::var_os("SIGMA_PROBE_ALL_PACKAGES")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut report = serde_json::Map::new();
    report.insert(
        "isAppContainer".into(),
        Value::Bool(is_appcontainer_token()),
    );
    report.insert(
        "tokenReportsLpac".into(),
        Value::Bool(is_less_privileged_appcontainer_token()),
    );
    report.insert(
        "tokenHasLpacAttribute".into(),
        Value::Bool(token_has_lpac_attribute()),
    );
    report.insert(
        "allApplicationPackagesReadDenied".into(),
        Value::Bool(std::fs::read(all_packages).is_err()),
    );
    report.insert(
        "allowedWrite".into(),
        Value::Bool(std::fs::write(allowed.join("allowed.txt"), b"ok").is_ok()),
    );
    report.insert(
        "outsideReadDenied".into(),
        Value::Bool(std::fs::read(&outside).is_err()),
    );
    report.insert(
        "outsideWriteDenied".into(),
        Value::Bool(std::fs::write(outside.with_extension("write"), b"no").is_err()),
    );
    report.insert("networkDenied".into(), Value::Bool(network_is_denied()));
    report.insert(
        "gitWriteDenied".into(),
        Value::Bool(std::fs::write(allowed.join(".git").join("sentinel"), b"no").is_err()),
    );
    report.insert(
        "agentWriteDenied".into(),
        Value::Bool(std::fs::write(allowed.join(".agent").join("new"), b"no").is_err()),
    );
    report
}

fn network_is_denied() -> bool {
    use windows_sys::Win32::Networking::WinSock::{
        AF_INET, IN_ADDR, IN_ADDR_0, INVALID_SOCKET, IPPROTO_TCP, SOCK_STREAM, SOCKADDR,
        SOCKADDR_IN, WSACleanup, WSADATA, WSAEACCES, WSAGetLastError, WSAStartup, closesocket,
        connect, socket,
    };
    let Some(port) = std::env::var("SIGMA_PROBE_NETWORK_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
    else {
        return false;
    };
    let mut data = WSADATA::default();
    if unsafe { WSAStartup(0x0202, &mut data) } != 0 {
        return true;
    }
    let socket_handle = unsafe { socket(AF_INET as i32, SOCK_STREAM, IPPROTO_TCP) };
    if socket_handle == INVALID_SOCKET {
        let denied = unsafe { WSAGetLastError() } == WSAEACCES;
        unsafe {
            WSACleanup();
        }
        return denied;
    }
    let address = SOCKADDR_IN {
        sin_family: AF_INET,
        sin_port: port.to_be(),
        sin_addr: IN_ADDR {
            S_un: IN_ADDR_0 {
                S_addr: u32::from_ne_bytes([127, 0, 0, 1]),
            },
        },
        sin_zero: [0; 8],
    };
    let connected = unsafe {
        connect(
            socket_handle,
            (&address as *const SOCKADDR_IN).cast::<SOCKADDR>(),
            size_of::<SOCKADDR_IN>() as i32,
        )
    };
    let denied = connected != 0 && unsafe { WSAGetLastError() } == WSAEACCES;
    unsafe {
        closesocket(socket_handle);
        WSACleanup();
    }
    denied
}

fn is_appcontainer_token() -> bool {
    use windows_sys::Win32::Security::{GetTokenInformation, TOKEN_QUERY, TokenIsAppContainer};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let mut value = 0_u32;
    let mut returned = 0;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenIsAppContainer,
            (&mut value as *mut u32).cast(),
            size_of::<u32>() as u32,
            &mut returned,
        )
    } != 0;
    unsafe {
        CloseHandle(token);
    }
    ok && value != 0
}

fn is_less_privileged_appcontainer_token() -> bool {
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_QUERY, TokenIsLessPrivilegedAppContainer,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return false;
    }
    let token = OwnedHandle(token);
    let mut is_lpac = 0_u32;
    let mut returned = 0;
    unsafe {
        GetTokenInformation(
            token.0,
            TokenIsLessPrivilegedAppContainer,
            (&mut is_lpac as *mut u32).cast(),
            size_of::<u32>() as u32,
            &mut returned,
        ) != 0
            && is_lpac != 0
    }
}

fn wide_null(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain(Some(0)).collect()
}

fn last_error(context: &str) -> RpcError {
    let code = unsafe { GetLastError() };
    win32_code_error(context, code)
}

fn win32_code_error(context: &str, code: u32) -> RpcError {
    RpcError::new(
        "sandbox_unavailable",
        format!("{context} failed with Win32 error {code}"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Security::WinWorldSid;

    fn world_sid() -> Vec<u8> {
        let mut sid = vec![0_u8; 68];
        let mut sid_bytes = sid.len() as u32;
        assert_ne!(
            unsafe {
                CreateWellKnownSid(
                    WinWorldSid,
                    null_mut(),
                    sid.as_mut_ptr().cast(),
                    &mut sid_bytes,
                )
            },
            0,
            "create a stable test SID"
        );
        sid
    }

    fn count_exact_allowed_aces(path: &Path, sid: PSID, mask: u32, flags: u8) -> u32 {
        let handle = open_acl_target(path).expect("open ACL test target");
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut acl,
                    null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let mut information = ACL_SIZE_INFORMATION::default();
        assert_ne!(
            unsafe {
                GetAclInformation(
                    acl,
                    (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            },
            0
        );
        let mut matches = 0;
        for index in 0..information.AceCount {
            let mut raw_ace = null_mut();
            assert_ne!(unsafe { GetAce(acl, index, &mut raw_ace) }, 0);
            let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            let ace_sid = (&allowed.SidStart as *const u32)
                .cast_mut()
                .cast::<c_void>();
            if allowed.Header.AceType == ACCESS_ALLOWED_ACE_TYPE_VALUE
                && allowed.Header.AceFlags == flags
                && allowed.Mask == mask
                && unsafe { EqualSid(ace_sid, sid) } != 0
            {
                matches += 1;
            }
        }
        unsafe { LocalFree(descriptor) };
        matches
    }

    fn count_allowed_aces(path: &Path, sid: PSID) -> u32 {
        let handle = open_acl_target(path).expect("open ACL test target");
        let mut acl = null_mut();
        let mut descriptor = null_mut();
        assert_eq!(
            unsafe {
                GetSecurityInfo(
                    handle.0,
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut acl,
                    null_mut(),
                    &mut descriptor,
                )
            },
            0
        );
        let mut information = ACL_SIZE_INFORMATION::default();
        assert_ne!(
            unsafe {
                GetAclInformation(
                    acl,
                    (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            },
            0
        );
        let mut matches = 0;
        for index in 0..information.AceCount {
            let mut raw_ace = null_mut();
            assert_ne!(unsafe { GetAce(acl, index, &mut raw_ace) }, 0);
            let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE_VALUE {
                continue;
            }
            let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            let ace_sid = (&allowed.SidStart as *const u32)
                .cast_mut()
                .cast::<c_void>();
            if unsafe { EqualSid(ace_sid, sid) } != 0 {
                matches += 1;
            }
        }
        unsafe { LocalFree(descriptor) };
        matches
    }

    fn assert_tree_has_no_allowed_ace(path: &Path, sid: PSID) {
        assert_eq!(
            count_allowed_aces(path, sid),
            0,
            "unexpected run SID ACE on '{}'",
            path.display()
        );
        if path.is_dir() {
            for entry in std::fs::read_dir(path).expect("enumerate ACL assertion tree") {
                assert_tree_has_no_allowed_ace(
                    &entry.expect("read ACL assertion entry").path(),
                    sid,
                );
            }
        }
    }

    fn test_profile() -> Profile {
        create_profile(
            &ephemeral_profile_name().expect("create test profile name"),
            true,
        )
        .expect("create isolated ACL test profile")
    }

    fn create_test_junction(link: &Path, target: &Path) {
        let status = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()))
            .args(["/d", "/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("create test junction");
        assert!(
            status.success(),
            "mklink /J must succeed for the regression fixture"
        );
    }

    fn read_tree_content_fingerprint(root: &Path) -> Vec<(String, u32, Vec<u8>)> {
        fn visit(root: &Path, path: &Path, entries: &mut Vec<(String, u32, Vec<u8>)>) {
            let metadata = std::fs::symlink_metadata(path).expect("inspect read fixture entry");
            let attributes = metadata.file_attributes();
            let relative = path
                .strip_prefix(root)
                .expect("fixture entry remains below root")
                .to_string_lossy()
                .replace('\\', "/");
            let is_reparse = attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
            let bytes = if metadata.is_file() && !is_reparse {
                std::fs::read(path).expect("read fixture file")
            } else {
                Vec::new()
            };
            entries.push((relative, attributes, bytes));
            if metadata.is_dir() && !is_reparse {
                let mut children = std::fs::read_dir(path)
                    .expect("enumerate read fixture")
                    .map(|entry| entry.expect("read fixture entry").path())
                    .collect::<Vec<_>>();
                children.sort();
                for child in children {
                    visit(root, &child, entries);
                }
            }
        }

        let mut entries = Vec::new();
        visit(root, root, &mut entries);
        entries
    }

    #[test]
    fn quotes_windows_arguments_without_losing_backslashes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(quote_windows_argument("a b"), "\"a b\"");
        assert_eq!(quote_windows_argument("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quote_windows_argument("tail\\"), "tail\\");
    }

    #[test]
    fn containment_probe_requires_appcontainer_lpac_attribute_and_job_membership() {
        let valid = serde_json::json!({
            "isAppContainer": true,
            // Some supported Windows builds return ERROR_INVALID_PARAMETER for
            // TokenIsLessPrivilegedAppContainer on legacy LPAC tokens. The
            // WIN://NOALLAPPPKG security attribute is the authoritative check.
            "tokenReportsLpac": false,
            "tokenHasLpacAttribute": true,
            "inJob": true,
        });
        assert!(containment_report_passed(&valid));
        for field in ["isAppContainer", "tokenHasLpacAttribute", "inJob"] {
            let mut invalid = valid.clone();
            invalid[field] = Value::Bool(false);
            assert!(
                !containment_report_passed(&invalid),
                "{field} must be required"
            );
        }
        assert!(!containment_report_passed(&serde_json::json!({})));
    }

    #[test]
    fn recovery_journal_is_atomic_and_rejects_changed_file_identity() {
        let unique = ephemeral_profile_name()
            .expect("create recovery test profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-recovery-test-{unique}"));
        let recovery = root.join("SigmaCode").join(RECOVERY_DIRECTORY);
        let target = root.join("target");
        std::fs::create_dir_all(&target).expect("create recovery target");
        let profile_name = ephemeral_profile_name().expect("create recovery test profile name");
        let mut journal = RecoveryJournal::create(&recovery, &profile_name)
            .expect("create durable recovery journal");
        let plan = [PlannedAcl {
            path: target.clone(),
            permissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            inherit: true,
            propagate_inheritance: true,
            read_reparse_target: None,
            writable_root: None,
        }];
        let mut baseline_sid = world_sid();
        journal
            .prepare(&plan, baseline_sid.as_mut_ptr().cast())
            .expect("persist exact ACL identity before mutation");
        assert!(journal.path.is_file());
        let persisted: RecoverySnapshot = serde_json::from_slice(
            &std::fs::read(&journal.path).expect("read persisted recovery journal"),
        )
        .expect("parse persisted recovery journal");
        assert_eq!(persisted.profile_name, profile_name);
        assert_eq!(persisted.entries.len(), 1);

        journal.snapshot.entries[0].identity.file_id[0] ^= 1;
        let error = cleanup_recovery_snapshot(&journal.snapshot, null_mut())
            .expect_err("changed file identity must fail closed before ACL mutation");
        assert_eq!(error.code, "sandbox_recovery_failed");
        assert!(error.message.contains("controlled write root"));
        journal.remove().expect("remove recovery journal");
        std::fs::remove_dir_all(&root).expect("remove recovery fixture");
    }

    #[test]
    fn recovery_accepts_a_host_deleted_read_only_target() {
        let unique = ephemeral_profile_name()
            .expect("create deleted read target profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-recovery-read-delete-{unique}"));
        let recovery = root.join("host").join("SigmaCode").join(RECOVERY_DIRECTORY);
        let target = root.join("read-only.txt");
        std::fs::create_dir_all(&root).expect("create deleted read target root");
        std::fs::write(&target, b"read-only").expect("create deleted read target");
        let profile_name = ephemeral_profile_name().expect("create deleted read profile");
        let mut journal = RecoveryJournal::create(&recovery, &profile_name)
            .expect("create deleted read recovery journal");
        let plan = [PlannedAcl {
            path: target.clone(),
            permissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            inherit: false,
            propagate_inheritance: false,
            read_reparse_target: None,
            writable_root: None,
        }];
        let mut sid = world_sid();
        let sid = sid.as_mut_ptr().cast();
        journal
            .prepare(&plan, sid)
            .expect("journal deleted read target");
        journal
            .apply(&plan, sid)
            .expect("grant deleted read target");
        std::fs::remove_file(&target).expect("host deletes read-only target after crash");
        cleanup_recovery_snapshot(&journal.snapshot, sid)
            .expect("deleted read-only object no longer carries an ACE");
        journal.remove().expect("remove deleted read journal");
        std::fs::remove_dir_all(&root).expect("remove deleted read fixture");
    }

    #[test]
    fn read_tree_recovery_removes_inherited_aces_from_existing_and_new_children() {
        let unique = ephemeral_profile_name()
            .expect("create inherited read profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-read-inheritance-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("bundle");
        let existing = root.join("existing").join("file.txt");
        std::fs::create_dir_all(existing.parent().expect("existing parent"))
            .expect("create existing read tree");
        std::fs::write(&existing, b"existing").expect("create existing read file");

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &root,
            std::slice::from_ref(&root),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("plan complete read tree");
        assert_eq!(plan.len(), 3, "every existing read object is journaled");
        assert!(plan.iter().all(|entry| !entry.propagate_inheritance));
        let mut profile = test_profile();
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create inherited read recovery journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("journal inherited read root");
        journal
            .apply(&plan, profile.sid)
            .expect("apply inherited read root");

        let created = root.join("created-after-grant").join("file.txt");
        std::fs::create_dir_all(created.parent().expect("created parent"))
            .expect("create read descendant after grant");
        std::fs::write(&created, b"created").expect("create new inherited read file");
        assert!(count_allowed_aces(&existing, profile.sid) > 0);
        assert!(count_allowed_aces(&created, profile.sid) > 0);

        cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect("recover complete inherited read tree");
        assert_tree_has_no_allowed_ace(&root, profile.sid);
        journal.remove().expect("remove inherited read journal");
        profile.delete().expect("delete inherited read profile");
        std::fs::remove_dir_all(&fixture).expect("remove inherited read fixture");
    }

    #[test]
    fn read_tree_journals_an_in_root_junction_without_following_it() {
        let unique = ephemeral_profile_name()
            .expect("create read junction profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-read-junction-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("bundle");
        let target = root.join("target");
        let target_file = target.join("file.txt");
        let junction = root.join("linked-target");
        std::fs::create_dir_all(&target).expect("create in-root junction target");
        std::fs::write(&target_file, b"content").expect("create in-root junction file");
        create_test_junction(&junction, &target);

        // Production canonicalizes declared policy roots before planning. Mirror
        // that contract here so Windows short-path aliases (for example
        // RUNNER~1 in hosted CI) cannot make an in-root target appear external.
        let canonical_root = root.canonicalize().expect("canonical read junction root");
        let planned_junction = canonical_root.join("linked-target");

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &canonical_root,
            std::slice::from_ref(&canonical_root),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("plan read tree containing an in-root junction");
        let junction_plan = plan
            .iter()
            .find(|entry| entry.path == planned_junction)
            .expect("journal the junction object itself");
        assert_eq!(
            junction_plan
                .read_reparse_target
                .as_ref()
                .map(|target| target.path.as_path()),
            Some(
                target
                    .canonicalize()
                    .expect("canonical in-root target")
                    .as_path()
            )
        );
        assert!(!junction_plan.inherit);
        assert!(
            !plan
                .iter()
                .any(|entry| entry.path == planned_junction.join("file.txt"))
        );

        let mut profile = test_profile();
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create read junction journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("journal read junction identity and target");
        journal
            .apply(&plan, profile.sid)
            .expect("grant the read junction object");
        assert!(count_allowed_aces(&junction, profile.sid) > 0);
        cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect("recover the read junction object");
        for path in [&root, &target, &target_file, &junction] {
            assert_eq!(count_allowed_aces(path, profile.sid), 0);
        }
        journal.remove().expect("remove read junction journal");
        profile.delete().expect("delete read junction profile");
        std::fs::remove_dir(&junction).expect("remove in-root junction");
        std::fs::remove_dir_all(&fixture).expect("remove read junction fixture");
    }

    #[test]
    fn dangling_read_junction_reports_the_stable_sandbox_code() {
        let unique = ephemeral_profile_name()
            .expect("create dangling junction profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-dangling-junction-{unique}"));
        let root = fixture.join("root");
        let target = root.join("target");
        let junction = root.join("dangling");
        std::fs::create_dir_all(&target).expect("create dangling junction target");
        create_test_junction(&junction, &target);
        std::fs::remove_dir(&target).expect("remove junction target");

        let error = inspect_read_acl_target_path(&junction, std::slice::from_ref(&root))
            .expect_err("direct dangling junction inspection must fail closed");
        assert_eq!(error.code, SANDBOX_REPARSE_TARGET_UNRESOLVABLE);

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        let error = plan_read_tree(
            &junction,
            std::slice::from_ref(&junction),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect_err("a dangling junction declared as the read root must fail closed");
        assert_eq!(error.code, SANDBOX_REPARSE_TARGET_UNRESOLVABLE);

        let error = canonicalize_policy_root(&junction)
            .expect_err("a dangling junction policy root must retain its stable failure code");
        assert_eq!(error.code, SANDBOX_REPARSE_TARGET_UNRESOLVABLE);

        std::fs::remove_dir(&junction).expect("remove dangling junction");
        std::fs::remove_dir_all(&fixture).expect("remove dangling junction fixture");
    }

    #[test]
    fn read_tree_skips_100_deterministic_dangling_descendants_without_residue() {
        let unique = ephemeral_profile_name()
            .expect("create deterministic reparse profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-dangling-descendants-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("workspace");
        let removed_targets = fixture.join("removed-targets");
        let outside = fixture.join("outside");
        let outside_link = root.join("outside-link");
        let ordinary = root.join("ordinary.txt");
        std::fs::create_dir_all(&root).expect("create deterministic read root");
        std::fs::create_dir_all(&removed_targets).expect("create removed target parent");
        std::fs::create_dir_all(&outside).expect("create outside target");
        std::fs::write(&ordinary, b"ordinary read-only content")
            .expect("create ordinary read target");
        std::fs::write(outside.join("secret.txt"), b"outside").expect("create outside sentinel");
        create_test_junction(&outside_link, &outside);

        let mut dangling = Vec::with_capacity(100);
        let mut ordinary_descendants = Vec::with_capacity(100);
        for seed in 0_usize..100 {
            let mut branch = root.join(format!("case-{seed:03}"));
            let depth = (seed.wrapping_mul(37) % 5) + 1;
            for level in 0..depth {
                branch = branch.join(format!(
                    "level-{:02}",
                    seed.wrapping_mul(17).wrapping_add(level) % 23
                ));
            }
            std::fs::create_dir_all(&branch).expect("create deterministic nested branch");
            let ordinary_descendant = branch.join(format!("visible-{seed:03}.txt"));
            std::fs::write(&ordinary_descendant, format!("seed={seed}\n"))
                .expect("create deterministic ordinary descendant");
            ordinary_descendants.push(ordinary_descendant);

            let target = removed_targets.join(format!("target-{seed:03}"));
            let link = branch.join(format!("unavailable-{seed:03}"));
            std::fs::create_dir(&target).expect("create temporary junction target");
            create_test_junction(&link, &target);
            std::fs::remove_dir(&target).expect("make deterministic junction dangling");
            dangling.push(link);
        }

        let before = read_tree_content_fingerprint(&root);
        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &root,
            std::slice::from_ref(&root),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("unresolvable descendants must not reject the unrelated read tree");
        for link in &dangling {
            assert!(
                plan.iter().all(|entry| entry.path != *link),
                "a dangling descendant must receive no ACL grant: '{}'",
                link.display()
            );
        }
        assert!(plan.iter().all(|entry| entry.path != outside_link));
        assert!(plan.iter().any(|entry| entry.path == ordinary));
        for path in &ordinary_descendants {
            assert!(plan.iter().any(|entry| entry.path == *path));
        }

        let mut profile = test_profile();
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create deterministic dangling-link recovery journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("journal only authorized read-tree entries");
        journal
            .apply(&plan, profile.sid)
            .expect("grant the unrelated read tree");
        assert!(count_allowed_aces(&root, profile.sid) > 0);
        assert!(count_allowed_aces(&ordinary, profile.sid) > 0);
        for link in &dangling {
            assert_eq!(
                count_allowed_aces(link, profile.sid),
                0,
                "a skipped dangling descendant must receive no run-SID ACE"
            );
        }
        for path in [&outside_link, &outside, &outside.join("secret.txt")] {
            assert_eq!(
                count_allowed_aces(path, profile.sid),
                0,
                "an out-of-root link and target must receive no run-SID ACE"
            );
        }

        cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect("recover deterministic dangling-link ACL grants");
        assert_tree_has_no_allowed_ace(&root, profile.sid);
        assert_eq!(count_allowed_aces(&outside, profile.sid), 0);
        assert_eq!(
            count_allowed_aces(&outside.join("secret.txt"), profile.sid),
            0
        );
        journal
            .remove()
            .expect("remove deterministic dangling-link journal");
        profile
            .delete()
            .expect("delete deterministic dangling-link profile");
        assert_eq!(
            read_tree_content_fingerprint(&root),
            before,
            "ACL grant and recovery must preserve workspace content and structure"
        );

        for link in dangling {
            std::fs::remove_dir(&link).expect("remove deterministic dangling junction");
        }
        std::fs::remove_dir(&outside_link).expect("remove outside junction");
        std::fs::remove_dir_all(&fixture).expect("remove deterministic dangling fixture");
    }

    #[test]
    fn read_tree_skips_an_out_of_root_junction_and_rejects_retargeting() {
        let unique = ephemeral_profile_name()
            .expect("create skipped junction profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-read-junction-skip-{unique}"));
        let root = fixture.join("root");
        let inside_a = root.join("inside-a");
        let inside_b = root.join("inside-b");
        let outside = fixture.join("outside");
        let in_root_link = root.join("in-root-link");
        let outside_link = root.join("outside-link");
        for path in [&inside_a, &inside_b, &outside] {
            std::fs::create_dir_all(path).expect("create junction boundary fixture");
        }
        create_test_junction(&in_root_link, &inside_a);
        create_test_junction(&outside_link, &outside);

        // Match grant_policy_access: policy roots are canonical before the
        // planner compares them with resolved reparse targets.
        let canonical_root = root
            .canonicalize()
            .expect("canonical skipped junction root");
        let planned_in_root_link = canonical_root.join("in-root-link");
        let planned_outside_link = canonical_root.join("outside-link");

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &canonical_root,
            std::slice::from_ref(&canonical_root),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("skip an out-of-root read junction without granting it");
        assert!(plan.iter().all(|entry| entry.path != planned_outside_link));
        let in_root_plan = plan
            .iter()
            .find(|entry| entry.path == planned_in_root_link)
            .expect("retain the in-root junction plan");
        let handle = open_acl_target(&planned_in_root_link).expect("open planned in-root junction");
        std::fs::remove_dir(&in_root_link).expect("remove original in-root junction");
        create_test_junction(&in_root_link, &inside_b);
        let error = assert_read_reparse_target(
            &handle,
            &planned_in_root_link,
            in_root_plan
                .read_reparse_target
                .as_ref()
                .expect("planned junction target"),
        )
        .expect_err("a host retarget must fail the identity/target binding");
        assert_eq!(error.code, "sandbox_recovery_failed");

        drop(handle);
        std::fs::remove_dir(&in_root_link).expect("remove retargeted in-root junction");
        std::fs::remove_dir(&outside_link).expect("remove out-of-root junction");
        std::fs::remove_dir_all(&fixture).expect("remove skipped junction fixture");
    }

    #[test]
    fn recovery_postcondition_keeps_the_journal_and_is_retryable() {
        let unique = ephemeral_profile_name()
            .expect("create postcondition profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-postcondition-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("bundle");
        std::fs::create_dir_all(&root).expect("create postcondition read root");
        std::fs::write(root.join("file.txt"), b"content").expect("create postcondition read file");
        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &root,
            std::slice::from_ref(&root),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("plan postcondition read tree");
        let mut profile = test_profile();
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create postcondition journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("prepare postcondition journal");
        journal
            .apply(&plan, profile.sid)
            .expect("apply postcondition ACLs");

        let baseline = journal.snapshot.clone();
        journal.snapshot.entries[0].preexisting_sid_ace_count += 1;
        let error = cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect_err("a mismatched whole-scope baseline must fail closed");
        assert_eq!(error.code, "sandbox_recovery_failed");
        assert!(error.message.contains("run-SID grant"));
        assert!(
            journal.path.is_file(),
            "failed cleanup must retain its journal"
        );

        cleanup_recovery_snapshot(&baseline, profile.sid)
            .expect("retry cleanup after an interrupted propagation");
        assert_tree_has_no_allowed_ace(&root, profile.sid);
        journal.remove().expect("remove postcondition journal");
        profile.delete().expect("delete postcondition profile");
        std::fs::remove_dir_all(&fixture).expect("remove postcondition fixture");
    }

    #[test]
    fn recovery_accepts_a_host_deleted_complete_write_root() {
        let unique = ephemeral_profile_name()
            .expect("create deleted write root profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-recovery-write-delete-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("workspace");
        std::fs::create_dir_all(root.join("nested")).expect("create deleted write root");
        std::fs::write(root.join("nested").join("file.txt"), b"write")
            .expect("create deleted write descendant");
        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_write_tree(&root, &root, &[], &[], &mut plan, &mut planned_objects, 0)
            .expect("plan deleted write root");
        let profile_name = ephemeral_profile_name().expect("create deleted write profile");
        let mut journal = RecoveryJournal::create(&recovery, &profile_name)
            .expect("create deleted write recovery journal");
        let mut sid = world_sid();
        let sid = sid.as_mut_ptr().cast();
        journal
            .prepare(&plan, sid)
            .expect("journal deleted write root");
        journal.apply(&plan, sid).expect("grant deleted write root");
        std::fs::remove_dir_all(&root).expect("host deletes complete write root after crash");
        cleanup_recovery_snapshot(&journal.snapshot, sid)
            .expect("deleted write root objects no longer carry ACEs");
        journal.remove().expect("remove deleted write journal");
        std::fs::remove_dir_all(&fixture).expect("remove deleted write fixture");
    }

    #[test]
    fn recovery_validation_accepts_only_sigma_profiles_and_known_acl_shapes() {
        let profile_name = "SigmaCode.Exec.1.0123456789abcdef0123456789abcdef";
        let path = PathBuf::from(format!("{}.json", profile_name.to_ascii_lowercase()));
        let valid = RecoverySnapshot {
            schema_version: RECOVERY_SCHEMA_VERSION,
            product: RECOVERY_PRODUCT.into(),
            profile_name: profile_name.into(),
            owner_process_id: 1,
            owner_process_creation_time: 1,
            entries: vec![RecoveryAclEntry {
                path: std::env::temp_dir(),
                identity: RecoveryFileIdentity {
                    volume_serial_number: 1,
                    file_id: [1; 16],
                },
                permissions: FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                inherit: true,
                preexisting_ace_count: 0,
                preexisting_sid_ace_count: 0,
                read_reparse_target: None,
                writable_root: None,
            }],
        };
        validate_recovery_snapshot(&valid, &path).expect("known journal shape should pass");

        let mut foreign = valid.clone();
        foreign.profile_name = "OtherProduct.Exec.1.2.3".into();
        assert!(validate_recovery_snapshot(&foreign, &path).is_err());
        let mut unknown_acl = valid.clone();
        unknown_acl.entries[0].permissions = FILE_GENERIC_WRITE;
        assert!(validate_recovery_snapshot(&unknown_acl, &path).is_err());
        assert!(validate_recovery_snapshot(&valid, Path::new("wrong.json")).is_err());
    }

    #[test]
    fn exact_acl_recovery_removes_one_matching_ace_and_preserves_same_sid_permissions() {
        let mut sid = world_sid();
        let sid = sid.as_mut_ptr().cast();
        let mut original = vec![0_usize; 128];
        let original_bytes = (original.len() * size_of::<usize>()) as u32;
        let original_acl = original.as_mut_ptr().cast::<ACL>();
        assert_ne!(
            unsafe { InitializeAcl(original_acl, original_bytes, ACL_REVISION) },
            0
        );

        let exact_flags = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
        let exact_mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
        assert_ne!(
            unsafe {
                AddAccessAllowedAceEx(original_acl, ACL_REVISION, exact_flags, exact_mask, sid)
            },
            0
        );
        // A duplicate proves one recovery entry cannot erase more than the one
        // ACE it owns, even if an identical grant already existed.
        assert_ne!(
            unsafe {
                AddAccessAllowedAceEx(original_acl, ACL_REVISION, exact_flags, exact_mask, sid)
            },
            0
        );
        assert_ne!(
            unsafe { AddAccessAllowedAceEx(original_acl, ACL_REVISION, 0, FILE_GENERIC_READ, sid) },
            0
        );

        let rebuilt =
            rebuild_acl_without_one_exact_entry(original_acl, sid, exact_mask, exact_flags as u8)
                .expect("rebuild ACL")
                .expect("one exact ACE should be removed");
        let rebuilt_acl = rebuilt.as_ptr().cast::<ACL>();
        let mut information = ACL_SIZE_INFORMATION::default();
        assert_ne!(
            unsafe {
                GetAclInformation(
                    rebuilt_acl,
                    (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            },
            0
        );
        assert_eq!(information.AceCount, 2);

        let mut exact_remaining = 0;
        let mut nonmatching_remaining = 0;
        for index in 0..information.AceCount {
            let mut raw_ace = null_mut();
            assert_ne!(unsafe { GetAce(rebuilt_acl, index, &mut raw_ace) }, 0);
            let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
            let ace_sid = (&allowed.SidStart as *const u32)
                .cast_mut()
                .cast::<c_void>();
            assert_ne!(unsafe { EqualSid(ace_sid, sid) }, 0);
            if allowed.Header.AceFlags == exact_flags as u8 && allowed.Mask == exact_mask {
                exact_remaining += 1;
            }
            if allowed.Header.AceFlags == 0 && allowed.Mask == FILE_GENERIC_READ {
                nonmatching_remaining += 1;
            }
        }
        assert_eq!(exact_remaining, 1);
        assert_eq!(nonmatching_remaining, 1);
    }

    #[test]
    fn inherited_sid_recovery_preserves_explicit_same_sid_permissions() {
        let mut sid = world_sid();
        let sid = sid.as_mut_ptr().cast();
        let mut original = vec![0_usize; 128];
        let original_bytes = (original.len() * size_of::<usize>()) as u32;
        let original_acl = original.as_mut_ptr().cast::<ACL>();
        assert_ne!(
            unsafe { InitializeAcl(original_acl, original_bytes, ACL_REVISION) },
            0
        );
        assert_ne!(
            unsafe { AddAccessAllowedAceEx(original_acl, ACL_REVISION, 0, FILE_GENERIC_READ, sid) },
            0
        );
        assert_ne!(
            unsafe {
                AddAccessAllowedAceEx(
                    original_acl,
                    ACL_REVISION,
                    INHERITED_ACE,
                    FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
                    sid,
                )
            },
            0
        );

        let product_mask = FILE_GENERIC_READ | FILE_GENERIC_EXECUTE;
        // Windows may normalize the inherited product grant into an explicit
        // ACE during ancestor recovery. It is still distinguishable from the
        // unrelated explicit read-only grant by the journal permission mask.
        assert_ne!(
            unsafe { AddAccessAllowedAceEx(original_acl, ACL_REVISION, 0, product_mask, sid) },
            0
        );

        let rebuilt = rebuild_acl_without_inherited_sid_entries(
            original_acl,
            sid,
            std::slice::from_ref(&product_mask),
        )
        .expect("rebuild inherited ACL")
        .expect("inherited and normalized product SID ACEs should be removed");
        let rebuilt_acl = rebuilt.as_ptr().cast::<ACL>();
        let mut information = ACL_SIZE_INFORMATION::default();
        assert_ne!(
            unsafe {
                GetAclInformation(
                    rebuilt_acl,
                    (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                    size_of::<ACL_SIZE_INFORMATION>() as u32,
                    AclSizeInformation,
                )
            },
            0
        );
        assert_eq!(information.AceCount, 1);
        let mut raw_ace = null_mut();
        assert_ne!(unsafe { GetAce(rebuilt_acl, 0, &mut raw_ace) }, 0);
        let allowed = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
        assert_eq!(allowed.Header.AceFlags, 0);
        assert_eq!(allowed.Mask, FILE_GENERIC_READ);
    }

    #[test]
    fn recovery_finds_a_renamed_write_tree_object_by_durable_identity() {
        let unique = ephemeral_profile_name()
            .expect("create rename recovery profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-recovery-rename-{unique}"));
        let recovery = root.join("host").join("SigmaCode").join(RECOVERY_DIRECTORY);
        let workspace = root.join("workspace");
        let original = workspace.join("old.txt");
        let renamed = workspace.join("renamed.txt");
        std::fs::create_dir_all(&workspace).expect("create rename recovery workspace");
        std::fs::write(&original, b"original").expect("create rename recovery file");
        let profile_name = ephemeral_profile_name().expect("create rename recovery profile");
        let mut journal = RecoveryJournal::create(&recovery, &profile_name)
            .expect("create rename recovery journal");
        let mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
        let plan = [PlannedAcl {
            path: original.clone(),
            permissions: mask,
            inherit: false,
            propagate_inheritance: false,
            read_reparse_target: None,
            writable_root: Some(workspace.clone()),
        }];
        let mut sid = world_sid();
        let sid = sid.as_mut_ptr().cast();
        journal
            .prepare(&plan, sid)
            .expect("prepare rename recovery identity");
        journal
            .apply(&plan, sid)
            .expect("apply rename recovery ACE");
        assert_eq!(count_exact_allowed_aces(&original, sid, mask, 0), 1);
        std::fs::rename(&original, &renamed).expect("rename ACL-bearing file");

        cleanup_recovery_snapshot(&journal.snapshot, sid)
            .expect("recover renamed file by durable identity");
        assert_eq!(count_exact_allowed_aces(&renamed, sid, mask, 0), 0);
        journal.remove().expect("remove rename recovery journal");
        std::fs::remove_dir_all(&root).expect("remove rename recovery fixture");
    }

    #[test]
    fn end_to_end_cleanup_preserves_preexisting_exact_and_same_sid_aces() {
        let unique = ephemeral_profile_name()
            .expect("create exact baseline profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-exact-baseline-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("workspace");
        let target = root.join("file.txt");
        std::fs::create_dir_all(&root).expect("create exact baseline root");
        std::fs::write(&target, b"content").expect("create exact baseline file");
        let mut profile = test_profile();
        let mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
        update_acl(&target, profile.sid, mask, GRANT_ACCESS, false)
            .expect("add preexisting exact ACE");
        update_acl(&target, profile.sid, FILE_GENERIC_READ, GRANT_ACCESS, false)
            .expect("add preexisting different-mask ACE");
        let exact_before = count_exact_allowed_aces(&target, profile.sid, mask, 0);
        let read_before = count_exact_allowed_aces(&target, profile.sid, FILE_GENERIC_READ, 0);
        assert_eq!((exact_before, read_before), (1, 1));

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_write_tree(&root, &root, &[], &[], &mut plan, &mut planned_objects, 0)
            .expect("plan exact baseline tree");
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create exact baseline journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("journal exact baseline tree");
        journal
            .apply(&plan, profile.sid)
            .expect("append distinct product ACE");
        // Windows may normalize two identical ACEs into one. The durable
        // baseline makes that a no-op at cleanup instead of deleting the
        // user's pre-existing entry.
        assert!(count_exact_allowed_aces(&target, profile.sid, mask, 0) >= exact_before);
        cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect("remove only the product-owned exact ACE");
        assert_eq!(
            count_exact_allowed_aces(&target, profile.sid, mask, 0),
            exact_before
        );
        assert_eq!(
            count_exact_allowed_aces(&target, profile.sid, FILE_GENERIC_READ, 0),
            read_before
        );
        journal.remove().expect("remove exact baseline journal");
        profile.delete().expect("delete exact baseline profile");
        std::fs::remove_dir_all(&fixture).expect("remove exact baseline fixture");
    }

    #[test]
    fn writable_plan_journals_inheritable_descendants_before_relocation() {
        let unique = ephemeral_profile_name()
            .expect("create inherited recovery profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-inherited-plan-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root = fixture.join("workspace");
        let protected = root.join(".git");
        let source = root.join("src").join("file.txt");
        let relocated = root.join("file.txt");
        std::fs::create_dir_all(&protected).expect("create protected subtree");
        std::fs::create_dir_all(source.parent().expect("source parent"))
            .expect("create writable subtree");
        std::fs::write(protected.join("sentinel"), b"protected")
            .expect("create protected sentinel");
        std::fs::write(&source, b"content").expect("create writable descendant");
        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_write_tree(
            &root,
            &root,
            std::slice::from_ref(&protected),
            std::slice::from_ref(&root),
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("plan complete writable tree");
        assert!(plan.iter().any(|entry| entry.path == source));
        assert!(
            plan.iter()
                .find(|entry| entry.path == root.join("src"))
                .is_some_and(|entry| entry.inherit && !entry.propagate_inheritance)
        );

        let mut profile = test_profile();
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create inherited recovery journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("journal every existing writable descendant");
        journal
            .apply(&plan, profile.sid)
            .expect("apply path-local writable ACEs");
        assert_eq!(
            count_exact_allowed_aces(
                &source,
                profile.sid,
                FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
                0,
            ),
            1
        );
        std::fs::rename(&source, &relocated)
            .expect("relocate descendant outside inheriting parent");
        cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect("recover relocated descendant by durable identity");
        assert_tree_has_no_allowed_ace(&root, profile.sid);
        journal.remove().expect("remove inherited recovery journal");
        profile.delete().expect("delete inherited test profile");
        std::fs::remove_dir_all(&fixture).expect("remove inherited recovery fixture");
    }

    #[test]
    fn recovery_locates_a_descendant_across_all_declared_write_roots() {
        let unique = ephemeral_profile_name()
            .expect("create cross-root profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-cross-root-{unique}"));
        let recovery = fixture
            .join("host")
            .join("SigmaCode")
            .join(RECOVERY_DIRECTORY);
        let root_a = fixture.join("a");
        let root_b = fixture.join("b");
        let source = root_a.join("nested").join("file.txt");
        let relocated = root_b.join("relocated.txt");
        std::fs::create_dir_all(source.parent().expect("source parent"))
            .expect("create first write root");
        std::fs::create_dir_all(&root_b).expect("create second write root");
        std::fs::write(&source, b"content").expect("create cross-root descendant");
        let mut plan = Vec::new();
        let mut planned_objects = 0;
        for root in [&root_a, &root_b] {
            plan_write_tree(root, root, &[], &[], &mut plan, &mut planned_objects, 0)
                .expect("plan declared write root");
        }
        let mut profile = test_profile();
        let mut journal = RecoveryJournal::create(&recovery, &profile.name)
            .expect("create cross-root recovery journal");
        journal
            .prepare(&plan, profile.sid)
            .expect("journal both write roots");
        journal.apply(&plan, profile.sid).expect("apply both roots");
        std::fs::rename(&source, &relocated).expect("move descendant across write roots");
        cleanup_recovery_snapshot(&journal.snapshot, profile.sid)
            .expect("locate relocated object across all roots");
        assert_tree_has_no_allowed_ace(&root_a, profile.sid);
        assert_tree_has_no_allowed_ace(&root_b, profile.sid);
        journal.remove().expect("remove cross-root journal");
        profile.delete().expect("delete cross-root test profile");
        std::fs::remove_dir_all(&fixture).expect("remove cross-root fixture");
    }

    #[test]
    fn writable_planning_rejects_a_deep_multilink_before_any_acl_mutation() {
        let unique = ephemeral_profile_name()
            .expect("create deep hardlink profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-deep-hardlink-{unique}"));
        let outside = std::env::temp_dir().join(format!("sigma-deep-hardlink-{unique}.txt"));
        let inside = root.join("one").join("two").join("three").join("file.txt");
        std::fs::create_dir_all(inside.parent().expect("deep hardlink parent"))
            .expect("create deep writable tree");
        std::fs::write(&outside, b"outside").expect("create external hardlink object");
        std::fs::hard_link(&outside, &inside).expect("create deep hardlink alias");
        let mut profile = test_profile();
        let before_root = count_allowed_aces(&root, profile.sid);
        let before_outside = count_allowed_aces(&outside, profile.sid);
        let mut plan = Vec::new();
        let mut planned_objects = 0;
        let error = plan_write_tree(&root, &root, &[], &[], &mut plan, &mut planned_objects, 0)
            .expect_err("deep multi-link file must reject the complete plan");
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("hard link"));
        assert_eq!(count_allowed_aces(&root, profile.sid), before_root);
        assert_eq!(count_allowed_aces(&outside, profile.sid), before_outside);
        profile.delete().expect("delete deep hardlink test profile");
        std::fs::remove_file(&inside).expect("remove inside hardlink");
        std::fs::remove_dir_all(&root).expect("remove deep hardlink root");
        std::fs::remove_file(&outside).expect("remove external hardlink");
    }

    #[test]
    fn recovery_claim_allows_only_one_cleanup_owner() {
        let unique = ephemeral_profile_name()
            .expect("create recovery claim profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-recovery-claim-{unique}"));
        let recovery = root.join("SigmaCode").join(RECOVERY_DIRECTORY);
        let profile_name = ephemeral_profile_name().expect("create claim profile name");
        let journal = RecoveryJournal::create(&recovery, &profile_name)
            .expect("create claim recovery journal");
        let first = RecoveryClaim::acquire(&journal.path)
            .expect("acquire first recovery claim")
            .expect("first recovery claim must win");
        let claimed_snapshot: RecoverySnapshot =
            serde_json::from_slice(&first.read().expect("read locked recovery claim"))
                .expect("parse locked recovery claim");
        assert_eq!(claimed_snapshot.profile_name, profile_name);
        let second = RecoveryClaim::acquire(&first.path).expect("attempt second recovery claim");
        assert!(
            second.is_none(),
            "the locked claim must have one cleanup owner"
        );
        first.remove().expect("remove claimed recovery journal");
        std::fs::remove_dir_all(&root).expect("remove recovery claim fixture");
    }

    #[test]
    fn recovery_owner_requires_a_matching_unsignaled_process_handle() {
        let current = unsafe { GetCurrentProcess() };
        let creation = process_creation_time(current).expect("read current process creation time");
        assert!(
            recovery_process_handle_is_active(current, creation)
                .expect("query live recovery owner")
        );
        assert!(
            !recovery_process_handle_is_active(current, creation ^ 1)
                .expect("reject mismatched recovery owner")
        );

        let mut child =
            Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_owned()))
                .args(["/d", "/c", "exit", "0"])
                .spawn()
                .expect("spawn completed recovery owner fixture");
        let handle = child.as_raw_handle() as HANDLE;
        let child_creation = process_creation_time(handle).expect("read child creation time");
        child.wait().expect("wait completed recovery owner fixture");
        assert!(
            !recovery_process_handle_is_active(handle, child_creation)
                .expect("query completed recovery owner")
        );
    }

    #[test]
    fn writable_tree_rejects_preexisting_external_hardlinks_before_acl_changes() {
        let unique = ephemeral_profile_name()
            .expect("create hardlink test profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-hardlink-root-{unique}"));
        let outside = std::env::temp_dir().join(format!("sigma-hardlink-outside-{unique}.txt"));
        let inside = root.join("inside.txt");
        std::fs::create_dir(&root).expect("create hardlink root");
        std::fs::write(&outside, b"unchanged").expect("create external hardlink target");
        std::fs::hard_link(&outside, &inside).expect("create external hardlink alias");
        let mut sid = world_sid();
        let sid = sid.as_mut_ptr().cast();
        let mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE;
        let before = count_exact_allowed_aces(&inside, sid, mask, 0);
        let error = validate_acl_target_path(&inside, &root)
            .expect_err("pre-existing external hardlink must be rejected");
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("hard link"));
        assert_eq!(count_exact_allowed_aces(&inside, sid, mask, 0), before);
        assert_eq!(
            std::fs::read(&outside).expect("read external link"),
            b"unchanged"
        );
        std::fs::remove_file(&inside).expect("remove inside hardlink");
        std::fs::remove_dir(&root).expect("remove hardlink root");
        std::fs::remove_file(&outside).expect("remove outside hardlink");
    }

    #[test]
    fn read_tree_skips_a_multilink_file_without_rejecting_unrelated_entries() {
        let unique = ephemeral_profile_name()
            .expect("create read hardlink profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-read-hardlink-{unique}"));
        let outside = std::env::temp_dir().join(format!("sigma-read-hardlink-{unique}.txt"));
        let linked = root.join("linked.txt");
        let ordinary = root.join("ordinary.txt");
        std::fs::create_dir_all(&root).expect("create read hardlink root");
        std::fs::write(&outside, b"outside").expect("create read hardlink target");
        std::fs::hard_link(&outside, &linked).expect("create read hardlink alias");
        std::fs::write(&ordinary, b"ordinary").expect("create ordinary read file");

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &root,
            std::slice::from_ref(&root),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("skip a read-only hardlink without rejecting its tree");
        assert!(plan.iter().all(|entry| entry.path != linked));
        assert!(plan.iter().any(|entry| entry.path == ordinary));

        std::fs::remove_file(&linked).expect("remove read hardlink alias");
        std::fs::remove_dir_all(&root).expect("remove read hardlink root");
        std::fs::remove_file(&outside).expect("remove read hardlink target");
    }

    #[test]
    fn read_tree_allows_a_multilink_file_declared_as_the_exact_root() {
        let unique = ephemeral_profile_name()
            .expect("create exact read hardlink profile name")
            .replace('.', "-");
        let fixture = std::env::temp_dir().join(format!("sigma-exact-read-hardlink-{unique}"));
        let outside = std::env::temp_dir().join(format!("sigma-exact-read-hardlink-{unique}.txt"));
        let declared = fixture.join("declared.exe");
        std::fs::create_dir_all(&fixture).expect("create exact read hardlink fixture");
        std::fs::write(&outside, b"same authorized object")
            .expect("create exact read hardlink target");
        std::fs::hard_link(&outside, &declared).expect("create exact declared hardlink name");

        let mut plan = Vec::new();
        let mut planned_objects = 0;
        plan_read_tree(
            &declared,
            std::slice::from_ref(&declared),
            &[],
            &mut plan,
            &mut planned_objects,
            0,
        )
        .expect("authorize the explicitly declared read-only file object");
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].path, declared);
        assert!(!plan[0].inherit);

        std::fs::remove_file(&declared).expect("remove exact hardlink name");
        std::fs::remove_dir_all(&fixture).expect("remove exact hardlink fixture");
        std::fs::remove_file(&outside).expect("remove exact hardlink target");
    }

    #[test]
    fn initial_recovery_intent_never_replaces_an_existing_journal() {
        let unique = ephemeral_profile_name()
            .expect("create collision test profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-recovery-collision-{unique}"));
        let recovery = root.join("SigmaCode").join(RECOVERY_DIRECTORY);
        let profile_name = ephemeral_profile_name().expect("create collision profile name");
        let first = RecoveryJournal::create(&recovery, &profile_name)
            .expect("publish first recovery intent");
        let original = std::fs::read(&first.path).expect("read first recovery intent");
        RecoveryJournal::create(&recovery, &profile_name)
            .err()
            .expect("second initial intent must not replace the first");
        assert_eq!(
            std::fs::read(&first.path).expect("read preserved recovery intent"),
            original
        );
        first.remove().expect("remove collision recovery journal");
        std::fs::remove_dir_all(&root).expect("remove collision fixture");
    }

    #[test]
    fn rejects_a_junction_nested_inside_a_writable_root_before_acl_changes() {
        let unique = ephemeral_profile_name()
            .expect("create ACL test profile name")
            .replace('.', "-");
        let root = std::env::temp_dir().join(format!("sigma-acl-root-{unique}"));
        let outside = std::env::temp_dir().join(format!("sigma-acl-outside-{unique}"));
        let junction = root.join("linked-outside");
        std::fs::create_dir(&root).expect("create writable root");
        std::fs::create_dir(&outside).expect("create outside directory");
        let status = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()))
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("create test junction");
        assert!(
            status.success(),
            "mklink /J must succeed for the regression fixture"
        );
        let error = validate_acl_target_path(&junction, &root)
            .expect_err("nested junction must be rejected before ACL mutation");
        assert_eq!(error.code, "policy_denied");
        assert!(error.message.contains("reparse point"));
        std::fs::remove_dir(&junction).expect("remove test junction");
        std::fs::remove_dir(&root).expect("remove writable root");
        std::fs::remove_dir(&outside).expect("remove outside directory");
    }
}
