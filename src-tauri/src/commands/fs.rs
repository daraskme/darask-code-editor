use crate::AppState;
use sha2::{Digest, Sha256};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions, Permissions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::State;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;
const UTF8_BOM: &[u8; 3] = b"\xEF\xBB\xBF";
const TEMP_FILE_RETRY_LIMIT: usize = 128;

static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub content: String,
    pub revision: String,
    pub has_bom: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteFileResult {
    pub revision: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathResult {
    pub path: String,
}

struct FileSnapshot {
    revision: String,
    has_bom: bool,
}

struct WriteTarget {
    path: PathBuf,
    existing_permissions: Option<Permissions>,
}

fn workspace_root(state: &AppState) -> Result<PathBuf, String> {
    state
        .workspace_root
        .read()
        .map_err(|_| "workspace state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "workspace is not open".to_string())
}

fn mutation_lock(state: &AppState) -> Result<std::sync::MutexGuard<'_, ()>, String> {
    state
        .workspace_operation_lock
        .lock()
        .map_err(|_| "workspace operation lock is unavailable".to_string())
}

fn path_from_request(root: &Path, requested_path: &str) -> PathBuf {
    let requested = PathBuf::from(requested_path);
    if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    }
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn ensure_within_workspace(root: &Path, candidate: &Path) -> Result<(), String> {
    if candidate.starts_with(root) {
        Ok(())
    } else {
        Err("path is outside the workspace".to_string())
    }
}

fn reject_final_symlink(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("symbolic links and junctions are not supported".to_string());
    }
    Ok(())
}

fn resolve_existing_path(root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    let requested = path_from_request(root, requested_path);
    reject_final_symlink(&requested)?;

    let canonical = fs::canonicalize(&requested).map_err(|error| error.to_string())?;
    ensure_within_workspace(root, &canonical)?;
    Ok(canonical)
}

fn resolve_new_path(root: &Path, requested_path: &str) -> Result<PathBuf, String> {
    let requested = path_from_request(root, requested_path);
    match fs::symlink_metadata(&requested) {
        Ok(_) => return Err("path already exists".to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let parent = requested
        .parent()
        .ok_or_else(|| "path must have a parent directory".to_string())?;
    let name = requested
        .file_name()
        .filter(|name| !name.is_empty() && *name != OsStr::new(".") && *name != OsStr::new(".."))
        .ok_or_else(|| "path must name a file or directory".to_string())?;

    let canonical_parent = fs::canonicalize(parent).map_err(|error| error.to_string())?;
    let parent_metadata = fs::metadata(&canonical_parent).map_err(|error| error.to_string())?;
    if !parent_metadata.is_dir() {
        return Err("path parent is not a directory".to_string());
    }
    ensure_within_workspace(root, &canonical_parent)?;

    Ok(canonical_parent.join(name))
}

fn resolve_write_target(root: &Path, requested_path: &str) -> Result<WriteTarget, String> {
    let requested = path_from_request(root, requested_path);
    match fs::symlink_metadata(&requested) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("symbolic links and junctions are not supported".to_string());
            }

            let canonical = fs::canonicalize(&requested).map_err(|error| error.to_string())?;
            ensure_within_workspace(root, &canonical)?;
            let target_metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
            if !target_metadata.is_file() {
                return Err("path is not a regular file".to_string());
            }

            Ok(WriteTarget {
                path: canonical,
                existing_permissions: Some(target_metadata.permissions()),
            })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(WriteTarget {
            path: resolve_new_path(root, requested_path)?,
            existing_permissions: None,
        }),
        Err(error) => Err(error.to_string()),
    }
}

fn read_bounded_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|error| error.to_string())?;
    let mut reader = file.take(MAX_FILE_SIZE + 1);
    let mut bytes = Vec::with_capacity(MAX_FILE_SIZE as usize);
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;

    if bytes.len() as u64 > MAX_FILE_SIZE {
        return Err("file too large".to_string());
    }

    Ok(bytes)
}

fn revision_for(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";

    let digest = Sha256::digest(bytes);
    let mut revision = String::with_capacity(digest.len() * 2);
    for byte in digest {
        revision.push(HEX[(byte >> 4) as usize] as char);
        revision.push(HEX[(byte & 0x0f) as usize] as char);
    }
    revision
}

fn inspect_file(path: &Path) -> Result<FileSnapshot, String> {
    let bytes = read_bounded_bytes(path)?;
    Ok(FileSnapshot {
        revision: revision_for(&bytes),
        has_bom: bytes.starts_with(UTF8_BOM),
    })
}

