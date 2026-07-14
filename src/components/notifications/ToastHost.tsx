import type { JSX } from 'react';
import { useNotificationStore } from '../../state/notificationStore';
import './notifications.css';

export function ToastHost(): JSX.Element | null {
  const notifications = useNotificationStore((state) => state.notifications);
  const dismiss = useNotificationStore((state) => state.dismiss);

  if (notifications.length === 0) return null;

  return (
    <div className="dx-toast-host" aria-live="polite" aria-relevant="additions">
      {notifications.map((notification) => (
        <div key={notification.id} className={`dx-toast dx-toast--${notification.kind}`} role="status">
          <span className="dx-toast__message">{notification.message}</span>
          <button
            type="button"
            className="dx-toast__dismiss"
            aria-label="通知を閉じる"
            onClick={() => dismiss(notification.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
