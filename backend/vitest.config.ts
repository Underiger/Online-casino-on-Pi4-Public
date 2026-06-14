import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // 覆蓋率（npm run test:coverage）：v8 provider，聚焦 src/，排除型別/入口/測試輔助
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.types.ts',
        'src/server.ts',
        'src/cluster.ts',
        'src/**/index.ts',
        'test/**',
      ],
    },
    // config/env.ts 於 import 時驗證環境變數（fail loud），測試進程先備齊
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'warn',
      PORT: '3000',
      WORKERS: '1',
      DATABASE_URL: 'file:./test.sqlite',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'vitest_jwt_secret_0123456789abcdef0123456789abcdef',
      JWT_ACCESS_TTL: '15m',
      REFRESH_TOKEN_TTL_DAYS: '7',
      AES_256_GCM_KEY:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      SOCKET_MAX_CONNECTIONS: '200',
    },
  },
});