fn create_temporary_file(parent: &Path) -> Result<(File, PathBuf), String> {
    let process_id = std::process::id();
    for _ in 0..TEMP_FILE_RETRY_LIMIT {
        let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".darask-save-{process_id}-{counter}.tmp"));
        match OpenOptions::new().create_new(true).write(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }

    Err("could not create a unique temporary file".to_string())
}

fn remove_temporary_file(path: &Path) {
    if let Err(error) = fs::remove_file(path) {
        if error.kind() != io::ErrorKind::NotFound {
            eprintln!(
                "failed to remove temporary save file {}: {error}",
                path.display()
            );
        }
    }
}

fn write_temporary_file(
    parent: &Path,
    bytes: &[u8],
    permissions: Option<&Permissions>,
) -> Result<PathBuf, String> {
    let (mut file, temporary_path) = create_temporary_file(parent)?;
    let result = (|| -> Result<(), io::Error> {
        file.write_all(bytes)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions.clone())?;
        }
        file.sync_all()?;
        Ok(())
    })();
    drop(file);

    if let Err(error) = result {
        remove_temporary_file(&temporary_path);
        return Err(error.to_string());
    }

    Ok(temporary_path)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> Result<(), String> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> Result<(), String> {
    Ok(())
}

fn replace_with_temporary_file(temporary_path: &Path, target: &Path) -> Result<(), String> {
    if let Err(error) = fs::rename(temporary_path, target) {
        remove_temporary_file(temporary_path);
        return Err(error.to_string());
    }

    let parent = target
        .parent()
        .ok_or_else(|| "path must have a parent directory".to_string())?;
    sync_parent_directory(parent)
}

/// Sets the sole workspace root. Every filesystem command resolves paths beneath this
/// canonical directory, which prevents `..`, symlink, and junction escapes.
#[tauri::command(rename_all = "camelCase")]
pub fn set_workspace_root(path: String, state: State<'_, AppState>) -> Result<String, String> {
    let _operation_guard = mutation_lock(&state)?;
    let canonical = fs::canonicalize(&path).map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&canonical).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err("workspace root must be a directory".to_string());
    }

    *state
        .workspace_root
        .write()
        .map_err(|_| "workspace state is unavailable".to_string())? = Some(canonical.clone());

    Ok(path_to_string(&canonical))
}

/// Reads one workspace directory. Symbolic-link and junction entries are intentionally
/// omitted so the UI cannot later operate on a path that resolves outside the workspace.
#[tauri::command(rename_all = "camelCase")]
pub fn read_dir(path: String, state: State<'_, AppState>) -> Result<Vec<DirEntry>, String> {
    let root = workspace_root(&state)?;
    let directory = resolve_existing_path(&root, &path)?;
    let metadata = fs::metadata(&directory).map_err(|error| error.to_string())?;
    if !metadata.is_dir() {
        return Err("path is not a directory".to_string());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }

        let entry_path = entry.path();
        let canonical = match fs::canonicalize(&entry_path) {
            Ok(path) if path.starts_with(&root) => path,
            Ok(_) | Err(_) => continue,
        };
        let entry_metadata = match fs::metadata(&canonical) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };

        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path_to_string(&canonical),
            is_dir: entry_metadata.is_dir(),
        });
    }

    entries.sort_by(|left, right| match (left.is_dir, right.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
    });

    Ok(entries)
}

/// Reads a UTF-8 text file with a strict 10 MiB cap. The cap is enforced while reading,
/// rather than trusting metadata that could change between the size check and the read.
#[tauri::command(rename_all = "camelCase")]
pub fn read_file(path: String, state: State<'_, AppState>) -> Result<ReadFileResult, String> {
    let root = workspace_root(&state)?;
    let target = resolve_existing_path(&root, &path)?;
    let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("path is not a regular file".to_string());
    }

    let bytes = read_bounded_bytes(&target)?;
    let has_bom = bytes.starts_with(UTF8_BOM);
    let content_bytes = if has_bom {
        &bytes[UTF8_BOM.len()..]
    } else {
        &bytes
    };
    let content = std::str::from_utf8(content_bytes)
        .map_err(|_| "binary file".to_string())?
        .to_owned();

    Ok(ReadFileResult {
        content,
        revision: revision_for(&bytes),
        has_bom,
    })
}

