use crate::platform::PlatformGuard;
use crate::protocol::RpcError;
use crate::sandbox::{NetworkMode, PreparedCommand, ProcessParams, SandboxMode, minimal_roots};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::ffi::{OsStr, c_void};
use std::io::Write;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, LocalFree,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertSidToStringSidW, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetSecurityInfo, REVOKE_ACCESS,
    SE_FILE_OBJECT, SetEntriesInAclW, SetSecurityInfo, TRUSTEE_IS_SID, TRUSTEE_IS_UNKNOWN,
    TRUSTEE_W,
};
use windows_sys::Win32::Security::Isolation::{
    CreateAppContainerProfile, DeleteAppContainerProfile,
    DeriveAppContainerSidFromAppContainerName, GetAppContainerFolderPath,
};
use windows_sys::Win32::Security::{
    CreateWellKnownSid, DACL_SECURITY_INFORMATION, DeriveCapabilitySidsFromName, FreeSid,
    GetLengthSid, PSID, SECURITY_CAPABILITIES, SID_AND_ATTRIBUTES,
    SUB_CONTAINERS_AND_OBJECTS_INHERIT, WinBuiltinAnyPackageSid,
    WinCapabilityInternetClientServerSid, WinCapabilityInternetClientSid,
    WinCapabilityPrivateNetworkClientServerSid,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, DELETE, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FileAttributeTagInfo, GetFileInformationByHandleEx, GetFinalPathNameByHandleW, OPEN_EXISTING,
    READ_CONTROL, ReadFile, VOLUME_NAME_DOS, WRITE_DAC, WriteFile,
};
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::Console::{
    COORD, ClosePseudoConsole, CreatePseudoConsole, GetStdHandle, HPCON, STD_ERROR_HANDLE,
    STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList,
    EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, InitializeProcThreadAttributeList,
    PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, TerminateProcess,
    UpdateProcThreadAttribute, WaitForSingleObject,
};

const BASE_PROFILE: &str = "SigmaCode.Execution.v3";
const INTERNAL_LAUNCHER: &str = "--internal-appcontainer-launcher";
const INTERNAL_PROBE: &str = "--internal-appcontainer-probe";
const MAX_BOOTSTRAP_BYTES: usize = 8 * 1024 * 1024;
const ERROR_ALREADY_EXISTS_HRESULT: i32 = 0x8007_00b7_u32 as i32;
const INFINITE: u32 = u32::MAX;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
const SE_GROUP_ENABLED: u32 = 4;
const PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT: u32 = 1;
static PROFILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub(crate) fn try_run_internal_mode() -> Option<i32> {
    match std::env::args().nth(1).as_deref() {
        Some(INTERNAL_LAUNCHER) => Some(match run_launcher() {
            Ok(code) => code,
            Err(error) => {
                eprintln!(
                    "sigma-exec sandbox launch failed [{}]: {}",
                    error.code, error.message
                );
                125
            }
        }),
        Some(INTERNAL_PROBE) => Some(run_probe()),
        _ => None,
    }
}

pub(crate) fn prepare_command(params: &ProcessParams) -> Result<PreparedCommand, RpcError> {
    validate_writable_acl_trees(params)?;
    let payload = serde_json::to_vec(params).map_err(|error| {
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
    })
}

fn validate_writable_acl_trees(params: &ProcessParams) -> Result<(), RpcError> {
    let read = canonical_unique(&params.policy.read_roots)?;
    let write = canonical_unique(&params.policy.write_roots)?;
    let mut protected = params.policy.protected_paths.clone();
    protected.extend(
        minimal_roots(&read)
            .into_iter()
            .flat_map(|root| [root.join(".git"), root.join(".agent")]),
    );
    let protected = canonical_protected(&protected, &write)?;
    for root in &write {
        validate_writable_acl_tree(root, root, &protected)?;
    }
    Ok(())
}

fn validate_writable_acl_tree(
    path: &Path,
    writable_root: &Path,
    protected: &[PathBuf],
) -> Result<(), RpcError> {
    if protected.iter().any(|item| item == path) {
        return Ok(());
    }
    validate_acl_target_path(path, writable_root)?;
    let has_protected_descendant = protected.iter().any(|item| item.starts_with(path));
    if !has_protected_descendant || !path.is_dir() {
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
        )?;
    }
    Ok(())
}

