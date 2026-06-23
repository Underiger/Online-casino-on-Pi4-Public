<script setup lang="ts">
/**
 * ComingSoonView：尚未開發分類的佔位頁（益智小遊戲 / 大富翁）。
 * 標題、圖示、說明透過路由 meta 注入，供多個分類共用同一元件。
 */
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const title = computed(() => (typeof route.meta.title === 'string' ? route.meta.title : '敬請期待'));
const icon = computed(() => (typeof route.meta.icon === 'string' ? route.meta.icon : '🚧'));
const desc = computed(() =>
  typeof route.meta.desc === 'string' ? route.meta.desc : '這個分類正在開發中，請密切關注後續更新！',
);
</script>

<template>
  <div class="coming-soon">
    <header class="header">
      <RouterLink to="/" class="back-btn" aria-label="返回選擇頁">← 返回選擇頁</RouterLink>
    </header>

    <main class="main">
      <span class="icon">{{ icon }}</span>
      <h1>{{ title }}</h1>
      <p class="badge">敬請期待</p>
      <p class="desc">{{ desc }}</p>
      <RouterLink to="/" class="home-btn">返回選擇頁</RouterLink>
    </main>
  </div>
</template>

<style scoped>
.coming-soon {
  min-height: 100dvh;
  background: linear-gradient(160deg, #0d0d1a 0%, #1a1a2e 60%, #16213e 100%);
  color: #fff;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: center;
  padding: 0.8rem 1.5rem;
  background: rgba(0, 0, 0, 0.4);
  border-bottom: 1px solid rgba(255, 215, 0, 0.2);
  position: sticky;
  top: 0;
}

.back-btn {
  color: rgba(255, 255, 255, 0.7);
  text-decoration: none;
  font-size: 0.9rem;
  transition: color 0.2s;
}

.back-btn:hover {
  color: #ffd700;
}

.main {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 2rem 1rem;
  gap: 0.75rem;
}

.icon {
  font-size: 4rem;
}

.main h1 {
  font-size: 1.8rem;
  color: #ffd700;
  margin: 0;
}

.badge {
  display: inline-block;
  padding: 0.2rem 0.9rem;
  border-radius: 999px;
  background: rgba(255, 215, 0, 0.15);
  border: 1px solid rgba(255, 215, 0, 0.3);
  color: #ffd700;
  font-size: 0.85rem;
}

.desc {
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.95rem;
  max-width: 360px;
}

.home-btn {
  margin-top: 1rem;
  padding: 0.5rem 1.5rem;
  border-radius: 8px;
  border: 1px solid rgba(255, 215, 0, 0.4);
  background: rgba(255, 215, 0, 0.1);
  color: #ffd700;
  text-decoration: none;
  font-size: 0.9rem;
  transition: all 0.2s;
}

.home-btn:hover {
  background: rgba(255, 215, 0, 0.2);
}
</style>
