import { executeCommand } from './commands';

interface Binding {
  key: string;
  shift: boolean;
  commandId: string;
}

// Ctrl+P / Ctrl+Shift+P / Ctrl+S / Ctrl+W / Ctrl+B(PHASE1-SPEC 4.5)
// Ctrl+Shift+U: 使用量ダッシュボード(PHASE3A-SPEC 3.3)
const BINDINGS: Binding[] = [
  { key: 'p', shift: false, commandId: 'workbench.quickOpen' },
  { key: 'p', shift: true, commandId: 'workbench.commandPalette' },
  { key: 's', shift: false, commandId: 'file.save' },
  { key: 'w', shift: false, commandId: 'file.closeTab' },
  { key: 'b', shift: false, commandId: 'view.toggleSidebar' },
  { key: 'u', shift: true, commandId: 'ai.usageDashboard' },
];

function handleKeyDown(e: KeyboardEvent): void {
  const isMod = e.ctrlKey || e.metaKey;
  if (!isMod) return;
  const key = e.key.toLowerCase();
  const binding = BINDINGS.find((b) => b.key === key && b.shift === e.shiftKey);
  if (!binding) return;
  e.preventDefault();
  e.stopPropagation();
  executeCommand(binding.commandId);
}

/** window keydown を capture フェーズで購読する。Monaco がフォーカスされていても奪う。 */
export function initKeybindings(): () => void {
  window.addEventListener('keydown', handleKeyDown, { capture: true });
  return () => {
    window.removeEventListener('keydown', handleKeyDown, { capture: true });
  };
}
