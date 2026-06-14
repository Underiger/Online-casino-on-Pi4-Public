/**
 * Leaderboard Pinia store（05_MILESTONES M19 §Frontend）。
 * 管理三種排行榜（今日淨贏、本週淨贏、總資產）的資料與載入狀態。
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { LeaderboardEntry } from '@casino/shared';
import { LeaderboardKind } from '@casino/shared';

// ─── Store ────────────────────────────────────────────────────────────────────

export const useLeaderboardStore = defineStore('leaderboard', () => {
  const kind = ref<LeaderboardKind>(LeaderboardKind.DAILY);
  const entries = ref<LeaderboardEntry[]>([]);
  const periodKey = ref<string | null>(null);
  const refreshedAt = ref<string>('');
  const isLoading = ref(false);
  const error = ref<string | null>(null);

  async function fetchLeaderboard(newKind: LeaderboardKind): Promise<void> {
    isLoading.value = true;
    error.value = null;
    try {
      const { apiGetLeaderboard } = await import('../api/endpoints/leaderboard');
      const kindStr = newKind.toLowerCase() as 'daily' | 'weekly' | 'total';
      const res = await apiGetLeaderboard(kindStr);
      kind.value = newKind;
      entries.value = res.entries;
      periodKey.value = res.periodKey;
      refreshedAt.value = res.refreshedAt;
    } catch {
      error.value = '無法載入排行榜';
    } finally {
      isLoading.value = false;
    }
  }

  return {
    kind,
    entries,
    periodKey,
    refreshedAt,
    isLoading,
    error,
    fetchLeaderboard,
  };
});
