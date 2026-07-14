import { create } from 'zustand';

export type NotificationKind = 'error' | 'success' | 'info';

export interface NotificationInput {
  kind: NotificationKind;
  message: string;
  durationMs?: number;
}

export interface Notification extends NotificationInput {
  id: number;
}

interface NotificationState {
  notifications: Notification[];
  push(input: NotificationInput): void;
  dismiss(id: number): void;
}

let nextId = 1;
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const useNotificationStore = create<NotificationState>()((set, get) => ({
  notifications: [],

  push(input) {
    const id = nextId;
    nextId += 1;
    const notification: Notification = { ...input, id };
    set((state) => ({ notifications: [...state.notifications, notification].slice(-4) }));

    const durationMs = input.durationMs ?? (input.kind === 'error' ? 8_000 : 4_000);
    const timer = setTimeout(() => get().dismiss(id), durationMs);
    dismissTimers.set(id, timer);
  },

  dismiss(id) {
    const timer = dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimers.delete(id);
    }
    set((state) => ({ notifications: state.notifications.filter((notification) => notification.id !== id) }));
  },
}));

export function notifyError(message: string): void {
  useNotificationStore.getState().push({ kind: 'error', message });
}

export function notifySuccess(message: string): void {
  useNotificationStore.getState().push({ kind: 'success', message });
}
