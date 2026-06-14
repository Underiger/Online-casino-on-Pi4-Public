import { createRouter, createWebHistory } from 'vue-router';
import { useAdminAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory('/admin/'),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('../views/LoginView.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/',
      component: () => import('../components/AdminLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        { path: '', redirect: '/players' },
        {
          path: 'players',
          name: 'Players',
          component: () => import('../views/PlayersView.vue'),
        },
        {
          path: 'gift-codes',
          name: 'GiftCodes',
          component: () => import('../views/GiftCodeView.vue'),
        },
        {
          path: 'records',
          name: 'Records',
          component: () => import('../views/RecordsView.vue'),
        },
        {
          path: 'monitor',
          name: 'Monitor',
          component: () => import('../views/MonitorView.vue'),
        },
        {
          path: 'announcements',
          name: 'Announcements',
          component: () => import('../views/AnnouncementView.vue'),
        },
      ],
    },
    { path: '/:pathMatch(.*)*', redirect: '/players' },
  ],
});

router.beforeEach((to) => {
  const auth = useAdminAuthStore();
  const requiresAuth = to.meta.requiresAuth !== false;

  if (requiresAuth && !auth.isLoggedIn) {
    return '/login';
  }
  if (requiresAuth && auth.isLoggedIn && !auth.isTotpVerified) {
    return '/login';
  }
  if (!requiresAuth && auth.isLoggedIn && auth.isTotpVerified) {
    return '/players';
  }
  return true;
});

export default router;
