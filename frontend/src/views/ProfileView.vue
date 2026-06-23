<script setup lang="ts">
/**
 * ProfileView（M20）：個人資料頁——統計卡片、成就網格、排行榜歷史。
 */
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useAchievementStore } from '../stores/achievement';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import AchievementBadge from '../components/common/AchievementBadge.vue';
import { apiGetProfile, type ProfileRes } from '../api/endpoints/achievement';
import type { AchievementUnlockedPayload } from '@casino/shared';

const router = useRouter();
const auth = useAuthStore();
const achStore = useAchievementStore();

const profile = ref<ProfileRes | null>(null);
const profileLoading = ref(false);
const toast = ref<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast(msg: string): void {
  toast.value = msg;
  if (toastTimer !== null) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.value = null; }, 4000);
}

function onAchUnlocked(payload: AchievementUnlockedPayload): void {
  showToast(`🏅 成就解鎖：${payload.name}（+${payload.rewardCoin} Coin）`);
}

function formatCoin(val: string): string {
  try { return Number(BigInt(val)).toLocaleString() + ' Coin'; } catch { return val + ' Coin'; }
}

function kindLabel(kind: string): string {
  if (kind === 'DAILY') return '每日';
  if (kind === 'WEEKLY') return '每週';
  return '總榜';
}

onMounted(async () => {
  achStore.listenForUnlock(onAchUnlocked);

  profileLoading.value = true;
  try {
    const [p] = await Promise.all([
      apiGetProfile(),
      achStore.fetchAchievements(),
    ]);
    profile.value = p;
  } catch {
    showToast('資料載入失敗，請稍後再試');
  } finally {
    profileLoading.value = false;
  }
});

