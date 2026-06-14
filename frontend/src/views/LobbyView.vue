<script setup lang="ts">
/**
 * LobbyView（04_FOLDER_STRUCTURE §2 views/LobbyView.vue）：
 * 玩家大廳——顯示歡迎訊息、餘額（CoinDisplay）、各遊戲入口。
 * 登入後初始化 Socket、拉取最新餘額。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useWalletStore } from '../stores/wallet';
import { getSocket, disconnectSocket } from '../socket/client';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import DailyTaskDrawer from '../components/common/DailyTaskDrawer.vue';
import type { JackpotTickPayload, SystemAnnouncementPayload } from '@casino/shared';
import { SOCKET_EVENTS } from '@casino/shared';

const router = useRouter();
const auth = useAuthStore();
const wallet = useWalletStore();

const jackpotPool = ref<string | null>(null);
const announcement = ref<string | null>(null);
const showDailyDrawer = ref(false);

onMounted(async () => {
  // 拉取最新餘額
  await wallet.fetchBalance();

  // 初始化 Socket 並監聽大廳事件
  const socket = getSocket();

  socket.on(SOCKET_EVENTS.JACKPOT_TICK, (payload: JackpotTickPayload) => {
    jackpotPool.value = payload.pool;
  });

  socket.on(SOCKET_EVENTS.SYSTEM_ANNOUNCEMENT, (payload: SystemAnnouncementPayload) => {
    announcement.value = `📢 ${payload.title}：${payload.content}`;
  });
});

onUnmounted(() => {
  const socket = getSocket();
  socket.off(SOCKET_EVENTS.JACKPOT_TICK);
  socket.off(SOCKET_EVENTS.SYSTEM_ANNOUNCEMENT);
});

async function handleLogout(): Promise<void> {
  disconnectSocket();
  await auth.logout();
  await router.replace('/login');
}

function formatPool(val: string | null): string {
  if (val === null) return '讀取中…';
  try {
    return Number(BigInt(val)).toLocaleString() + ' Coin';
  } catch {
    return val + ' Coin';
  }
}

interface GameItem {
  name: string;
  icon: string;
  route: string;
  desc: string;
  disabled?: boolean;
}

const games: GameItem[] = [
  { name: '老虎機', icon: '🎰', route: '/slot', desc: '轉動滾輪，博取大獎！' },
  { name: '輪盤', icon: '🎡', route: '/roulette', desc: '全服同場，輪盤對決！' },
  { name: '排行榜', icon: '🏆', route: '/leaderboard', desc: '頂尖玩家爭霸' },
  { name: '個人頁', icon: '👤', route: '/profile', desc: '成就、護符、交易紀錄' },
];
</script>

<template>
  <div class="lobby">
    <!-- 頂部導航 -->
    <header class="header">
      <div class="brand">🎰 Virtual Casino</div>
      <div class="header-right">
        <CoinDisplay />
        <span class="username">{{ auth.user?.username }}</span>
        <button class="daily-btn" @click="showDailyDrawer = true">每日任務</button>
        <button class="logout-btn" @click="handleLogout">登出</button>
      </div>
    </header>

    <DailyTaskDrawer :open="showDailyDrawer" @close="showDailyDrawer = false" />

    <!-- 公告橫幅 -->
    <div v-if="announcement !== null" class="announcement-bar" role="alert">
      {{ announcement }}
      <button class="close-btn" aria-label="關閉" @click="announcement = null">✕</button>
    </div>

    <main class="main">
      <!-- 歡迎語 -->
      <section class="welcome">
        <h2>歡迎回來，{{ auth.user?.username ?? '玩家' }} 🎉</h2>
        <p class="jackpot-info">
          🏆 當前 Jackpot 累積獎池：<strong>{{ formatPool(jackpotPool) }}</strong>
        </p>
      </section>

      <!-- 遊戲入口 -->
      <section class="game-grid" aria-label="遊戲入口">
        <RouterLink
          v-for="game in games"
          :key="game.name"
          :to="game.route"
          class="game-card"
          :aria-label="game.name"
        >
          <span class="game-icon">{{ game.icon }}</span>
          <span class="game-name">{{ game.name }}</span>
          <span class="game-desc">{{ game.desc }}</span>
        </RouterLink>
      </section>
    </main>
  </div>
</template>

<style scoped>
.lobby {
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
}

.brand {
  font-size: 1.25rem;
  font-weight: 700;
  color: #ffd700;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 1rem;
}

.username {
  color: rgba(255, 255, 255, 0.8);
  font-size: 0.9rem;
}

.daily-btn {
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  border: 1px solid rgba(255, 215, 0, 0.4);
  background: rgba(255, 215, 0, 0.1);
  color: #ffd700;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}

.daily-btn:hover {
  background: rgba(255, 215, 0, 0.2);
}

.logout-btn {
  padding: 0.35rem 0.85rem;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: transparent;
  color: rgba(255, 255, 255, 0.7);
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.2s;
}

.logout-btn:hover {
  border-color: #ffd700;
  color: #ffd700;
}

/* 公告 */
.announcement-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 1.5rem;
  background: rgba(255, 215, 0, 0.15);
  border-bottom: 1px solid rgba(255, 215, 0, 0.3);
  font-size: 0.9rem;
  color: #ffd700;
}

.close-btn {
  background: transparent;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1rem;
  padding: 0 0.25rem;
}

/* Main */
.main {
  flex: 1;
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  padding: 2rem 1rem;
}

.welcome {
  text-align: center;
  margin-bottom: 2.5rem;
}

.welcome h2 {
  font-size: 1.6rem;
  color: #ffd700;
  margin-bottom: 0.5rem;
}

.jackpot-info {
  color: rgba(255, 255, 255, 0.7);
  font-size: 1rem;
}

.jackpot-info strong {
  color: #ffd700;
}

/* 遊戲格 */
.game-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem;
}

.game-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 1.5rem 1rem;
  border-radius: 12px;
  border: 1px solid rgba(255, 215, 0, 0.2);
  background: rgba(255, 255, 255, 0.04);
  text-decoration: none;
  color: #fff;
  transition: all 0.25s;
  cursor: pointer;
}

.game-card:hover {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.08);
  transform: translateY(-2px);
}

.game-icon {
  font-size: 2.5rem;
}

.game-name {
  font-size: 1.1rem;
  font-weight: 600;
}

.game-desc {
  font-size: 0.8rem;
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
}

@media (max-width: 480px) {
  .game-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
