// コマンドパレット(PHASE1-SPEC 6.4)。表示制御は App 側(paletteMode === 'commands' の間だけマウントされる)。
import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type MouseEvent } from 'react';
import { executeCommand, getCommands } from '../../lib/commands';
import { useUiStore } from '../../state/uiStore';
import './palette.css';

function closePalette(): void {
  useUiStore.getState().setPaletteMode('none');
}

export function CommandPalette(): JSX.Element {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const q = query.trim().toLowerCase();
  const commands = getCommands();
  const filtered = q ? commands.filter((c) => c.title.toLowerCase().includes(q)) : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  function run(index: number): void {
    const cmd = filtered[index];
    if (!cmd) return;
    executeCommand(cmd.id);
    closePalette();
  }

  function handleOverlayMouseDown(e: MouseEvent<HTMLDivElement>): void {
    if (e.target === e.currentTarget) closePalette();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        closePalette();
        break;
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex((i) => (filtered.length === 0 ? 0 : (i + 1) % filtered.length));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex((i) => (filtered.length === 0 ? 0 : (i - 1 + filtered.length) % filtered.length));
        break;
      case 'Enter':
        e.preventDefault();
        run(selectedIndex);
        break;
      default:
        break;
    }
  }

  return (
    <div className="dx-palette-overlay" onMouseDown={handleOverlayMouseDown}>
      <div className="dx-palette-box" onKeyDown={handleKeyDown}>
        <input
          ref={inputRef}
          className="dx-palette-input"
          type="text"
          placeholder="コマンドを入力..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="dx-palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="dx-palette-empty">一致するコマンドがありません</div>}
          {filtered.map((cmd, index) => (
            <div
              key={cmd.id}
              className={
                index === selectedIndex ? 'dx-palette-item dx-palette-item--active' : 'dx-palette-item'
              }
              data-active={index === selectedIndex}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => run(index)}
            >
              <span className="dx-palette-item-title">{cmd.title}</span>
              {cmd.keybinding && <span className="dx-palette-item-keybinding">{cmd.keybinding}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
