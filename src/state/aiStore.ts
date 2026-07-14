import { create } from 'zustand';

// AI パネルの開閉・アクティブタブなどの薄い UI 状態(PHASE3A-SPEC.md 2.1)。
export type AiPanelTab = 'agent' | 'settings' | 'usage';

interface AiState {
  panelOpen: boolean;
  activeTab: AiPanelTab;
  openPanel(tab?: AiPanelTab): void;
  closePanel(): void;
  setActiveTab(tab: AiPanelTab): void;
}

export const useAiStore = create<AiState>()((set) => ({
  panelOpen: false,
  activeTab: 'agent',
  openPanel(tab) {
    set((s) => ({ panelOpen: true, activeTab: tab ?? s.activeTab }));
  },
  closePanel() {
    set({ panelOpen: false });
  },
  setActiveTab(tab) {
    set({ activeTab: tab });
  },
}));
