<script setup lang="ts">
/**
 * LeaderboardView（05_MILESTONES M19）：
 * 三種排行榜分頁——今日淨贏、本週淨贏、總資產 Top100。
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { LeaderboardKind } from '@casino/shared';
import { useLeaderboardStore } from '../stores/leaderboard';

const router = useRouter();
const store = useLeaderboardStore();

const TABS: Array<{ kind: LeaderboardKind; label: string; scoreLabel: string }> = [
  { kind: LeaderboardKind.DAILY,  label: '今日淨贏', scoreLabel: '淨贏分' },
  { kind: LeaderboardKind.WEEKLY, label: '本週淨贏', scoreLabel: '淨贏分' },
  { kind: LeaderboardKind.TOTAL,  label: '總資產',   scoreLabel: '資產'   },
];

const activeKind = ref<LeaderboardKind>(LeaderboardKind.DAILY);

// Avatar 背景色：根據 avatarId 取色盤
const AVATAR_COLORS = [
  '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63',
];

function avatarColor(avatarId: number): string {
  return AVATAR_COLORS[avatarId % AVATAR_COLORS.length]!;
}

function formatScore(score: string): string {
  try {
    const n = BigInt(score);
    return n.toLocaleString() + ' Coin';
  } catch {
    return score + ' Coin';
  }
}

function formatRefreshedAt(iso: string): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei',
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return String(rank);
}

async function switchTab(kind: LeaderboardKind): Promise<void> {
  activeKind.value = kind;
  await store.fetchLeaderboard(kind);
}

let refreshTimer: ReturnType<typeof setInterval> | null = null;

onMounted(async () => {
  await store.fetchLeaderboard(LeaderboardKind.DAILY);
  // 每 60 秒自動刷新
  refreshTimer = setInterval(() => {
    void store.fetchLeaderboard(activeKind.value);
  }, 60_000);
});

onUnmounted(() => {
  if (refreshTimer !== null) clearInterval(refreshTimer);
});
</script>

<template>
  <div class="lb-page">
    <!-- Header -->
    <header class="lb-header">
      <button class="back-btn" aria-label="返回大廳" @click="router.back()">← 返回</button>
      <h1 class="lb-title">🏆 排行榜</h1>
      <span class="lb-refreshed" :title="store.refreshedAt">
        更新：{{ formatRefreshedAt(store.refreshedAt) }}
      </span>
    </header>

    <!-- Tabs -->
    <nav class="lb-tabs" role="tablist">
      <button
        v-for="tab in TABS"
        :key="tab.kind"
        role="tab"
        :aria-selected="activeKind === tab.kind"
        class="lb-tab"
        :class="{ active: activeKind === tab.kind }"
        @click="switchTab(tab.kind)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <!-- Content -->
    <main class="lb-main">
      <div v-if="store.isLoading && store.entries.length === 0" class="lb-loading">
        載入中…
      </div>

      <div v-else-if="store.error !== null" class="lb-error">
        {{ store.error }}
        <button class="retry-btn" @click="switchTab(activeKind)">重試</button>
      </div>

      <div v-else-if="store.entries.length === 0" class="lb-empty">
        目前尚無排行資料
      </div>

      <ol v-else class="lb-list" :class="{ dimmed: store.isLoading }">
        <li
          v-for="entry in store.entries"
          :key="entry.userId"
          class="lb-row"
          :class="{
            'rank-1': entry.rank === 1,
            'rank-2': entry.rank === 2,
            'rank-3': entry.rank === 3,
          }"
        >
          <span class="lb-rank">{{ rankMedal(entry.rank) }}</span>
          <span
            class="lb-avatar"
            :style="{ background: avatarColor(entry.avatarId) }"
            aria-hidden="true"
          >
            {{ entry.username.charAt(0).toUpperCase() }}
          </span>
          <span class="lb-username">{{ entry.username }}</span>
          <span class="lb-score">{{ formatScore(entry.score) }}</span>
        </li>
      </ol>

      <p v-if="store.periodKey !== null" class="lb-period">
        統計期間：{{ store.periodKey }}
      </p>
    </main>
  </div>
</template>

<style scoped>
.lb-page {
  min-height: 100dvh;
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 60%, #16213e 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
}

/* ── Header ─────────────────────────────────────── */

