import type { JSX, MouseEvent } from 'react';
import { useEditorStore } from '../../state/editorStore';
import { requestCloseTab } from '../../lib/editorLifecycle';

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function EditorTabs(): JSX.Element {
  const tabs = useEditorStore((state) => state.tabs);
  const activePath = useEditorStore((state) => state.activePath);
  const setActive = useEditorStore((state) => state.setActive);

  function handleClose(event: MouseEvent, path: string): void {
    event.stopPropagation();
    void requestCloseTab(path);
  }

  function handleAuxClick(event: MouseEvent, path: string): void {
    if (event.button !== 1) return;
    event.preventDefault();
    void requestCloseTab(path);
  }

  return (
    <div className="dx-editor-tabs" role="tablist">
      {tabs.map((tab) => {
        const active = tab.path === activePath;
        const classes = [
          'dx-editor-tab',
          active ? 'dx-editor-tab--active' : '',
          tab.saving ? 'dx-editor-tab--saving' : '',
          tab.error ? 'dx-editor-tab--error' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <div
            key={tab.path}
            className={classes}
            role="tab"
            aria-selected={active}
            title={tab.error ? `${tab.path}\n保存エラー: ${tab.error}` : tab.path}
            onClick={() => setActive(tab.path)}
            onAuxClick={(event) => handleAuxClick(event, tab.path)}
          >
            {tab.dirty && <span className="dx-editor-tab__dot" aria-label="未保存" />}
            {tab.saving && <span className="dx-editor-tab__saving-indicator" aria-label="保存中" />}
            {tab.error && (
              <span className="dx-editor-tab__error-indicator" role="img" aria-label={`保存エラー: ${tab.error}`}>
                !
              </span>
            )}
            <span className="dx-editor-tab__name">{tab.name}</span>
            <button
              type="button"
              className="dx-editor-tab__close"
              aria-label={`${tab.name} を閉じる`}
              onClick={(event) => handleClose(event, tab.path)}
            >
              <CloseIcon />
            </button>
          </div>
        );
      })}
    </div>
  );
}
