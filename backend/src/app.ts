/**
 * Fastify 實例組裝（04_FOLDER_STRUCTURE §1）：
 *   錯誤處理 → plugins → modules。
 *
 * 錯誤回應統一格式：{ error: { code, message } }
 *   - AppError：依其 statusCode/code 回應
 *   - Fastify schema 驗證錯誤：400 VALIDATION_ERROR
 *   - 其他 5xx：一律 INTERNAL_ERROR 通用訊息，完整錯誤只寫日誌，永不洩漏 stack
 *
 * 注意：setErrorHandler / setNotFoundHandler 必須在「註冊任何 module 之前」呼叫——
 * Fastify 子封裝 context 在註冊當下繼承父層 handler，後設定的不會回溯生效。
 */
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { env } from './config/env.js';
import { AppError } from './shared/errors.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import rateLimitPlugin from './plugins/rate-limit.js';
import hmacGuardPlugin from './plugins/hmac-guard.js';
import authRoutes from './modules/auth/auth.routes.js';
import walletRoutes from './modules/wallet/wallet.routes.js';
import slotRoutes from './modules/slot/slot.routes.js';
import charmRoutes from './modules/charm/charm.routes.js';
import jackpotRoutes from './modules/jackpot/jackpot.routes.js';
import rouletteRoutes from './modules/roulette/roulette.routes.js';
import dailyRoutes from './modules/daily/daily.routes.js';
import leaderboardRoutes from './modules/leaderboard/leaderboard.routes.js';
import achievementRoutes from './modules/achievement/achievement.routes.js';
import adminRoutes, { publicAnnouncementRoutes } from './modules/admin/admin.routes.js';
import giftCodeRoutes from './modules/gift-code/gift-code.routes.js';
import recordRoutes from './modules/record/record.routes.js';
import monitorRoutes from './modules/monitor/monitor.routes.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // 機密欄位永不進日誌
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(env.NODE_ENV === 'development'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
            },
          }
        : {}),
    },
    trustProxy: true, // 部署於 Nginx 之後（02_TDD 架構圖），取真實 client IP
    bodyLimit: 32 * 1024, // 本專案無大 payload 需求，32KB 足夠且防濫用
  });

  // ── 全域錯誤處理（先於所有 module 註冊，讓子 context 繼承） ──
  app.setErrorHandler((err: FastifyError, request, reply) => {
    // 1) 業務錯誤：AppError 階層
    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        request.log.error({ err }, err.code);
      }
      return reply
        .code(err.statusCode)
        .send({ error: { code: err.code, message: err.message } });
    }

    // 2) Fastify route schema 驗證錯誤
    if (err.validation) {
      return reply
        .code(400)
        .send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }

    // 3) Fastify 內建 4xx（body 超限、JSON 解析失敗…）：訊息可透出
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }

    // 4) 未知 5xx：完整錯誤進日誌，回應永不洩漏內部細節
    request.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } });
  });

  // ── 404 ──
  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `路由不存在：${request.method} ${request.url}` },
    });
  });

  // ── plugins（裝飾 app 實例；fastify-plugin 穿透封裝，全 app 可見） ──
  await app.register(fastifyCookie); // refresh token cookie 預留
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);

  // ── 安全基座（M06）：全域 preHandler，註冊順序 = 執行順序（先限流再驗章） ──
  await app.register(rateLimitPlugin, {
    allowList: ['/healthz'],
    // 下注路由收緊至遊戲節奏上限（聊天令牌桶於 M17 在 chat 模組內另設）
    routeRules: {
      'POST /api/slot/spin': { capacity: 5, refillPerSec: 2 },
      'POST /api/roulette/bet': { capacity: 5, refillPerSec: 2 },
    },
  });
  await app.register(hmacGuardPlugin, {
    // 簽章僅針對 signedRoutes（slot spin / roulette bet）；
    // 白名單為雙保險——auth 與健康檢查永不受簽章檢查
    allowList: ['/healthz', '/api/auth'],
  });

  // ── modules（依 Milestone 順序掛載：auth → user → wallet → slot → …） ──
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(walletRoutes, { prefix: '/api/wallet' });
  // POST /api/slot/spin 自動受 hmac-guard signedRoutes 與 rate-limit routeRules 保護（M06 預埋）
  await app.register(slotRoutes, { prefix: '/api/slot' });
  await app.register(charmRoutes, { prefix: '/api/charm' });
  // 公開路由（無認證；docs/04_API_SPEC.md §3.6）——pool 查詢與歷史中獎
  await app.register(jackpotRoutes, { prefix: '/api/jackpot' });
  // M15：輪盤狀態查詢（下注/取消走 Socket；狀態機於 initSocketServer 啟動）
  await app.register(rouletteRoutes, { prefix: '/api/roulette' });
  // M18：每日系統（登入獎勵 + 隨機任務 + 領取獎勵）
  await app.register(dailyRoutes, { prefix: '/api/daily' });
  // M19：排行榜（公開；無需認證；docs/04_API_SPEC.md §3.9）
  await app.register(leaderboardRoutes, { prefix: '/api/leaderboard' });
  // M20：成就清單 + 個人資料（/api/achievements 與 /api/user/profile）
  await app.register(achievementRoutes, { prefix: '/api' });
  // M21：管理後台（JWT + role===ADMIN；高危操作另需 2FA reverifyToken）
  await app.register(adminRoutes, { prefix: '/api/admin' });
  // M21：公開有效公告（無需認證；玩家端讀取）
  await app.register(publicAnnouncementRoutes, { prefix: '/api/announcements' });
  // M22：禮物碼兌換（一般認證玩家；建立在 /api/admin/gift-codes 高危路由）
  await app.register(giftCodeRoutes, { prefix: '/api/gift-codes' });
  // M22：管理後台紀錄查詢（JWT + role===ADMIN）
  await app.register(recordRoutes, { prefix: '/api/admin/records' });
  // M24：系統監控（adminOnly GET /api/admin/monitor）
  await app.register(monitorRoutes, { prefix: '/api/admin' });

  // 健康檢查：Nginx upstream check 與 docker healthcheck 都打這支
  app.get('/healthz', async () => ({ ok: true }));

  return app;
}
