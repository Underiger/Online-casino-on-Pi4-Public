import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from 'axios';

const RETRY_FLAG = '__retried';

function createHttp(): AxiosInstance {
  const http = axios.create({
    baseURL: '/api',
    timeout: 15_000,
    headers: { 'Content-Type': 'application/json' },
  });

  http.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
    const { useAdminAuthStore } = await import('../stores/auth');
    const auth = useAdminAuthStore();
    if (auth.accessToken !== null) {
      config.headers.set('Authorization', `Bearer ${auth.accessToken}`);
    }
    return config;
  });

  http.interceptors.response.use(
    (response) => response,
    async (error: unknown) => {
      if (!axios.isAxiosError(error)) return Promise.reject(error);

      const config = error.config as
        | (InternalAxiosRequestConfig & { [RETRY_FLAG]?: boolean })
        | undefined;
      const status = error.response?.status;

      if (status !== 401 || config === undefined || config[RETRY_FLAG] === true) {
        return Promise.reject(error);
      }

      try {
        const { useAdminAuthStore } = await import('../stores/auth');
        const auth = useAdminAuthStore();
        const rt = auth.refreshToken;
        if (rt === null) throw new Error('no_refresh_token');

        const res = await axios.post<{ accessToken: string; refreshToken: string }>(
          '/api/auth/refresh',
          { refreshToken: rt },
        );
        auth.setTokens(res.data.accessToken, res.data.refreshToken);

        config[RETRY_FLAG] = true;
        config.headers.set('Authorization', `Bearer ${res.data.accessToken}`);
        return http(config);
      } catch {
        const { useAdminAuthStore } = await import('../stores/auth');
        const auth = useAdminAuthStore();
        auth.clear();
        const { useRouter } = await import('vue-router');
        const router = useRouter();
        await router.push('/login');
        return Promise.reject(error);
      }
    },
  );

  return http;
}

export const http = createHttp();
export default http;
