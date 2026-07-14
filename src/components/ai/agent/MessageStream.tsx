import type { JSX } from 'react';
import type { AgentMessage } from '../../../state/acpStore';

// Agent F 所有(PHASE3A-SPEC.md 3.2)。メッセージ配列を吹き出し表示する簡易ビュー。
// user は右寄せ、agent は左寄せ。Markdown レンダリングは Phase3a スコープ外(TODO: Phase3b)。
interface MessageStreamProps {
  messages: AgentMessage[];
}

export function MessageStream({ messages }: MessageStreamProps): JSX.Element {
  if (messages.length === 0) {
    return (
      <div className="dx-agent-messages">
        <div className="dx-agent-messages__empty">メッセージはまだありません。下の入力欄から指示を送ってください。</div>
      </div>
    );
  }

  return (
    <div className="dx-agent-messages">
      {messages.map((m) => (
        <div
          key={m.id}
          className={
            m.role === 'user'
              ? 'dx-agent-message dx-agent-message--user'
              : 'dx-agent-message dx-agent-message--agent'
          }
        >
          <div className="dx-agent-message__bubble">{m.text}</div>
        </div>
      ))}
    </div>
  );
}
