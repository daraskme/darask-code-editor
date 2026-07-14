import type { JSX } from 'react';
import { useEditorStore } from '../../state/editorStore';
import { EditorTabs } from '../editor/EditorTabs';
import { EditorPane } from '../editor/EditorPane';
import { WelcomeView } from '../editor/WelcomeView';

export function MainArea(): JSX.Element {
  const hasTabs = useEditorStore((s) => s.tabs.length > 0);

  return (
    <div className="main-area">
      {hasTabs ? (
        <>
          <EditorTabs />
          <EditorPane />
        </>
      ) : (
        <WelcomeView />
      )}
    </div>
  );
}
