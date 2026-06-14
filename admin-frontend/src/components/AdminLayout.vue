<template>
  <div class="layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar__logo">Casino Admin</div>
      <nav class="sidebar__nav">
        <RouterLink to="/players" class="nav-item" active-class="nav-item--active">
          <span>👥</span> 玩家管理
        </RouterLink>
        <RouterLink to="/gift-codes" class="nav-item" active-class="nav-item--active">
          <span>🎁</span> Gift Code
        </RouterLink>
        <RouterLink to="/records" class="nav-item" active-class="nav-item--active">
          <span>📋</span> 紀錄查詢
        </RouterLink>
        <RouterLink to="/monitor" class="nav-item" active-class="nav-item--active">
          <span>📊</span> 系統監控
        </RouterLink>
        <RouterLink to="/announcements" class="nav-item" active-class="nav-item--active">
          <span>📢</span> 公告管理
        </RouterLink>
      </nav>
    </aside>

    <!-- Main -->
    <div class="main">
      <header class="topbar">
        <div class="topbar__title">
          <slot name="title" />
        </div>
        <div class="topbar__user">
          <span class="topbar__username">{{ auth.user?.username ?? '—' }}</span>
          <button class="btn btn--ghost btn--sm" :disabled="loggingOut" @click="logout">
            {{ loggingOut ? '…' : '登出' }}
          </button>
        </div>
      </header>
      <main class="content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAdminAuthStore } from '../stores/auth';
import { useUiStore } from '../stores/ui';
import { apiLogout, extractErrorMessage } from '../api/admin';

const auth = useAdminAuthStore();
const ui = useUiStore();
const router = useRouter();
const loggingOut = ref(false);

async function logout(): Promise<void> {
  loggingOut.value = true;
  try {
    const rt = auth.refreshToken;
    if (rt !== null) await apiLogout(rt);
  } catch (err) {
    ui.addToast(extractErrorMessage(err), 'error');
  } finally {
    auth.clear();
    loggingOut.value = false;
    await router.push('/login');
  }
}
</script>

<style scoped>
.layout {
  display: flex;
  min-height: 100vh;
}

.sidebar {
  width: 220px;
  background: #1e293b;
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  position: fixed;
  top: 0;
  left: 0;
  bottom: 0;
  z-index: 100;
}

.sidebar__logo {
  padding: 20px 16px;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  border-bottom: 1px solid #334155;
  letter-spacing: 0.5px;
}

.sidebar__nav {
  display: flex;
  flex-direction: column;
  padding: 12px 0;
  gap: 2px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  color: #94a3b8;
  text-decoration: none;
  border-radius: 0;
  font-size: 14px;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover {
  background: #334155;
  color: #e2e8f0;
}
.nav-item--active {
  background: #2563eb;
  color: #fff;
}

.main {
  margin-left: 220px;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  flex: 1;
}

.topbar {
  height: 56px;
  background: #fff;
  border-bottom: 1px solid #e2e8f0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  position: sticky;
  top: 0;
  z-index: 50;
}

.topbar__title {
  font-size: 16px;
  font-weight: 600;
  color: #1e293b;
}

.topbar__user {
  display: flex;
  align-items: center;
  gap: 10px;
}

.topbar__username {
  color: #475569;
  font-size: 13px;
}

.content {
  padding: 24px;
  flex: 1;
}
</style>
