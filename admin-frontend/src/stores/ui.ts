import { ref } from 'vue';
import { defineStore } from 'pinia';

export type ToastType = 'success' | 'error' | 'info' | 'warning';

export interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

let nextId = 0;

export const useUiStore = defineStore('ui', () => {
  const toasts = ref<Toast[]>([]);

  function addToast(message: string, type: ToastType = 'info', duration = 3500): void {
    const id = ++nextId;
    toasts.value.push({ id, message, type });
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id);
    }, duration);
  }

  function removeToast(id: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }

  return { toasts, addToast, removeToast };
});
