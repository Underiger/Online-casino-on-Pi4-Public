import { ref, computed } from 'vue';
import { defineStore } from 'pinia';

const LS_ACCESS = 'admin_access_token';
const LS_REFRESH = 'admin_refresh_token';

export interface AdminUser {
  id: string;
  username: string;
  role: string;
  totpEnabled: boolean;
  telegramEnabled: boolean;
}

export const useAdminAuthStore = defineStore('adminAuth', () => {
  const accessToken = ref<string | null>(localStorage.getItem(LS_ACCESS));
  const refreshToken = ref<string | null>(localStorage.getItem(LS_REFRESH));
  const user = ref<AdminUser | null>(null);

  /** reverifyToken 不落 localStorage（安全考量） */
  const reverifyToken = ref<string | null>(null);
  const reverifyExpiresAt = ref<number>(0);

  const isLoggedIn = computed(() => accessToken.value !== null);

  /** TOTP 是否已驗證（或帳號未啟用 TOTP） */
  const isTotpVerified = computed(() => {
    if (user.value === null) return false;
    if (!user.value.totpEnabled) return true;
    return reverifyToken.value !== null && Date.now() < reverifyExpiresAt.value;
  });

  const hasValidReverifyToken = computed(
    () => reverifyToken.value !== null && Date.now() < reverifyExpiresAt.value,
  );

  function setTokens(access: string, refresh: string): void {
    accessToken.value = access;
    refreshToken.value = refresh;
    localStorage.setItem(LS_ACCESS, access);
    localStorage.setItem(LS_REFRESH, refresh);
  }

  function setUser(u: AdminUser): void {
    user.value = u;
  }

  function setReverifyToken(token: string, expiresIn: number): void {
    reverifyToken.value = token;
    reverifyExpiresAt.value = Date.now() + expiresIn * 1000;
  }

  function clear(): void {
    accessToken.value = null;
    refreshToken.value = null;
    user.value = null;
    reverifyToken.value = null;
    reverifyExpiresAt.value = 0;
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
  }

  return {
    accessToken,
    refreshToken,
    user,
    reverifyToken,
    reverifyExpiresAt,
    isLoggedIn,
    isTotpVerified,
    hasValidReverifyToken,
    setTokens,
    setUser,
    setReverifyToken,
    clear,
  };
});