.lb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.8rem 1.5rem;
  background: rgba(0, 0, 0, 0.4);
  border-bottom: 1px solid rgba(255, 215, 0, 0.2);
  position: sticky;
  top: 0;
  z-index: 100;
  gap: 1rem;
}

.lb-title {
  font-size: 1.2rem;
  font-weight: 700;
  color: #ffd700;
  margin: 0;
}

.back-btn {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.3);
  color: rgba(255, 255, 255, 0.7);
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
  transition: all 0.2s;
  white-space: nowrap;
}

.back-btn:hover {
  border-color: #ffd700;
  color: #ffd700;
}

.lb-refreshed {
  font-size: 0.75rem;
  color: rgba(255, 255, 255, 0.45);
  white-space: nowrap;
}

/* ── Tabs ────────────────────────────────────────── */

.lb-tabs {
  display: flex;
  gap: 0;
  background: rgba(0, 0, 0, 0.3);
  border-bottom: 1px solid rgba(255, 215, 0, 0.15);
}

.lb-tab {
  flex: 1;
  padding: 0.75rem 0.5rem;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.9rem;
  cursor: pointer;
  transition: all 0.2s;
}

.lb-tab.active {
  color: #ffd700;
  border-bottom-color: #ffd700;
  font-weight: 600;
}

.lb-tab:hover:not(.active) {
  color: rgba(255, 255, 255, 0.8);
}

/* ── Main ────────────────────────────────────────── */

.lb-main {
  flex: 1;
  max-width: 720px;
  width: 100%;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
}

.lb-loading,
.lb-error,
.lb-empty {
  text-align: center;
  padding: 3rem 1rem;
  color: rgba(255, 255, 255, 0.5);
  font-size: 1rem;
}

.lb-error {
  color: #e74c3c;
}

.retry-btn {
  display: block;
  margin: 1rem auto 0;
  padding: 0.4rem 1rem;
  background: transparent;
  border: 1px solid #e74c3c;
  color: #e74c3c;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.85rem;
}

/* ── List ────────────────────────────────────────── */

.lb-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  transition: opacity 0.15s;
}

.lb-list.dimmed {
  opacity: 0.6;
}

.lb-row {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.75rem 1rem;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.07);
  transition: background 0.15s;
}

.lb-row:hover {
  background: rgba(255, 255, 255, 0.07);
}

.lb-row.rank-1 {
  border-color: rgba(255, 215, 0, 0.5);
  background: rgba(255, 215, 0, 0.07);
}

.lb-row.rank-2 {
  border-color: rgba(192, 192, 192, 0.4);
  background: rgba(192, 192, 192, 0.05);
}

.lb-row.rank-3 {
  border-color: rgba(205, 127, 50, 0.4);
  background: rgba(205, 127, 50, 0.05);
}

.lb-rank {
  width: 2rem;
  text-align: center;
  font-size: 1rem;
  font-weight: 700;
  flex-shrink: 0;
}

.lb-avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  font-weight: 700;
  color: #fff;
  flex-shrink: 0;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
}

.lb-username {
  flex: 1;
  font-size: 0.95rem;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lb-score {
  font-size: 0.9rem;
  font-weight: 600;
  color: #ffd700;
  white-space: nowrap;
  flex-shrink: 0;
}

.lb-period {
  text-align: center;
  margin-top: 1.5rem;
  font-size: 0.78rem;
  color: rgba(255, 255, 255, 0.35);
}

@media (max-width: 480px) {
  .lb-header {
    padding: 0.6rem 1rem;
  }

  .lb-refreshed {
    display: none;
  }

  .lb-row {
    padding: 0.6rem 0.75rem;
    gap: 0.65rem;
  }
}
</style>
