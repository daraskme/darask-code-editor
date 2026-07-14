// Agent F 所有(PHASE3A-SPEC.md 3.2)。ACP 関連 Tauri コマンドの invoke ラッパ + イベント購読。
// tauriEvents.ts(Agent A)には依存せず、@tauri-apps/api/event を直接使って自己完結させる。
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from './fs';

const NOT_TAURI_ERROR = 'not running in Tauri';

// Rust 側 AgentConfig の想定シリアライズ形(src-tauri/src/acp/agents_config.rs、Agent B 所有)。
// フィールド名の確定は統合時に要確認(fs.ts の DirEntry と同様、snake_case で来る可能性を考慮して緩く受ける)。
interface RawAgentConfig {
  id: string;
  name?: string;
  label?: string;
  command: string;
  args?: string[];
  description?: string | null;
  secretId?: string | null;
  secret_id?: string | null;
}

export interface AgentConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  description: string | null;
  /** 認証情報を保存する secrets キー(例: "agent:claude-code")。null ならこのエージェントは
   * 認証キー設定UI対象外(Rust 側 AgentConfig.secret_id、src-tauri/src/acp/agents_config.rs)。 */
  secretId: string | null;
}

function normalizeAgentConfig(raw: RawAgentConfig): AgentConfig {
  return {
    id: raw.id,
    name: raw.name ?? raw.label ?? raw.id,
    command: raw.command,
    args: raw.args ?? [],
    description: raw.description ?? null,
    secretId: raw.secretId ?? raw.secret_id ?? null,
  };
}

export async function listAgents(): Promise<AgentConfig[]> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  const raw = await invoke<RawAgentConfig[]>('acp_list_agents');
  return raw.map(normalizeAgentConfig);
}

export async function startSession(agentId: string, cwd: string, pendingId: string): Promise<string> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  return invoke<string>('acp_start_session', { agentId, cwd, pendingId });
}

/**
 * 起動中(まだ initialize/session/new の応答待ち)のセッション開始を強制終了する。
 * `npx` の初回パッケージダウンロード等でハングした場合に、対応する `startSession` の
 * invoke がいつまでも解決しない状況をユーザーが中断できるようにする。
 */
export async function abortPendingStart(pendingId: string): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  return invoke<void>('acp_abort_pending_start', { pendingId });
}

export async function sendPrompt(sessionId: string, text: string): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  return invoke<void>('acp_send_prompt', { sessionId, text });
}

export async function cancel(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  return invoke<void>('acp_cancel', { sessionId });
}

export async function respondPermission(requestId: string, optionId: string): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  return invoke<void>('acp_respond_permission', { requestId, optionId });
}

export async function closeSession(sessionId: string): Promise<void> {
  if (!isTauri()) return Promise.reject(new Error(NOT_TAURI_ERROR));
  return invoke<void>('acp_close_session', { sessionId });
}

/**
 * エージェント認証UIの「接続テスト」用。子プロセスを一時起動し initialize 応答が
 * 返るかどうかで成否を判定する(`acp_test_agent`、詳細は src-tauri/src/acp/manager.rs)。
 * Tauri 外(ブラウザプレビュー)や invoke 失敗時は false を返す(例外を投げない)。
 */
export async function testAgent(agentId: string): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await invoke<boolean>('acp_test_agent', { agentId });
  } catch (err) {
    console.error(`testAgent failed for "${agentId}":`, err);
    return false;
  }
}

/**
 * `acp://{sessionId}/update` を購読する。ペイロードの実形は Rust 側(Agent B)の実装に依存するため
 * `unknown` のまま acpStore.handleSessionUpdate へ渡し、そちら側で防御的にパースする。
 * ブラウザプレビュー(Tauri 外)では何もしない no-op unlisten を返す。
 */
export async function subscribeSessionUpdates(
  sessionId: string,
  onEvent: (payload: unknown) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen(`acp://${sessionId}/update`, (event) => onEvent(event.payload));
}

/**
 * `acp://permission-request` を購読する(セッション横断のグローバルイベント)。
 * ペイロードの実形は Rust 側実装依存のため `unknown` のまま acpStore.addPermissionRequest へ渡す。
 */
export async function subscribePermissionRequests(onEvent: (payload: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen('acp://permission-request', (event) => onEvent(event.payload));
}