pub(crate) fn setup() -> Result<(), RpcError> {
    match create_profile(BASE_PROFILE, false) {
        Ok(profile) => drop(profile),
        Err(error) if error.code == "sandbox_profile_exists" => {
            let sid = derive_profile_sid(BASE_PROFILE)?;
            unsafe {
                FreeSid(sid);
            }
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
    unsafe {
        FreeSid(sid);
    }
    self_test()
}

fn run_launcher() -> Result<i32, RpcError> {
    let params: ProcessParams = serde_json::from_slice(&read_bootstrap()?).map_err(|error| {
        RpcError::new(
            "broker_protocol_error",
            format!("invalid Windows sandbox bootstrap: {error}"),
        )
    })?;
    validate_launcher_params(&params)?;
    let profile_name = ephemeral_profile_name();
    let profile = create_profile(&profile_name, true)?;
    let mut acl_paths = Vec::new();
    let result = (|| {
        grant_policy_access(&params, profile.sid, &mut acl_paths)?;
        launch_appcontainer(&params, profile.sid)
    })();
    for path in acl_paths.iter().rev() {
        let _ = update_acl(path, profile.sid, 0, REVOKE_ACCESS, false);
    }
    drop(profile);
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
    {
        if !root.is_absolute() || !root.exists() {
            return Err(RpcError::new(
                "policy_denied",
                "all AppContainer roots must be existing absolute paths",
            ));
        }
    }
    Ok(())
}

struct Profile {
    name: String,
    sid: PSID,
    delete_on_drop: bool,
}

impl Drop for Profile {
    fn drop(&mut self) {
        unsafe {
            FreeSid(self.sid);
            if self.delete_on_drop {
                let name = wide_null(&self.name);
                DeleteAppContainerProfile(name.as_ptr());
            }
        }
    }
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

fn ephemeral_profile_name() -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let sequence = PROFILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!(
        "SigmaCode.Exec.{}.{}.{}",
        std::process::id(),
        timestamp,
        sequence
    )
}

fn grant_policy_access(
    params: &ProcessParams,
    sid: PSID,
    changed: &mut Vec<PathBuf>,
) -> Result<(), RpcError> {
    let read = canonical_unique(&params.policy.read_roots)?;
    let write = canonical_unique(&params.policy.write_roots)?;
    for path in &read {
        update_acl(
            path,
            sid,
            FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            GRANT_ACCESS,
            true,
        )?;
        changed.push(path.clone());
    }
    let mut protected = params.policy.protected_paths.clone();
    protected.extend(
        minimal_roots(&read)
            .into_iter()
            .flat_map(|root| [root.join(".git"), root.join(".agent")]),
    );
    let protected = canonical_protected(&protected, &write)?;
    for path in &write {
        grant_write_tree(path, path, &protected, sid, changed)?;
    }
    Ok(())
}

fn grant_write_tree(
    path: &Path,
    writable_root: &Path,
    protected: &[PathBuf],
    sid: PSID,
    changed: &mut Vec<PathBuf>,
) -> Result<(), RpcError> {
    if protected.iter().any(|item| item == path) {
        return Ok(());
    }
    let has_protected_descendant = protected.iter().any(|item| item.starts_with(path));
    update_acl_scoped(
        path,
        sid,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE,
        GRANT_ACCESS,
        !has_protected_descendant && path.is_dir(),
        Some(writable_root),
    )?;
    changed.push(path.to_owned());
    if !has_protected_descendant || !path.is_dir() {
        return Ok(());
    }
    let entries = std::fs::read_dir(path).map_err(|error| {
        RpcError::new(
            "policy_denied",
            format!(
                "cannot enumerate writable root '{}': {error}",
                path.display()
            ),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(RpcError::from)?;
        let child = entry.path();
        grant_write_tree(&child, writable_root, protected, sid, changed)?;
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
        let canonical = path.canonicalize().map_err(|error| {
            RpcError::new(
                "policy_denied",
                format!(
                    "cannot canonicalize sandbox root '{}': {error}",
                    path.display()
                ),
            )
        })?;
        let key = canonical.to_string_lossy().to_lowercase();
        if seen.insert(key) {
            result.push(canonical);
        }
    }
    Ok(result)
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
    update_acl_handle(&handle, path, sid, permissions, mode, inherit)
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

fn update_acl_handle(
    handle: &OwnedHandle,
    path: &Path,
    sid: PSID,
    permissions: u32,
    mode: i32,
    inherit: bool,
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
        return Err(win32_code_error("GetNamedSecurityInfoW", get));
    }
    let inheritance = if inherit && path.is_dir() {
        SUB_CONTAINERS_AND_OBJECTS_INHERIT
    } else {
        0
    };
    let entry = EXPLICIT_ACCESS_W {
        grfAccessPermissions: permissions,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid.cast(),
        },
    };
    let mut new_acl = null_mut();
    let merge = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
    if merge != 0 {
        unsafe {
            LocalFree(security_descriptor);
        }
        return Err(win32_code_error("SetEntriesInAclW", merge));
    }
    let set = unsafe {
        SetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            new_acl,
            null_mut(),
        )
    };
    unsafe {
        LocalFree(new_acl.cast());
        LocalFree(security_descriptor);
    }
    if set != 0 {
        return Err(win32_code_error("SetNamedSecurityInfoW", set));
    }
    Ok(())
}

fn validate_acl_target_path(path: &Path, writable_root: &Path) -> Result<(), RpcError> {
    let handle = open_acl_target(path)?;
    assert_acl_handle_target(&handle, path, Some(writable_root))
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        unsafe {
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

fn windows_path_within(root: &Path, candidate: &Path) -> bool {
    let normalize = |value: &Path| {
        value
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    let root = normalize(root);
    let candidate = normalize(candidate);
    candidate == root
        || candidate
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('\\'))
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
    let mut in_job = 0;
    if unsafe { IsProcessInJob(process_handles.0.hProcess, null_mut(), &mut in_job) } == 0
        || in_job == 0
    {
        unsafe {
            TerminateProcess(process_handles.0.hProcess, 125);
        }
        return Err(RpcError::new(
            "process_containment_failed",
            "AppContainer child did not inherit the broker Job Object",
        ));
    }
    if unsafe { ResumeThread(process_handles.0.hThread) } == u32::MAX {
        unsafe {
            TerminateProcess(process_handles.0.hProcess, 125);
        }
        return Err(last_error("ResumeThread"));
    }
    let output_proxy = if let Some(console) = pseudo.as_mut() {
        Some(console.start_proxy(stdin, stdout)?)
    } else {
        None
    };
    unsafe {
        WaitForSingleObject(process_handles.0.hProcess, INFINITE);
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
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
        .ok_or_else(|| {
            RpcError::new(
                "process_spawn_failed",
                format!("cannot resolve executable '{}'", params.command.executable),
            )
        })
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
    let local_app_data = profile_folder
        .ancestors()
        .nth(3)
        .filter(|path| path.join("Packages").is_dir())
        .ok_or_else(|| {
            RpcError::new(
                "sandbox_unavailable",
                format!(
                    "AppContainer profile folder has an unexpected layout: '{}'",
                    profile_folder.display()
                ),
            )
        })?;
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
    let unique = ephemeral_profile_name().replace('.', "-");
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
    for key in ["SystemRoot", "WINDIR", "PATH", "PATHEXT"] {
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
    pty_params.command.executable = env_value(&pty_params.command.env, "ComSpec")
        .map(str::to_owned)
        .or_else(|| {
            env_value(&pty_params.command.env, "SystemRoot").map(|root| {
                Path::new(root)
                    .join("System32")
                    .join("cmd.exe")
                    .to_string_lossy()
                    .into_owned()
            })
        })
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
    let guard = PlatformGuard::attach(&mut child)?;
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

    #[test]
    fn quotes_windows_arguments_without_losing_backslashes() {
        assert_eq!(quote_windows_argument("plain"), "plain");
        assert_eq!(quote_windows_argument(""), "\"\"");
        assert_eq!(quote_windows_argument("a b"), "\"a b\"");
        assert_eq!(quote_windows_argument("a\\\"b"), "\"a\\\\\\\"b\"");
        assert_eq!(quote_windows_argument("tail\\"), "tail\\");
    }

    #[test]
    fn rejects_a_junction_nested_inside_a_writable_root_before_acl_changes() {
        let unique = ephemeral_profile_name().replace('.', "-");
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
