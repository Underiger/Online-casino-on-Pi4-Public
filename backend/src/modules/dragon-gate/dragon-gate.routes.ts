/**
 * 射龍門路由（掛載於 /api/dragon-gate；規格見 docs/04_API_SPEC.md 射龍門章節）。
 *
 * POST /open — 開門牌（authenticate；不動錢，無需 HMAC）
 * POST /bet  — 下注（authenticate + 全域 hmac-guard：x-sig/x-nonce/x-ts/x-seq；
 *              betAmount 是請求 body 真正帶的客戶端注額，因此需要簽章）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { DRAGON_GATE_MAX_BET, DRAGON_GATE_MIN_BET } from '../../config/constants.js';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createDragonGateService, type DragonGateService } from './dragon-gate.service.js';

const BetReqSchema = z.object({
  roundId: z.string().min(1),
  betAmount: z.number().int().min(DRAGON_GATE_MIN_BET).max(DRAGON_GATE_MAX_BET),
});

export interface DragonGateRoutesOptions {
  /** 測試注入：覆寫整個 service（決定性 rng / fake 依賴） */
  service?: DragonGateService;
}

const dragonGateRoutes: FastifyPluginAsync<DragonGateRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const service =
    opts.service ??
    createDragonGateService({
      prisma: app.prisma,
      redis: app.redis,
      wallet,
      log: app.log,
    });

  app.post('/open', { preHandler: [app.authenticate] }, async (request) => {
    const result = await service.open(request.user.sub);
    return {
      roundId: result.roundId,
      doors: result.doors,
      gap: result.gap,
      oddsMode: result.oddsMode,
      multiplier: result.multiplier,
    };
  });

  app.post('/bet', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(BetReqSchema, request.body);
    const outcome = await service.bet(request.user.sub, body.roundId, body.betAmount);
    return {
      betRecordId: outcome.betRecordId,
      outcome: outcome.outcome,
      thirdCard: outcome.thirdCard,
      betAmount: outcome.betAmount,
      payout: outcome.payout,
      extraLossApplied: outcome.extraLossApplied,
      newBalance: outcome.newBalance.toString(),
      doors: outcome.doors,
      gap: outcome.gap,
      multiplier: outcome.multiplier,
    };
  });
};

export default dragonGateRoutes;
