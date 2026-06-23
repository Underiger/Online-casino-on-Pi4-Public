/**
 * 扭蛋機路由（掛載於 /api/gacha）。
 *
 * GET  /catalog — 扭蛋池 + 個人收集狀態 + 機率/回饋（authenticated）
 * POST /pull    — 抽取護符，count=1（單抽）或 10（十連）（authenticated）
 *
 * 注意：扭蛋為「花 Coin 抽護符」的商店型操作，不走下注的 HMAC 簽章路徑
 *      （同 charm / daily / gift-code）；以 JWT 驗證 + app.ts 的 rate-limit 防濫抽。
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/validation.js';
import { GACHA_TEN_PULL_COUNT } from '../../config/constants.js';
import { createGachaService, type GachaService } from './gacha.service.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createAchievementService } from '../achievement/achievement.service.js';

const PullReqSchema = z.object({
  count: z.union([z.literal(1), z.literal(GACHA_TEN_PULL_COUNT)]),
});

export interface GachaRoutesOptions {
  /** 測試注入 */
  service?: GachaService;
}

const gachaRoutes: FastifyPluginAsync<GachaRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const service =
    opts.service ?? createGachaService({ prisma: app.prisma, wallet });
  const achievement = createAchievementService({
    prisma: app.prisma,
    wallet,
    log: app.log,
  });

  app.get('/catalog', { preHandler: [app.authenticate] }, async (request) => {
    return service.getCatalog(request.user.sub);
  });

  app.post('/pull', { preHandler: [app.authenticate] }, async (request) => {
    const { count } = parse(PullReqSchema, request.body);
    const result = await service.pull(request.user.sub, count);

    // 抽到新護符才檢查收集成就（CHARM_COLLECT_6 / CHARM_COLLECT_12，fire-and-forget）
    if (result.grantedNew) {
      const io = app.hasDecorator('io') ? app.io : null;
      const achIo = io
        ? { to: (room: string) => ({ emit: (ev: string, d: unknown): void => void io.to(room).emit(ev, d) }) }
        : undefined;
      void achievement.checkCharmMilestone(request.user.sub, achIo).catch(() => {});
    }

    return result;
  });
};

export default gachaRoutes;
