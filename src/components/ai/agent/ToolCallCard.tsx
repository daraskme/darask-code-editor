import { useState, type JSX } from 'react';
import type { ToolCall, ToolCallStatus } from '../../../state/acpStore';
import { DiffPreview } from './DiffPreview';

// Agent F 所有(PHASE3A-SPEC.md 3.2)。ツールコールごとにタイトル・status バッジ・
// 展開時の content 表示を行う。status バッジ色は本仕様書の指定通り CSS 変数で分岐する。
const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: '保留中',
  in_progress: '実行中',
  completed: '完了',
  failed: '失敗',
};

interface ToolCallCardProps {
  toolCall: ToolCall;
}

// content 要素はエージェント依存で形が定まらないため unknown として防御的に解釈する。
// diff 情報を含む場合(oldText/newText または path を伴う場合)は DiffPreview を使う。
// TODO(integrate): 実 ACP のツールコール content スキーマ確定後に判定を精緻化すること。
function renderContentItem(item: unknown, index: number): JSX.Element {
  if (typeof item === 'string') {
    return (
      <div key={index} className="dx-agent-toolcall__text">
        {item}
      </div>
    );
  }

  if (item && typeof item === 'object') {
    const obj = item as Record<string, unknown>;
    const oldText = typeof obj.oldText === 'string' ? obj.oldText : undefined;
    const newText = typeof obj.newText === 'string' ? obj.newText : undefined;
    if (oldText !== undefined || newText !== undefined) {
      const path = typeof obj.path === 'string' ? obj.path : undefined;
      return (
        <DiffPreview
          key={index}
          beforeText={oldText ?? ''}
          afterText={newText ?? ''}
          path={path}
        />
      );
    }

    const nestedContent = obj.content;
    if (nestedContent && typeof nestedContent === 'object') {
      const nested = nestedContent as Record<string, unknown>;
      if (typeof nested.text === 'string') {
        return (
          <div key={index} className="dx-agent-toolcall__text">
            {nested.text}
          </div>
        );
      }
    }
    if (typeof obj.text === 'string') {
      return (
        <div key={index} className="dx-agent-toolcall__text">
          {obj.text}
        </div>
      );
    }
  }

  return (
    <pre key={index} className="dx-agent-toolcall__raw">
      {JSON.stringify(item, null, 2)}
    </pre>
  );
}

export function ToolCallCard({ toolCall }: ToolCallCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="dx-agent-toolcall">
      <button
        type="button"
        className="dx-agent-toolcall__header"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="dx-agent-toolcall__chevron">{expanded ? '▾' : '▸'}</span>
        <span className="dx-agent-toolcall__title">{toolCall.title}</span>
        <span className={`dx-agent-toolcall__badge dx-agent-toolcall__badge--${toolCall.status}`}>
          {STATUS_LABEL[toolCall.status]}
        </span>
      </button>
      {expanded && (
        <div className="dx-agent-toolcall__body">
          {toolCall.content.length === 0 ? (
            <div className="dx-agent-toolcall__empty">内容はありません</div>
          ) : (
            toolCall.content.map((item, i) => renderContentItem(item, i))
          )}
        </div>
      )}
    </div>
  );
}