/// Writes through a same-directory temporary file, flushes it, and then atomically replaces
/// the target. If a caller supplies an old revision, a changed or deleted file is never
/// overwritten silently.
#[tauri::command(rename_all = "camelCase")]
pub fn write_file(
    path: String,
    contents: String,
    expected_revision: Option<String>,
    has_bom: Option<bool>,
    state: State<'_, AppState>,
) -> Result<WriteFileResult, String> {
    let _operation_guard = mutation_lock(&state)?;
    let root = workspace_root(&state)?;
    let target = resolve_write_target(&root, &path)?;
    let existing = if target.existing_permissions.is_some() {
        Some(inspect_file(&target.path)?)
    } else {
        None
    };

    if let Some(expected_revision) = expected_revision.as_deref() {
        match &existing {
            Some(snapshot) if snapshot.revision == expected_revision => {}
            Some(_) => return Err("conflict: file changed on disk".to_string()),
            None => return Err("conflict: file was deleted".to_string()),
        }
    }

    let has_bom = has_bom.unwrap_or_else(|| {
        existing
            .as_ref()
            .map(|snapshot| snapshot.has_bom)
            .unwrap_or(false)
    });
    let byte_len = contents.len() + usize::from(has_bom) * UTF8_BOM.len();
    if byte_len as u64 > MAX_FILE_SIZE {
        return Err("file too large".to_string());
    }

    let mut bytes = Vec::with_capacity(byte_len);
    if has_bom {
        bytes.extend_from_slice(UTF8_BOM);
    }
    bytes.extend_from_slice(contents.as_bytes());

    let parent = target
        .path
        .parent()
        .ok_or_else(|| "path must have a parent directory".to_string())?;
    let temporary_path =
        write_temporary_file(parent, &bytes, target.existing_permissions.as_ref())?;

    if let Some(expected_revision) = expected_revision.as_deref() {
        let current = match inspect_file(&target.path) {
            Ok(snapshot) => snapshot,
            Err(_) => {
                remove_temporary_file(&temporary_path);
                return Err("conflict: file was deleted or is no longer readable".to_string());
            }
        };
        if current.revision != expected_revision {
            remove_temporary_file(&temporary_path);
            return Err("conflict: file changed on disk".to_string());
        }
    }

    replace_with_temporary_file(&temporary_path, &target.path)?;

    Ok(WriteFileResult {
        revision: revision_for(&bytes),
    })
}

/// Creates an empty file without replacing an existing item.
#[tauri::command(rename_all = "camelCase")]
pub fn create_file(path: String, state: State<'_, AppState>) -> Result<WriteFileResult, String> {
    let _operation_guard = mutation_lock(&state)?;
    let root = workspace_root(&state)?;
    let target = resolve_new_path(&root, &path)?;

    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&target)
        .map_err(|error| {
            if error.kind() == io::ErrorKind::AlreadyExists {
                "path already exists".to_string()
            } else {
                error.to_string()
            }
        })?;
    file.sync_all().map_err(|error| error.to_string())?;

    Ok(WriteFileResult {
        revision: revision_for(&[]),
    })
}

/// Creates one new directory below the workspace. Parent directories must already exist.
#[tauri::command(rename_all = "camelCase")]
pub fn create_dir(path: String, state: State<'_, AppState>) -> Result<PathResult, String> {
    let _operation_guard = mutation_lock(&state)?;
    let root = workspace_root(&state)?;
    let target = resolve_new_path(&root, &path)?;
    fs::create_dir(&target).map_err(|error| {
        if error.kind() == io::ErrorKind::AlreadyExists {
            "path already exists".to_string()
        } else {
            error.to_string()
        }
    })?;

    let canonical = fs::canonicalize(&target).map_err(|error| error.to_string())?;
    ensure_within_workspace(&root, &canonical)?;
    Ok(PathResult {
        path: path_to_string(&canonical),
    })
}

/// Renames a workspace file or directory. Existing destinations are never overwritten.
#[tauri::command(rename_all = "camelCase")]
pub fn rename_path(
    path: String,
    new_path: String,
    state: State<'_, AppState>,
) -> Result<PathResult, String> {
    let _operation_guard = mutation_lock(&state)?;
    let root = workspace_root(&state)?;
    let source = resolve_existing_path(&root, &path)?;
    if source == root {
        return Err("workspace root cannot be renamed".to_string());
    }
    let destination = resolve_new_path(&root, &new_path)?;
    if destination.starts_with(&source) {
        return Err("a directory cannot be moved into itself".to_string());
    }

    fs::rename(&source, &destination).map_err(|error| error.to_string())?;
    Ok(PathResult {
        path: path_to_string(&destination),
    })
}

/// Moves a workspace item to the operating system trash. There is deliberately no hard-delete
/// fallback, so a failed trash operation never destroys the user's data.
#[tauri::command(rename_all = "camelCase")]
pub fn delete_to_trash(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let _operation_guard = mutation_lock(&state)?;
    let root = workspace_root(&state)?;
    let target = resolve_existing_path(&root, &path)?;
    if target == root {
        return Err("workspace root cannot be deleted".to_string());
    }

    trash::delete(&target).map_err(|error| error.to_string())
}
