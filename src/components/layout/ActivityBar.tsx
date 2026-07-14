import type { JSX } from 'react';
import { useAiStore } from '../../state/aiStore';

function FilesIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h4l2 2.5h8A1.5 1.5 0 0 1 21 8v10.5A1.5 1.5 0 0 1 19.5 20h-14A1.5 1.5 0 0 1 4 18.5z" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15.2 15.2 20 20" strokeLinecap="round" />
    </svg>
  );
}

function GitIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 8v8M18 8a6 6 0 0 1-6 6" strokeLinecap="round" />
    </svg>
  );
}

function AiIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M12 3l1.8 4.8L18.6 9.6 13.8 11.4 12 16.2l-1.8-4.8L5.4 9.6l4.8-1.8z" strokeLinejoin="round" />
      <path d="M18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z" strokeLinejoin="round" />
    </svg>
  );
}

function SettingsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 13.5a7.6 7.6 0 0 0 0-3l1.9-1.5-2-3.4-2.3.7a7.6 7.6 0 0 0-2.6-1.5L14 2h-4l-.4 2.3a7.6 7.6 0 0 0-2.6 1.5l-2.3-.7-2 3.4L4.6 10.5a7.6 7.6 0 0 0 0 3L2.7 15l2 3.4 2.3-.7c.75.66 1.63 1.17 2.6 1.5L10 22h4l.4-2.3a7.6 7.6 0 0 0 2.6-1.5l2.3.7 2-3.4z"
        strokeLinejoin="round"
      />
    </svg>
  );
}

interface ActivityItem {
  id: string;
  label: string;
  icon: () => JSX.Element;
  enabled: boolean;
  disabledReason?: string;
}

const ITEMS: ActivityItem[] = [
  { id: 'files', label: 'Files', icon: FilesIcon, enabled: true },
  { id: 'search', label: 'Search', icon: SearchIcon, enabled: false, disabledReason: 'Phase 2' },
  { id: 'git', label: 'Git', icon: GitIcon, enabled: false, disabledReason: 'Phase 2' },
  { id: 'ai', label: 'AI', icon: AiIcon, enabled: true },
  { id: 'settings', label: 'Settings', icon: SettingsIcon, enabled: false, disabledReason: 'Phase 2' },
];

interface ActivityBarProps {
  activeId: string;
  onSelect(id: string): void;
}

export function ActivityBar({ activeId, onSelect }: ActivityBarProps): JSX.Element {
  const aiPanelOpen = useAiStore((s) => s.panelOpen);
  const aiActiveTab = useAiStore((s) => s.activeTab);
  const openAiPanel = useAiStore((s) => s.openPanel);
  const closeAiPanel = useAiStore((s) => s.closePanel);

  function handleClick(item: ActivityItem): void {
    if (item.id === 'ai') {
      // AI アイコンはトグル動作: エージェントタブで既に開いていれば閉じる(PHASE3A-SPEC 2.1)
      if (aiPanelOpen && aiActiveTab === 'agent') {
        closeAiPanel();
      } else {
        openAiPanel('agent');
      }
      return;
    }
    onSelect(item.id);
  }

  return (
    <nav className="activity-bar" aria-label="Activity Bar">
      {ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = item.id === 'ai' ? aiPanelOpen && aiActiveTab === 'agent' : item.id === activeId;
        const title = item.enabled ? item.label : `${item.label} (${item.disabledReason})`;
        return (
          <button
            key={item.id}
            type="button"
            className={isActive ? 'activity-bar__button activity-bar__button--active' : 'activity-bar__button'}
            disabled={!item.enabled}
            title={title}
            aria-label={title}
            onClick={() => handleClick(item)}
          >
            <Icon />
          </button>
        );
      })}
    </nav>
  );
}
