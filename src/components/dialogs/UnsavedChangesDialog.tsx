import { useEffect, type JSX } from 'react';
import { useUnsavedChangesStore, type UnsavedChangesDecision } from '../../state/unsavedChangesStore';
import './dialogs.css';

export function UnsavedChangesDialog(): JSX.Element | null {
  const files = useUnsavedChangesStore((state) => state.files);
  const decide = useUnsavedChangesStore((state) => state.decide);

  useEffect(() => {
    if (!files) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      decide('cancel');
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [decide, files]);

  if (!files) return null;

  const fileLabel = files.length === 1 ? `「${files[0].name}」` : `${files.length} 個のファイル`;

  function choose(decision: UnsavedChangesDecision): void {
    decide(decision);
  }

  return (
    <div className="dx-dialog-backdrop" role="presentation">
      <section
        className="dx-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-changes-title"
        aria-describedby="unsaved-changes-description"
      >
        <h2 id="unsaved-changes-title" className="dx-dialog__title">
          未保存の変更があります
        </h2>
        <p id="unsaved-changes-description" className="dx-dialog__description">
          {fileLabel} の変更を保存しますか？
        </p>
        {files.length > 1 && (
          <ul className="dx-dialog__file-list">
            {files.slice(0, 8).map((file) => (
              <li key={file.path}>{file.name}</li>
            ))}
            {files.length > 8 && <li>ほか {files.length - 8} 個</li>}
          </ul>
        )}
        <div className="dx-dialog__actions">
          <button type="button" className="dx-dialog__button dx-dialog__button--secondary" onClick={() => choose('cancel')}>
            キャンセル
          </button>
          <button type="button" className="dx-dialog__button dx-dialog__button--danger" onClick={() => choose('discard')}>
            破棄
          </button>
          <button type="button" className="dx-dialog__button dx-dialog__button--primary" onClick={() => choose('save')}>
            保存
          </button>
        </div>
      </section>
    </div>
  );
}
