// プラットフォーム判定ユーティリティ

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPod|iPhone|iPad/.test(navigator.platform ?? '');
}

export function modKeyLabel(): string {
  return isMac() ? '⌘' : 'Ctrl';
}
