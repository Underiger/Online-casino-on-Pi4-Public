/**
 * 環境變數驗證（02_TDD §「zod 驗證所有環境變數，缺漏即啟動失敗（fail loud）」）。
 *
 * 本模組在 import 時即完成驗證——任何模組 import { env } 之前，
 * 非法或缺漏的環境變數已導致 process.exit(1) 並列出全部問題。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { z } from 'zod';

// 補載 monorepo 根目錄 .env（本機開發用；已存在的環境變數不會被覆蓋，
// Docker / CI 由外部注入則自動以注入值為準）
const rootEnvPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // cluster fork 數；Pi 4 上限 2（02_TDD：Node ×2 workers 各 512MB）
  WORKERS: z.coerce.number().int().min(1).max(4).default(2),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL 不可為空（postgresql://... 或 file:./dev.sqlite）'),
  REDIS_URL: z.string().min(1, 'REDIS_URL 不可為空（redis://localhost:6379）'),

  // JWT HS256 簽章金鑰；過短直接拒啟動（scripts/gen-secrets.sh 產生 128 hex chars）
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET 長度必須 ≥ 32 字元（請執行 scripts/gen-secrets.sh）'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(7),

  // AES-256-GCM 金鑰（TOTP secret 加密用，M21 啟用）：恰 32 bytes = 64 hex chars
  AES_256_GCM_KEY: z
    .string()
    .regex(
      /^[0-9a-f]{64}$/i,
      'AES_256_GCM_KEY 必須為 64 個 hex 字元（請執行 scripts/gen-secrets.sh）',
    ),

  SOCKET_MAX_CONNECTIONS: z.coerce.number().int().min(1).default(200),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  // fail loud：列出全部問題後拒絕啟動（此時 logger 尚未建立，使用 console.error）
  console.error('環境變數驗證失敗，伺服器拒絕啟動：');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
  }
  console.error('請對照 .env.example 補齊，機密值可用 scripts/gen-secrets.sh 產生。');
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
