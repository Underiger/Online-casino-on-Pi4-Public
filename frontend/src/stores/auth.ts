/**
 * Auth store（04_FOLDER_STRUCTURE §2 stores/auth.ts）：
 * 管理登入狀態、token 生命週期、HMAC 金鑰與請求序號。
 *
 * 持久化策略（02_TDD §5.2 安全要求）：
 *   - accessToken / refreshToken / user → localStorage（頁面重新整理後恢復登入狀態）
 *   - hmacKey → 僅 Pinia 記憶體（不落 localStorage，防 XSS 竊鑰）
 *   - seq → 也落 localStorage（單純數字，非機密）。Server 端 last_seq:{userId}
 *     門檻存活 7 天，若 seq 只存記憶體，重新整理頁面會歸零但門檻不會動，
 *     第一次請求必倒退被拒（ERR_SEQ_REGRESSION）。持久化後重整頁面可接續舊值；
 *     真正的歸零時機改為 register/login 成功時（與後端 resetSequence 同步），
 *     見 auth.service.ts AuthServiceDeps.resetSeq。
 */
import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import { clearKeyCache } from '../api/sign';
import type { LoginReq, RegisterReq, RefreshRes } from '@casino/shared';

const LS_ACCESS = 'casino_access_token';
const LS_REFRESH = 'casino_refresh_token';
const LS_USER = 'casino_user';
const LS_SEQ = 'casino_seq';

export interface StoredUser {
  id: string;
  username: string;
  role: 'PLAYER' | 'ADMIN';
  balance: string;
  avatarId: number;
}

export const useAuthStore = defineStore('auth', () => {
  // ── state ──
  const accessToken = ref<string | null>(localStorage.getItem(LS_ACCESS));
  const refreshToken = ref<string | null>(localStorage.getItem(LS_REFRESH));
  const user = ref<StoredUser | null>(
    (() => {
      const raw = localStorage.getItem(LS_USER);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as StoredUser;
      } catch {
        return null;
      }
    })(),
  );

  /** HMAC 金鑰：僅存記憶體，不落 localStorage */
  const hmacKey = ref<string | null>(null);

  /** 請求序號：嚴格遞增，每次簽章後由 nextSeq() 推進；落 localStorage 撐過頁面重整 */
  const storedSeq = Number(localStorage.getItem(LS_SEQ));
  const seq = ref(Number.isFinite(storedSeq) && storedSeq > 0 ? storedSeq : 0);

  // ── computed ──
  const isLoggedIn = computed(() => accessToken.value !== null && user.value !== null);

  // ── helpers ──
  function persist(tokens: { accessToken: string; refreshToken: string; hmacKey: string }, u: StoredUser): void {
    accessToken.value = tokens.accessToken;
    refreshToken.value = tokens.refreshToken;
    hmacKey.value = tokens.hmacKey;
    user.value = u;
    // register/login 是 server 端 resetSequence 的時間點，client 端同步歸零
    seq.value = 0;
    localStorage.setItem(LS_ACCESS, tokens.accessToken);
    localStorage.setItem(LS_REFRESH, tokens.refreshToken);
    localStorage.setItem(LS_USER, JSON.stringify(u));
    localStorage.setItem(LS_SEQ, '0');
  }

  function clearPersisted(): void {
    accessToken.value = null;
    refreshToken.value = null;
    hmacKey.value = null;
    user.value = null;
    seq.value = 0;
    localStorage.removeItem(LS_ACCESS);
    localStorage.removeItem(LS_REFRESH);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_SEQ);
    clearKeyCache();
  }

  /** 呼叫後取得當前 seq 並自增（用於 signRequest）；落 localStorage 撐過頁面重整 */
  function nextSeq(): number {
    const current = seq.value++;
    localStorage.setItem(LS_SEQ, String(seq.value));
    return current;
  }

  // ── actions ──
  async function login(body: LoginReq): Promise<void> {
    const { apiLogin } = await import('../api/endpoints/auth');
    const res = await apiLogin(body);
    persist(res, res.user);
  }

  async function register(body: RegisterReq): Promise<void> {
    const { apiRegister } = await import('../api/endpoints/auth');
    const res = await apiRegister(body);
    persist(res, res.user);
  }

  /**
   * 換發 token（HTTP 401 攔截器呼叫）。
   * 直接回傳新 access token 供攔截器重送原請求。
   * 不拋出例外時才更新 store；拋出時由攔截器決定後續（強制登出）。
   */
  async function refresh(): Promise<string> {
    const rt = refreshToken.value;
    if (rt === null) throw new Error('no_refresh_token');

    const { apiRefresh } = await import('../api/endpoints/auth');
    const res: RefreshRes = await apiRefresh({ refreshToken: rt });

    accessToken.value = res.accessToken;
    refreshToken.value = res.refreshToken;
    hmacKey.value = res.hmacKey;
    localStorage.setItem(LS_ACCESS, res.accessToken);
    localStorage.setItem(LS_REFRESH, res.refreshToken);
    return res.accessToken;
  }

  async function logout(): Promise<void> {
    const rt = refreshToken.value;
    if (rt !== null) {
      try {
        const { apiLogout } = await import('../api/endpoints/auth');
        await apiLogout({ refreshToken: rt });
      } catch {
        // 登出失敗（token 已過期等）仍清除本地狀態
      }
    }
    clearPersisted();
  }

  /** 從 Server /me 路由同步餘額（wallet store 呼叫） */
  function setBalance(balance: string): void {
    if (user.value !== null) {
      user.value = { ...user.value, balance };
      localStorage.setItem(LS_USER, JSON.stringify(user.value));
    }
  }

  return {
    accessToken,
    refreshToken,
    user,
    hmacKey,
    seq,
    isLoggedIn,
    nextSeq,
    login,
    register,
    refresh,
    logout,
    setBalance,
  };
});
