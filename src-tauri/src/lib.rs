mod acp;
mod commands;
mod providers;
mod secrets;
mod usage;

use acp::manager::AcpManagerState;
use commands::fs::{
    create_dir, create_file, delete_to_trash, read_dir, read_file, rename_path, set_workspace_root,
    write_file,
};
use commands::{
    acp_abort_pending_start, acp_cancel, acp_close_session, acp_list_agents,
    acp_respond_permission, acp_send_prompt, acp_start_session, acp_test_agent, ai_chat_stream,
    ai_list_models, ai_test_connection, openrouter_credits, openrouter_key_info, usage_summary,
};
use rusqlite::Connection;
use secrets::{delete_secret, has_secret, set_secret};
use std::sync::{Mutex as StdMutex, RwLock};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

/// 設定 UI の「APIキーを取得 ↗」リンクから呼ばれる。既定ブラウザで URL を開く。
/// フロント側で直接 `@tauri-apps/plugin-opener` の `openUrl()` を呼ぶ代わりにこちらを経由し、
/// 失敗時の理由を eprintln でターミナルに出す(フロントの console.error だけだと
/// ネイティブウィンドウの DevTools を開かないと確認できないため)。
#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    const ALLOWED_URL_PREFIXES: [&str; 4] = [
        "https://openrouter.ai/",
        "https://dash.cloudflare.com/",
        "https://console.anthropic.com/",
        "https://platform.openai.com/",
    ];

    let normalized_url = url.trim();
    if !ALLOWED_URL_PREFIXES
        .iter()
        .any(|prefix| normalized_url.starts_with(prefix))
    {
        return Err("this external URL is not allowed".to_string());
    }

    app.opener()
        .open_url(normalized_url, None::<&str>)
        .map_err(|e| {
            let msg = format!("open_external_url failed for \"{normalized_url}\": {e}");
            eprintln!("{msg}");
            msg
        })
}

/// Phase3a: ACP / Provider / 使用量ダッシュボードで共有する State
/// (PHASE3A-SPEC.md 2.1 lib.rs 契約)。
/// ACP セッション管理は `tokio::sync::Mutex<AcpManagerState>` として独立に `.manage()` する
/// (acp/mod.rs / acp/manager.rs の integrate コメント通り)。
pub struct AppState {
    pub usage_db: Mutex<Connection>,
    /// The canonical root selected by the user. Filesystem commands must prove their
    /// target remains beneath this path before accessing it.
    pub workspace_root: RwLock<Option<std::path::PathBuf>>,
    /// Serializes mutating filesystem operations so two saves in this process cannot
    /// interleave their revision check and atomic replacement.
    pub workspace_operation_lock: StdMutex<()>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // usage.db をアプリデータディレクトリ配下に作成・マイグレーション(PHASE3A-SPEC.md 2.1)。
            // スキーマは usage::store::SCHEMA_SQL(Agent D 所有)を単一の情報源として使う。
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let conn = Connection::open(app_data_dir.join("usage.db"))?;
            usage::store::init_db(&conn).map_err(std::io::Error::other)?;

            app.manage(AppState {
                usage_db: Mutex::new(conn),
                workspace_root: RwLock::new(None),
                workspace_operation_lock: StdMutex::new(()),
            });
            app.manage(Mutex::new(AcpManagerState::default()));

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            set_workspace_root,
            read_dir,
            read_file,
            write_file,
            create_file,
            create_dir,
            rename_path,
            delete_to_trash,
            has_secret,
            set_secret,
            delete_secret,
            acp_list_agents,
            acp_start_session,
            acp_abort_pending_start,
            acp_send_prompt,
            acp_cancel,
            acp_respond_permission,
            acp_close_session,
            acp_test_agent,
            ai_chat_stream,
            ai_list_models,
            ai_test_connection,
            openrouter_key_info,
            openrouter_credits,
            usage_summary,
            open_external_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
