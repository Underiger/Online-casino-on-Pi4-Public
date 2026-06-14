/**
 * axios 實例（04_FOLDER_STRUCTURE §2 api/http.ts）：
 *
 * - 請求攔截器：自動附加 Authorization: Bearer <accessToken>
 * - 回應攔截器：
 *   1. 401 時發 refresh 換 token，使用新 token 單次重送原請求（避免無限迴圈）
 *   2. 非 401 錯誤：透傳（由各 endpoint 函式或元件處理）
 *
 * 循環依賴處理：useAuthStore 在攔截器內懶載入（不在模組頂層 import），
 * 避免 auth.ts 引用 http.ts 而 http.ts 又在頂層引用 auth.ts。
 */
import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

// 標記重試請求（避免 401 無限迴圈）
const RETRY_FLAG = '__retried';

function createHttp(): AxiosInstance {
  const http = axios.create({
    baseURL: '/api',
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
  });

  // ── 請求攔截器：附加 JWT ──
  // 使用 top-level import（不在模組初始化時取 store，而是在攔截器執行時取）
  http.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const { useAuthStore } = await import('../stores/auth');
    const auth = useAuthStore();
    if (auth.accessToken !== null) {
      config.headers.set('Authorization', `Bearer ${auth.accessToken}`);
    }
    return config;
  });

  // ── 回應攔截器：401 換 token + 重試 ──
  http.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      if (!axios.isAxiosError(error)) return Promise.reject(error);

      const config = error.config as (InternalAxiosRequestConfig & { [RETRY_FLAG]?: boolean }) | undefined;
      const status = error.response?.status;

      // 已重試過、無 config 或非 401 → 直接拒絕
      if (status !== 401 || config === undefined || config[RETRY_FLAG] === true) {
        return Promise.reject(error);
      }

      // 嘗試換 token（懶載入避免循環）
      try {
        const { useAuthStore } = await import('../stores/auth');
        const auth = useAuthStore();
        const newToken = await auth.refresh();

        // 帶新 token 重試
        config[RETRY_FLAG] = true;
        config.headers.set('Authorization', `Bearer ${newToken}`);
        return http(config);
      } catch {
        // refresh 失敗（過期、重用攻擊）→ 強制登出並拋出原錯誤
        const { useAuthStore } = await import('../stores/auth');
        const auth = useAuthStore();
        await auth.logout();
        return Promise.reject(error);
      }
    },
  );

  return http;
}

export const http = createHttp();
export default http;
