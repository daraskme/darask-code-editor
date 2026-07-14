import type { JSX } from 'react';

interface ShortcutEntry {
  keys: string;
  description: string;
}

// PHASE1-SPEC 6.3: Ctrl+P / Ctrl+Shift+P / Ctrl+B / Ctrl+S
const SHORTCUTS: ShortcutEntry[] = [
  { keys: 'Ctrl+P', description: 'ファイルをすばやく開く' },
  { keys: 'Ctrl+Shift+P', description: 'コマンドパレットを開く' },
  { keys: 'Ctrl+B', description: 'サイドバーの表示切替' },
  { keys: 'Ctrl+S', description: '保存' },
];

export function WelcomeView(): JSX.Element {
  return (
    <div className="dx-editor-welcome">
      <div className="dx-editor-welcome__mark">Darask Code</div>
      <table className="dx-editor-welcome__shortcuts">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td className="dx-editor-welcome__key">{s.keys}</td>
              <td className="dx-editor-welcome__desc">{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
