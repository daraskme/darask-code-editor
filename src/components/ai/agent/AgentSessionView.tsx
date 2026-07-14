import { useEffect, useState, type JSX, type KeyboardEvent } from 'react';
import { useAcpStore } from '../../../state/acpStore';
import { useWorkspaceStore } from '../../../state/workspaceStore';
import { MessageStream } from './MessageStream';
import { ToolCallCard } from './ToolCallCard';
import { PermissionPrompt } from './PermissionPrompt';
import './agent.css';

// Agent F 所有(PHASE3A-SPEC.md 3.2)。ACP エージェントパネルの本体。
// セッション未開始時は acp_list_agents の結果からボタン一覧を表示し、
// 開始後は MessageStream + ToolCallCard 一覧 + 入力欄 + PermissionPrompt を表示する。
export function AgentSessionView(): JSX.Element {
  const agents = useAcpStore((s) => s.agents);
  const agentsLoading = useAcpStore((s) => s.agentsLoading);
  const agentsError = useAcpStore((s) => s.agentsError);
  const loadAgents = useAcpStore((s) => s.loadAgents);
  const starting = useAcpStore((s) => s.starting);
  const startError = useAcpStore((s) => s.startError);
  const startSession = useAcpStore((s) => s.startSession);
  const abortStart = useAcpStore((s) => s.abortStart);

  const activeSessionId = useAcpStore((s) => s.activeSessionId);
  const session = useAcpStore((s) => (s.activeSessionId ? s.sessions[s.activeSessionId] : undefined));
  const sendPrompt = useAcpStore((s) => s.sendPrompt);
  const cancelSession = useAcpStore((s) => s.cancel);
  const closeSession = useAcpStore((s) => s.closeSession);

  const rootPath = useWorkspaceStore((s) => s.rootPath);

  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (agents.length === 0 && !agentsLoading) {
      void loadAgents();
    }
    // 初回マウント時のみ実行する(agents/agentsLoading の変化では再実行しない)。
  }, []);

  if (!activeSessionId || !session) {
    return (
      <div className="dx-agent-view">
        <div className="dx-agent-placeholder">
          <p className="dx-agent-placeholder__text">エージェントを選択してください</p>
          {rootPath === null && (
            <p className="dx-agent-placeholder__hint">
              先にフォルダを開いてください(エージェントの作業ディレクトリが必要です)
            </p>
          )}
          {agentsLoading && <p className="dx-agent-placeholder__hint">エージェント一覧を読み込み中...</p>}
          {agentsError && <p className="dx-agent-placeholder__error">エージェント一覧の取得に失敗: {agentsError}</p>}

          <div className="dx-agent-picker">
            {agents.map((agent) => (
              <button
                key={agent.id}
                type="button"
                className="dx-agent-picker__button"
                disabled={rootPath === null || starting}
                title={agent.description ?? agent.command}
                onClick={() => {
                  if (rootPath) void startSession(agent.id, rootPath);
                }}
              >
                {agent.name}
              </button>
            ))}
          </div>

          {starting && (
            <div className="dx-agent-placeholder__starting">
              <p className="dx-agent-placeholder__hint">セッションを開始しています...</p>
              <button
                type="button"
                className="dx-agent-view__action"
                onClick={() => void abortStart()}
              >
                キャンセル
              </button>
            </div>
          )}
          {startError && (
            <div className="dx-agent-placeholder__error">
              <p>起動に失敗しました: {startError}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  const toolCalls = Object.values(session.toolCalls);

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void sendPrompt(text);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="dx-agent-view">
      <div className="dx-agent-view__header">
        <span className="dx-agent-view__agent">{session.agentId}</span>
        <div className="dx-agent-view__actions">
          <button type="button" className="dx-agent-view__action" onClick={() => void cancelSession()}>
            停止
          </button>
          <button
            type="button"
            className="dx-agent-view__action"
            onClick={() => void closeSession(activeSessionId)}
          >
            セッション終了
          </button>
        </div>
      </div>

      <MessageStream messages={session.messages} />

      {toolCalls.length > 0 && (
        <div className="dx-agent-toolcalls">
          {toolCalls.map((tc) => (
            <ToolCallCard key={tc.id} toolCall={tc} />
          ))}
        </div>
      )}

      <PermissionPrompt />

      <div className="dx-agent-input">
        <textarea
          className="dx-agent-input__textarea"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="エージェントへの指示を入力(Enterで送信、Shift+Enterで改行)"
          rows={2}
        />
        <button type="button" className="dx-agent-input__send" onClick={handleSend} disabled={!draft.trim()}>
          送信
        </button>
      </div>
    </div>
  );
}
