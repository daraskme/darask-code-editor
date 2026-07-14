//! keyring ラッパ(PHASE3A-SPEC.md 2.1)。
//! service = "darask", user = format!("provider:{id}") で keyring::Entry を使う。
//! 値そのものはフロントへ返さない(has_secret は真偽値のみ、get_secret は Rust 内部専用)。

use keyring::Entry;

const SERVICE: &str = "darask";

fn entry_for(id: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, &format!("provider:{id}")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn has_secret(id: String) -> bool {
    match entry_for(&id) {
        Ok(entry) => entry.get_password().is_ok(),
        Err(_) => false,
    }
}

#[tauri::command]
pub fn set_secret(id: String, value: String) -> Result<(), String> {
    let entry = entry_for(&id)?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_secret(id: String) -> Result<(), String> {
    let entry = entry_for(&id)?;
    entry.delete_credential().map_err(|e| e.to_string())
}

/// Rust 内部の他モジュール(providers 系等)から呼ぶための非 tauri::command な関数。
/// フロント向け invoke コマンドとしては公開しない。
pub fn get_secret(id: &str) -> Result<String, String> {
    let entry = entry_for(id)?;
    entry.get_password().map_err(|e| e.to_string())
}
