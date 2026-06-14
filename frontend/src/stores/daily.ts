/**
 * Daily System Pinia store（05_MILESTONES M18 §Frontend）。
 * 管理每日登入獎勵、任務進度、幸運符號。
 * Socket daily:task_updated 即時推送任務進度至 tasks 陣列。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import { SOCKET_EVENTS } from '@casino/shared';
import type { DailyLoginRes, DailyTaskItem, DailyTasksRes, DailyTaskUpdatedPayload, SlotSymbol } from '@casino/shared';
import { getSocket } from '../socket/client';

// ─── Store ────────────────────────────────────────────────────────────────────

export const useDailyStore = defineStore('daily', () => {
  const tasks = ref<DailyTaskItem[]>([]);
  const luckySymbol = ref<SlotSymbol | null>(null);
  const dateKey = ref('');
  const loginReward = ref<DailyLoginRes | null>(null);
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  // ─── Socket ────────────────────────────────────────────────────────────────

  let _connected = false;

  function handleTaskUpdated(payload: DailyTaskUpdatedPayload): void {
    const idx = tasks.value.findIndex((t) => t.taskId === payload.taskId);
    if (idx === -1) return;
    const task = tasks.value[idx]!;
    tasks.value = [
      ...tasks.value.slice(0, idx),
      { ...task, progress: payload.progress },
      ...tasks.value.slice(idx + 1),
    ];
  }

  function connectSocket(): void {
    if (_connected) return;
    _connected = true;
    getSocket().on(SOCKET_EVENTS.DAILY_TASK_UPDATED, handleTaskUpdated);
  }

  function disconnectSocket(): void {
    if (!_connected) return;
    _connected = false;
    getSocket().off(SOCKET_EVENTS.DAILY_TASK_UPDATED, handleTaskUpdated);
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  async function fetchTasks(): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const { apiGetDailyTasks } = await import('../api/endpoints/daily');
      const res: DailyTasksRes = await apiGetDailyTasks();
      tasks.value = res.tasks;
      luckySymbol.value = res.luckySymbol;
      dateKey.value = res.dateKey;
    } catch (e) {
      error.value = '無法載入每日任務';
    } finally {
      isLoading.value = false;
    }
  }

  async function claimLogin(): Promise<DailyLoginRes | null> {
    error.value = null;
    try {
      const { apiClaimDailyLogin } = await import('../api/endpoints/daily');
      const res = await apiClaimDailyLogin();
      loginReward.value = res;
      // 更新錢包餘額
      const { useWalletStore } = await import('./wallet');
      useWalletStore().setBalance(res.newBalance);
      return res;
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error
          ?.code ?? 'UNKNOWN';
      error.value = msg;
      return null;
    }
  }

  async function claimTask(progressId: string): Promise<boolean> {
    error.value = null;
    try {
      const { apiClaimTask } = await import('../api/endpoints/daily');
      const res = await apiClaimTask(progressId);
      // 標記 claimed
      const idx = tasks.value.findIndex((t) => t.id === progressId);
      if (idx !== -1) {
        const task = tasks.value[idx]!;
        tasks.value = [
          ...tasks.value.slice(0, idx),
          { ...task, claimed: true, claimedAt: new Date().toISOString() },
          ...tasks.value.slice(idx + 1),
        ];
      }
      // 更新錢包餘額
      const { useWalletStore } = await import('./wallet');
      useWalletStore().setBalance(res.newBalance);
      return true;
    } catch (e: unknown) {
      const msg =
        (e as { response?: { data?: { error?: { code?: string } } } })?.response?.data?.error
          ?.code ?? 'UNKNOWN';
      error.value = msg;
      return false;
    }
  }

  function clearError(): void {
    error.value = null;
  }

  return {
    tasks,
    luckySymbol,
    dateKey,
    loginReward,
    isLoading,
    error,
    connectSocket,
    disconnectSocket,
    fetchTasks,
    claimLogin,
    claimTask,
    clearError,
  };
});
