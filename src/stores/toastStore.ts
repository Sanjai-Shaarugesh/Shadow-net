import { atom } from 'nanostores';

export interface ToastMessage {
  id: string;
  message: string;
  status: 'info' | 'success' | 'error' | 'warning' | 'chat';
  duration: number;
}

export const toastAtom = atom<ToastMessage | null>(null);

export function addToastMessage(
  message: string,
  status: 'info' | 'success' | 'error' | 'warning' | 'chat' = 'info',
  duration = 5000
): void {
  toastAtom.set({ id: Date.now().toString(), message, status, duration });
}
