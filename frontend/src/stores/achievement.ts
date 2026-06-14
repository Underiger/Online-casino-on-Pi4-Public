/**
 * Achievement Pinia store（M20）。
 *
 * - fetchAchievements：從 API 拉取全部成就（含解鎖狀態）
 * - listenForUnlock：訂閱 socket achievement:unlocked，即時更新狀態並顯示通知
 */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { getSocket } from '../socket/client';
import { SOCKET_EVENTS } from '@casino/shared';
import type { AchievementUnlockedPayload } from '@casino/shared';
import {
  apiGetAchievements,
  type AchievementItem,
} from '../api/endpoints/achievement';

export const useAchievementStore = defineStore('achievement', () => {
  const achievements = ref<AchievementItem[]>([]);
  const loading = ref(false);
  const lastUnlocked = ref<AchievementUnlockedPayload | null>(null);

  const unlockedCount = computed(() => achievements.value.filter((a) => a.unlockedAt !== null).length);
  const totalCount = computed(() => achievements.value.length);
  const unlockedAchievements = computed(() => achievements.value.filter((a) => a.unlockedAt !== null));

  async function fetchAchievements(): Promise<void> {
    loading.value = true;
    try {
      const res = await apiGetAchievements();
      achievements.value = res.items;
    } finally {
      loading.value = false;
    }
  }

  let socketInstalled = false;

  function listenForUnlock(onNotify?: (payload: AchievementUnlockedPayload) => void): void {
    if (socketInstalled) return;
    socketInstalled = true;

    const socket = getSocket();
    socket.on(SOCKET_EVENTS.ACHIEVEMENT_UNLOCKED, (payload: AchievementUnlockedPayload) => {
      // 更新本地狀態：找到對應成就並標記解鎖時間
      const idx = achievements.value.findIndex((a) => a.achievementId === payload.achievementId);
      if (idx !== -1) {
        achievements.value[idx] = {
          ...achievements.value[idx]!,
          unlockedAt: new Date().toISOString(),
        };
      }
      lastUnlocked.value = payload;
      onNotify?.(payload);
    });
  }

  function stopListening(): void {
    if (!socketInstalled) return;
    socketInstalled = false;
    const socket = getSocket();
    socket.off(SOCKET_EVENTS.ACHIEVEMENT_UNLOCKED);
  }

  return {
    achievements,
    loading,
    lastUnlocked,
    unlockedCount,
    totalCount,
    unlockedAchievements,
    fetchAchievements,
    listenForUnlock,
    stopListening,
  };
});
