/**
 * Vue Router（04_FOLDER_STRUCTURE §2 router/index.ts）。
 * 路由守衛：未登入訪問需認證路由 → 跳轉 /login。
 */
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    name: 'lobby',
    component: () => import('../views/LobbyView.vue'),
    meta: { requiresAuth: true },
  },
  // 後續 Milestone 補充的路由佔位（M11/M15/M17/M19/M20）
  {
    path: '/slot',
    name: 'slot',
    component: () => import('../views/SlotView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/roulette',
    name: 'roulette',
    component: () => import('../views/RouletteView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/leaderboard',
    name: 'leaderboard',
    component: () => import('../views/LeaderboardView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/profile',
    name: 'profile',
    component: () => import('../views/ProfileView.vue'),
    meta: { requiresAuth: true },
  },
  // 404 fallback
  {
    path: '/:pathMatch(.*)*',
    redirect: '/',
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// ── 路由守衛：未登入強制跳轉 /login ──
router.beforeEach((to, _from, next) => {
  if (to.meta.requiresAuth === true) {
    // 懶載入 auth store（確保 Pinia 已掛載）
    import('../stores/auth').then(({ useAuthStore }) => {
      const auth = useAuthStore();
      if (!auth.isLoggedIn) {
        next({ name: 'login', query: { redirect: to.fullPath } });
      } else {
        next();
      }
    }).catch(() => next({ name: 'login' }));
  } else {
    next();
  }
});

export default router;
