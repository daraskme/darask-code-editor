import type { JSX } from 'react';
import { useAcpStore } from '../../../state/acpStore';

// Agent F 所有(PHASE3A-SPEC.md 3.2)。pendingPermissions の先頭を表示し、
// エージェントから届いた options 配列をそのままボタン化する(選択肢名をハードコードしない)。
// 選択で acpStore.resolvePermission(内部で lib/acp.ts の respondPermission を呼ぶ)を実行する。
export function PermissionPrompt(): JSX.Element | null {
  const pending = useAcpStore((s) => s.pendingPermissions[0]);
  const resolvePermission = useAcpStore((s) => s.resolvePermission);

  if (!pending) return null;

  return (
    <div className="dx-agent-permission" role="alertdialog" aria-label="ツール実行の承認">
      <div className="dx-agent-permission__title">ツール実行の承認が必要です</div>
      {pending.toolCallId && (
        <div className="dx-agent-permission__target">対象ツールコール: {pending.toolCallId}</div>
      )}
      <div className="dx-agent-permission__options">
        {pending.options.map((opt) => (
          <button
            key={opt.optionId}
            type="button"
            className="dx-agent-permission__option"
            onClick={() => void resolvePermission(pending.requestId, opt.optionId)}
          >
            {opt.name}
          </button>
        ))}
      </div>
    </div>
  );
}
