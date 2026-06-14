/**
 * Jackpot 路由（掛載於 /api/jackpot，見 app.ts；規格凍結於 docs/04_API_SPEC.md §3.6）。
 *
 * GET /pool     — 獎池即時值（公開，無需認證）：pool(DB) + 未落庫增量(Redis)。
 *                 前端 JackpotTicker 連線後改由 Socket jackpot:tick 每 5 秒接收，
 *                 本端點僅供首屏載入 / 無 Socket 場景，不應輪詢。
 * GET /history  — 歷史中獎紀錄分頁（公開）。
 *
 * BigInt 欄位依 docs/04_API_SPEC.md §1.6 序列化為字串。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createJackpotService, type JackpotService } from './jackpot.service.js';

const HistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export interface JackpotRoutesOptions {
  /** 測試注入：覆寫整個 service（fake 依賴） */
  service?: Pick<JackpotService, 'getPoolStatus' | 'getHistory'>;
}

const jackpotRoutes: FastifyPluginAsync<JackpotRoutesOptions> = async (app, opts) => {
  const service =
    opts.service ??
    createJackpotService({
      prisma: app.prisma,
      redis: app.redis,
      wallet: createWalletService(app.prisma),
      log: app.log,
    });

  app.get('/pool', async () => {
    const status = await service.getPoolStatus();
    return {
      pool: status.pool.toString(),
      updatedAt: status.updatedAt.toISOString(),
    };
  });

  app.get('/history', async (request) => {
    const query = parse(HistoryQuerySchema, request.query);
    const result = await service.getHistory(query);
    return {
      items: result.items.map((item) => ({
        id: item.id,
        userId: item.userId,
        username: item.username,
        avatarId: item.avatarId,
        poolBefore: item.poolBefore.toString(),
        payout: item.payout.toString(),
        remained: item.remained.toString(),
        createdAt: item.createdAt.toISOString(),
      })),
      total: result.total,
      page: result.page,
      limit: result.limit,
    };
  });
};

export default jackpotRoutes;
