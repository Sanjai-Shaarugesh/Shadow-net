// notify.ts - popup notifications.
// Web: Notification API (via the service worker when one exists, required on Android Chrome).
// Capacitor: @capacitor/local-notifications if installed (no hard import, so the web build never breaks).
// These fire while the app/tab is alive (foreground or background tab).
// Notifications with the app fully closed need a native push layer - see notes.

const cap = () => (window as any).Capacitor?.Plugins?.LocalNotifications;

export function notifySupported(): boolean {
  return !!cap() || 'Notification' in window;
}

export function notifyGranted(): boolean {
  return !!cap() || ('Notification' in window && Notification.permission === 'granted');
}

export async function requestNotifyPermission(): Promise<boolean> {
  const ln = cap();
  if (ln) {
    try {
      return (await ln.requestPermissions()).display === 'granted';
    } catch {
      return false;
    }
  }
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}

export async function notify(title: string, body: string, tag: string, onClick?: () => void) {
  const ln = cap();
  if (ln) {
    try {
      await ln.schedule({
        notifications: [{ id: Math.floor(Math.random() * 2 ** 30), title, body, extra: { tag } }]
      });
    } catch {
      /* ignore */
    }
    return;
  }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.showNotification(title, { body, tag });
      return;
    }
  } catch {
    /* fall through */
  }
  try {
    const n = new Notification(title, { body, tag });
    n.onclick = () => {
      window.focus();
      onClick?.();
      n.close();
    };
  } catch {
    /* some mobile browsers only allow the SW path */
  }
}