onUnmounted(() => {
  achStore.stopListening();
  if (toastTimer !== null) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="profile">
    <!-- Header -->
    <header class="header">
      <button class="back-btn" @click="router.replace('/casino')">← 大廳</button>
      <div class="brand">👤 個人資料</div>
      <div class="header-right">
        <CoinDisplay />
        <span class="username">{{ auth.user?.username }}</span>
      </div>
    </header>

    <!-- Toast -->
    <Transition name="toast-fade">
      <div v-if="toast !== null" class="toast" role="alert">{{ toast }}</div>
    </Transition>

    <main class="main">
      <!-- 載入中 -->
      <div v-if="profileLoading" class="loading">載入中…</div>

      <template v-else-if="profile !== null">
        <!-- 用戶卡片 -->
        <section class="user-card">
          <div class="avatar">{{ auth.user?.username?.charAt(0).toUpperCase() ?? '?' }}</div>
          <div class="user-info">
            <h2>{{ profile.username }}</h2>
            <p class="balance-line">餘額：{{ formatCoin(profile.balance) }}</p>
          </div>
          <div class="ach-summary">
            <span class="ach-count">{{ achStore.unlockedCount }}</span>
            <span class="ach-label">/ {{ achStore.totalCount }} 成就</span>
          </div>
        </section>

        <!-- 統計卡片 -->
        <section class="section">
          <h3 class="section-title">遊戲統計</h3>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-icon">🎰</div>
              <div class="stat-value">{{ profile.stats.totalSpins.toLocaleString() }}</div>
              <div class="stat-label">累計旋轉</div>
            </div>
            <div class="stat-card">
              <div class="stat-icon">💰</div>
              <div class="stat-value">{{ formatCoin(profile.stats.maxSingleWin) }}</div>
              <div class="stat-label">最大單次贏分</div>
            </div>
            <div class="stat-card">
              <div class="stat-icon">🏆</div>
              <div class="stat-value">{{ profile.stats.jackpotWins }}</div>
              <div class="stat-label">Jackpot 次數</div>
            </div>
            <div class="stat-card">
              <div class="stat-icon">✨</div>
              <div class="stat-value">{{ profile.stats.charmsOwned }} / {{ profile.stats.totalCharms }}</div>
              <div class="stat-label">護符收集</div>
            </div>
          </div>
        </section>

        <!-- 成就網格 -->
        <section class="section">
          <h3 class="section-title">成就（{{ achStore.unlockedCount }} / {{ achStore.totalCount }} 解鎖）</h3>
          <div v-if="achStore.achievements.length === 0" class="empty">尚無成就資料</div>
          <div v-else class="badge-grid">
            <AchievementBadge
              v-for="ach in achStore.achievements"
              :key="ach.achievementId"
              :achievement="ach"
            />
          </div>
        </section>

        <!-- 排行榜歷史 -->
        <section class="section">
          <h3 class="section-title">排行榜歷史</h3>
          <div v-if="profile.leaderboardHistory.length === 0" class="empty">尚無歷史名次記錄</div>
          <table v-else class="history-table">
            <thead>
              <tr>
                <th>榜種</th>
                <th>期間</th>
                <th>名次</th>
                <th>分數</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, i) in profile.leaderboardHistory" :key="i">
                <td>{{ kindLabel(row.kind) }}</td>
                <td>{{ row.periodKey ?? '—' }}</td>
                <td class="rank-cell">#{{ row.rank }}</td>
                <td>{{ formatCoin(row.score) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </template>
    </main>
  </div>
</template>

<style scoped>
.profile {
  min-height: 100dvh;
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 60%, #16213e 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
}

/* Header */
.header {
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

.back-btn {
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
  white-space: nowrap;
}

.back-btn:hover { border-color: #ffd700; color: #ffd700; }

.brand {
  font-size: 1.1rem;
  font-weight: 700;
  color: #ffd700;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.username { color: rgba(255, 255, 255, 0.8); font-size: 0.9rem; }

/* Toast */
.toast {
  position: fixed;
  top: 4.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(255, 215, 0, 0.92);
  color: #000;
  padding: 0.6rem 1.4rem;
  border-radius: 8px;
  font-size: 0.9rem;
  font-weight: 600;
  z-index: 999;
  white-space: nowrap;
  max-width: 90vw;
  text-overflow: ellipsis;
  overflow: hidden;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

.toast-fade-enter-active, .toast-fade-leave-active { transition: opacity 0.3s; }
.toast-fade-enter-from, .toast-fade-leave-to { opacity: 0; }

/* Main */
.main {
  flex: 1;
  max-width: 960px;
  width: 100%;
  margin: 0 auto;
  padding: 1.5rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.loading { text-align: center; padding: 3rem; color: rgba(255, 255, 255, 0.5); }
.empty { color: rgba(255, 255, 255, 0.4); font-size: 0.9rem; text-align: center; padding: 1rem 0; }

/* User card */
.user-card {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  padding: 1.2rem 1.5rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 215, 0, 0.2);
  border-radius: 14px;
}

.avatar {
  width: 3.5rem;
  height: 3.5rem;
  border-radius: 50%;
  background: linear-gradient(135deg, #ffd700, #ff8c00);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  font-weight: 700;
  color: #000;
  flex-shrink: 0;
}

.user-info { flex: 1 }
.user-info h2 { margin: 0 0 0.25rem; font-size: 1.3rem; color: #ffd700; }
.balance-line { margin: 0; font-size: 0.9rem; color: rgba(255, 255, 255, 0.7); }

.ach-summary { text-align: right; flex-shrink: 0; }
.ach-count { font-size: 1.8rem; font-weight: 700; color: #ffd700; }
.ach-label { font-size: 0.75rem; color: rgba(255, 255, 255, 0.5); }

/* Section */
.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  margin: 0 0 0.9rem;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

/* Stats */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.85rem;
}

.stat-card {
  padding: 1rem;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 215, 0, 0.15);
  border-radius: 10px;
  text-align: center;
}

.stat-icon { font-size: 1.6rem; margin-bottom: 0.3rem; }
.stat-value { font-size: 1.1rem; font-weight: 700; color: #ffd700; }
.stat-label { font-size: 0.75rem; color: rgba(255, 255, 255, 0.5); margin-top: 0.2rem; }

/* Badge grid */
.badge-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
}

/* History table */
.history-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}

.history-table th,
.history-table td {
  padding: 0.55rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.history-table th {
  color: rgba(255, 255, 255, 0.55);
  font-weight: 500;
}

.rank-cell { color: #ffd700; font-weight: 600; }

@media (max-width: 480px) {
  .stats-grid { grid-template-columns: repeat(2, 1fr); }
  .user-card { flex-wrap: wrap; }
  .ach-summary { width: 100%; text-align: left; }
}
</style>
