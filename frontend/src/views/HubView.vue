<script setup lang="ts">
/**
 * HubView（遊戲分類選擇頁）：
 * 登入後的第一站，依分類導向賭場 / 益智小遊戲 / 大富翁。
 * 賭博性質內容（賭場）獨立一頁，與其他分類分開呈現。
 */
import { useRouter } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { disconnectSocket } from '../socket/client';

const router = useRouter();
const auth = useAuthStore();

async function handleLogout(): Promise<void> {
  disconnectSocket();
  await auth.logout();
  await router.replace('/login');
}

interface CategoryItem {
  name: string;
  icon: string;
  route: string;
  desc: string;
  available: boolean;
}

const categories: CategoryItem[] = [
  { name: '賭場', icon: '🎰', route: '/casino', desc: '老虎機、輪盤、21點、射龍門、猜高低', available: true },
  { name: '益智小遊戲', icon: '🧩', route: '/minigames', desc: '俄羅斯方塊、踩地雷、小精靈……', available: false },
  { name: '大富翁', icon: '🏠', route: '/monopoly', desc: '經典棋盤對戰', available: false },
];
</script>

<template>
  <div class="hub">
    <header class="header">
      <div class="brand">🎮 遊戲中心</div>
      <div class="header-right">
        <span class="username">{{ auth.user?.username }}</span>
        <button class="logout-btn" @click="handleLogout">登出</button>
      </div>
    </header>

    <main class="main">
      <section class="welcome">
        <h2>歡迎回來，{{ auth.user?.username ?? '玩家' }} 🎉</h2>
        <p class="sub">選擇一個分類開始遊戲</p>
      </section>

      <section class="category-grid" aria-label="遊戲分類">
        <RouterLink
          v-for="cat in categories"
          :key="cat.name"
          :to="cat.route"
          class="category-card"
          :class="{ 'is-soon': !cat.available }"
          :aria-label="cat.name"
        >
          <span v-if="!cat.available" class="badge-soon">敬請期待</span>
          <span class="category-icon">{{ cat.icon }}</span>
          <span class="category-name">{{ cat.name }}</span>
          <span class="category-desc">{{ cat.desc }}</span>
        </RouterLink>
      </section>
    </main>
  </div>
</template>

<style scoped>
.hub {
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

/* Main */
.main {
  flex: 1;
  max-width: 900px;
  width: 100%;
  margin: 0 auto;
  padding: 3rem 1rem;
}

.welcome {
  text-align: center;
  margin-bottom: 3rem;
}

.welcome h2 {
  font-size: 1.6rem;
  color: #ffd700;
  margin-bottom: 0.5rem;
}

.sub {
  color: rgba(255, 255, 255, 0.7);
  font-size: 1rem;
}

/* 分類格 */
.category-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1.5rem;
}

.category-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.6rem;
  padding: 2.5rem 1.5rem;
  border-radius: 16px;
  border: 1px solid rgba(255, 215, 0, 0.2);
  background: rgba(255, 255, 255, 0.04);
  text-decoration: none;
  color: #fff;
  transition: all 0.25s;
  cursor: pointer;
}

.category-card:hover {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.08);
  transform: translateY(-2px);
}

.category-card.is-soon {
  border-style: dashed;
  opacity: 0.75;
}

.badge-soon {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  font-size: 0.7rem;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  background: rgba(255, 215, 0, 0.15);
  color: #ffd700;
  border: 1px solid rgba(255, 215, 0, 0.3);
}

.category-icon {
  font-size: 3rem;
}

.category-name {
  font-size: 1.25rem;
  font-weight: 600;
}

.category-desc {
  font-size: 0.85rem;
  color: rgba(255, 255, 255, 0.5);
  text-align: center;
}

@media (max-width: 480px) {
  .category-grid {
    grid-template-columns: 1fr;
  }
}
</style>
