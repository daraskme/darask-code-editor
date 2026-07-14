// Agent F 所有(PHASE3A-SPEC.md 3.2)。ACP セッション・メッセージ・ツールコール・
// permission request の状態を保持する。
import { create } from 'zustand';
import {
  abortPendingStart as acpAbortPendingStart,
  cancel as acpCancel,
  closeSession as acpCloseSession,
  listAgents as acpListAgents,
  respondPermission as acpRespondPermission,
  sendPrompt as acpSendPrompt,
  startSession as acpStartSession,
  subscribePermissionRequests,
  subscribeSessionUpdates,
  type AgentConfig,
} from '../lib/acp';

export type MessageRole = 'user' | 'agent';

export interface AgentMessage {
  id: string;
  role: MessageRole;
  text: string;
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCall {
  id: string;
  title: string;
  status: ToolCallStatus;
  // ACP の tool_call content は種類(diff/content/terminal 等)がエージェント依存で多様なため
  // unknown[] のまま保持し、ToolCallCard/DiffPreview 側で防御的に描画する。
  content: unknown[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: string;
}

export interface PendingPermission {
  requestId: string;
  toolCallId: string | null;
  options: PermissionOption[];
}

export interface AcpSession {
  agentId: string;
  messages: AgentMessage[];
  toolCalls: Record<string, ToolCall>;
  plan: unknown;
}

interface AcpState {
  sessions: Record<string, AcpSession>;
  pendingPermissions: PendingPermission[];
  activeSessionId: string | null;

  // 以下は PHASE3A-SPEC 3.2 の必須アクション(startSession/sendPrompt/handleSessionUpdate/
  // addPermissionRequest/resolvePermission)に加え、AI-DESIGN.md 2.3(エージェント一覧・停止・
  // セッション終了)の UI 要件を満たすための付随状態・アクション。
  agents: AgentConfig[];
  agentsLoading: boolean;
  agentsError: string | null;
  starting: boolean;
  startError: string | null;
  // 起動処理中の子プロセスを Rust 側 (AcpManagerState.starting_processes) に対応付ける ID。
  // セッション開始がハングした場合に abortStart() で強制終了できるようにするための追跡状態
  // (レビュー指摘: 修正2)。起動が完了(成功/失敗どちらでも)したら null に戻す。
  startingPendingId: string | null;

  loadAgents(): Promise<void>;
  startSession(agentId: string, cwd: string): Promise<void>;
  sendPrompt(text: string): Promise<void>;
  handleSessionUpdate(sessionId: string, payload: unknown): void;
  addPermissionRequest(payload: unknown): void;
  resolvePermission(requestId: string, optionId: string): Promise<void>;
  cancel(): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  abortStart(): Promise<void>;
}

// セッション単位の購読解除・ストリーミング中メッセージ ID はストアの公開状態に含めない内部簿記。
const sessionUnlisten: Record<string, () => void> = {};
const streamingAgentMessageId: Record<string, string | undefined> = {};
let permissionSubscribed = false;
let idCounter = 0;

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${Date.now()}-${idCounter}`;
}

function errString(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- session/update ペイロードの防御的パース ------------------------------------
// 実 ACP 仕様では通知フィールドは `sessionUpdate`(判別子)。Rust 側(Agent B)が
// 通知の params をそのまま転送するか `{ sessionId, update }` で包むかが未確定なため両対応する。
// TODO(integrate): Agent B の実装確定後、実ペイロード形状に合わせて調整すること。
interface RawSessionUpdateInput {
  sessionUpdate?: unknown;
  update?: unknown;
  [key: string]: unknown;
}

interface RawSessionUpdate {
  sessionUpdate: string;
  content?: unknown;
  toolCallId?: unknown;
  title?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

function normalizeSessionUpdate(payload: unknown): RawSessionUpdate | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as RawSessionUpdateInput;
  if (typeof obj.sessionUpdate === 'string') return obj as RawSessionUpdate;
  if (obj.update && typeof obj.update === 'object') {
    const inner = obj.update as RawSessionUpdateInput;
    if (typeof inner.sessionUpdate === 'string') return inner as RawSessionUpdate;
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
  }
  return '';
}

function toContentArray(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (content === undefined || content === null) return [];
  return [content];
}

function normalizeStatus(value: unknown): ToolCallStatus | null {
  if (value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed') {
    return value;
  }
  return null;
}

// --- permission-request ペイロードの防御的パース ---------------------------------
// TODO(integrate): 実 ACP `session/request_permission` は toolCall 情報が `toolCall.toolCallId`
// にネストされる想定(AI-DESIGN.md 2.1)。Rust 側転送形状確定後に調整すること。
function coerceId(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function extractToolCallId(obj: Record<string, unknown>): string | null {
  const direct = coerceId(obj.toolCallId);
  if (direct) return direct;
  const toolCall = obj.toolCall;
  if (toolCall && typeof toolCall === 'object') {
    const tc = toolCall as Record<string, unknown>;
    return coerceId(tc.toolCallId) ?? coerceId(tc.id);
  }
  return null;
}

function parsePermissionRequest(payload: unknown): PendingPermission | null {
  if (!payload || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  const requestId = coerceId(obj.requestId) ?? coerceId(obj.id);
  if (!requestId) return null;
  const rawOptions = obj.options;
  if (!Array.isArray(rawOptions)) return null;
  const options: PermissionOption[] = [];
  for (const item of rawOptions) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const optionId = coerceId(o.optionId) ?? coerceId(o.id);
    const name = typeof o.name === 'string' ? o.name : null;
    if (optionId && name) {
      options.push({ optionId, name, kind: typeof o.kind === 'string' ? o.kind : undefined });
    }
  }
  if (options.length === 0) return null;
  return { requestId, toolCallId: extractToolCallId(obj), options };
}

function ensurePermissionSubscription(): void {
  if (permissionSubscribed) return;
  permissionSubscribed = true;
  subscribePermissionRequests((payload) => {
    useAcpStore.getState().addPermissionRequest(payload);
  }).catch((err) => {
    permissionSubscribed = false;
    console.error('subscribePermissionRequests failed:', err);
  });
}

export const useAcpStore = create<AcpState>()((set, get) => ({
  sessions: {},
  pendingPermissions: [],
  activeSessionId: null,
  agents: [],
  agentsLoading: false,
  agentsError: null,
  starting: false,
  startError: null,
  startingPendingId: null,

  async loadAgents() {
    set({ agentsLoading: true, agentsError: null });
    try {
      const agents = await acpListAgents();
      set({ agents, agentsLoading: false });
    } catch (err) {
      console.error('loadAgents failed:', err);
      set({ agentsLoading: false, agentsError: errString(err) });
    }
  },

  async startSession(agentId: string, cwd: string) {
    ensurePermissionSubscription();
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set({ starting: true, startError: null, startingPendingId: pendingId });
    try {
      const sessionId = await acpStartSession(agentId, cwd, pendingId);
      set((s) => ({
        sessions: { ...s.sessions, [sessionId]: { agentId, messages: [], toolCalls: {}, plan: null } },
        activeSessionId: sessionId,
        starting: false,
        startingPendingId: null,
      }));
      const unlisten = await subscribeSessionUpdates(sessionId, (payload) => {
        get().handleSessionUpdate(sessionId, payload);
      });
      sessionUnlisten[sessionId] = unlisten;
    } catch (err) {
      console.error(`startSession failed for agent "${agentId}":`, err);
      set({ starting: false, startError: errString(err), startingPendingId: null });
    }
  },

  async sendPrompt(text: string) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const session = get().sessions[sessionId];
    if (!session) return;

    streamingAgentMessageId[sessionId] = undefined;
    const userMessage: AgentMessage = { id: nextId('user'), role: 'user', text: trimmed };
    set((s) => ({
      sessions: {
        ...s.sessions,
        [sessionId]: { ...s.sessions[sessionId], messages: [...s.sessions[sessionId].messages, userMessage] },
      },
    }));

    try {
      await acpSendPrompt(sessionId, trimmed);
    } catch (err) {
      console.error(`sendPrompt failed for session "${sessionId}":`, err);
      const errorMessage: AgentMessage = { id: nextId('agent'), role: 'agent', text: `エラー: ${errString(err)}` };
      set((s) => {
        const current = s.sessions[sessionId];
        if (!current) return s;
        return {
          sessions: { ...s.sessions, [sessionId]: { ...current, messages: [...current.messages, errorMessage] } },
        };
      });
    }
  },

  handleSessionUpdate(sessionId: string, payload: unknown) {
    const update = normalizeSessionUpdate(payload);
    if (!update) return;
    set((s) => {
      const session = s.sessions[sessionId];
      if (!session) return s;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = extractText(update.content);
          if (!text) return s;
          const currentId = streamingAgentMessageId[sessionId];
          const last = session.messages[session.messages.length - 1];
          let messages: AgentMessage[];
          if (currentId && last && last.id === currentId && last.role === 'agent') {
            messages = session.messages.map((m) => (m.id === currentId ? { ...m, text: m.text + text } : m));
          } else {
            const id = nextId('agent');
            streamingAgentMessageId[sessionId] = id;
            messages = [...session.messages, { id, role: 'agent', text }];
          }
          return { sessions: { ...s.sessions, [sessionId]: { ...session, messages } } };
        }

        case 'tool_call':
        case 'tool_call_update': {
          const toolCallId = coerceId(update.toolCallId);
          if (!toolCallId) return s;
          const existing = session.toolCalls[toolCallId];
          const status = normalizeStatus(update.status) ?? existing?.status ?? 'pending';
          const title = typeof update.title === 'string' ? update.title : (existing?.title ?? toolCallId);
          const content = update.content !== undefined ? toContentArray(update.content) : (existing?.content ?? []);
          const toolCall: ToolCall = { id: toolCallId, title, status, content };
          return {
            sessions: {
              ...s.sessions,
              [sessionId]: { ...session, toolCalls: { ...session.toolCalls, [toolCallId]: toolCall } },
            },
          };
        }

        case 'plan': {
          return { sessions: { ...s.sessions, [sessionId]: { ...session, plan: update } } };
        }

        default:
          // agent_thought_chunk / usage_update 等は Phase3a では UI 表示対象外(TODO: Phase3b で検討)。
          return s;
      }
    });
  },

  addPermissionRequest(payload: unknown) {
    const request = parsePermissionRequest(payload);
    if (!request) return;
    set((s) => ({ pendingPermissions: [...s.pendingPermissions, request] }));
  },

  async resolvePermission(requestId: string, optionId: string) {
    set((s) => ({ pendingPermissions: s.pendingPermissions.filter((p) => p.requestId !== requestId) }));
    try {
      await acpRespondPermission(requestId, optionId);
    } catch (err) {
      console.error(`resolvePermission failed for request "${requestId}":`, err);
    }
  },

  /**
   * `startSession` がハングした場合(例: npx の初回パッケージダウンロード待ちや
   * エージェントが応答しない)に、ユーザーがキャンセルできるようにするアクション
   * (レビュー指摘: 修正2)。Rust 側の子プロセスを強制終了し、starting/startError を
   * リセットする。対応する `startSession` の invoke は、プロセス終了検知経由で
   * エラーとして解決される(startingPendingId は既にリセットしているため、その
   * catch ブロックの set は無害な二重リセットになる)。
   */
  async abortStart() {
    const pendingId = get().startingPendingId;
    set({ starting: false, startError: null, startingPendingId: null });
    if (!pendingId) return;
    try {
      await acpAbortPendingStart(pendingId);
    } catch (err) {
      console.error(`abortStart failed for pending id "${pendingId}":`, err);
    }
  },

  async cancel() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    try {
      await acpCancel(sessionId);
    } catch (err) {
      console.error(`cancel failed for session "${sessionId}":`, err);
    }
  },

  async closeSession(sessionId: string) {
    const unlisten = sessionUnlisten[sessionId];
    if (unlisten) {
      unlisten();
      delete sessionUnlisten[sessionId];
    }
    delete streamingAgentMessageId[sessionId];
    try {
      await acpCloseSession(sessionId);
    } catch (err) {
      console.error(`closeSession failed for session "${sessionId}":`, err);
    }
    set((s) => {
      const nextSessions = { ...s.sessions };
      delete nextSessions[sessionId];
      return {
        sessions: nextSessions,
        activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
      };
    });
  },
}));
