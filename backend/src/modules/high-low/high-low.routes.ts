/**
 * High-Low 路由（掛載於 /api/high-low；規格見 docs/04_API_SPEC.md High-Low 章節）。
 *
 * POST /deal      — 下注開局（authenticate + 全域 hmac-guard；betAmount 是客戶端注額）
 * POST /guess     — 猜高/低（authenticate；不帶新注額，不需要 HMAC）
 * POST /continue  — 收手後選擇繼續（authenticate；同上）
 * POST /cash-out  — 收手入袋（authenticate；派彩金額是伺服器存的目前彩池，同上）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HIGH_LOW_MAX_BET, HIGH_LOW_MIN_BET } from '../../config/constants.js';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createHighLowService, type HighLowService } from './high-low.service.js';

const DealReqSchema = z.object({
  betAmount: z.number().int().min(HIGH_LOW_MIN_BET).max(HIGH_LOW_MAX_BET),
});

const RoundReqSchema = z.object({
  roundId: z.string().min(1),
});

const GuessReqSchema = z.object({
  roundId: z.string().min(1),
  guessHigh: z.boolean(),
});

export interface HighLowRoutesOptions {
  /** 測試注入：覆寫整個 service（決定性 rng / fake 依賴） */
  service?: HighLowService;
}

const highLowRoutes: FastifyPluginAsync<HighLowRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const service =
    opts.service ??
    createHighLowService({
      prisma: app.prisma,
      redis: app.redis,
      wallet,
      log: app.log,
    });

  app.post('/deal', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(DealReqSchema, request.body);
    const result = await service.deal(request.user.sub, body.betAmount);
    return { roundId: result.roundId, baseCard: result.baseCard, pot: result.pot };
  });

  app.post('/guess', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(GuessReqSchema, request.body);
    const result = await service.guess(request.user.sub, body.roundId, body.guessHigh);
    return {
      outcome: result.outcome,
      revealedCard: result.revealedCard,
      pot: result.pot,
      streak: result.streak,
      newBalance: result.newBalance?.toString() ?? null,
      payout: result.payout,
    };
  });

  app.post('/continue', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(RoundReqSchema, request.body);
    const result = await service.continueRound(request.user.sub, body.roundId);
    return { baseCard: result.baseCard, pot: result.pot, streak: result.streak };
  });

  app.post('/cash-out', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(RoundReqSchema, request.body);
    const result = await service.cashOut(request.user.sub, body.roundId);
    return { payout: result.payout, newBalance: result.newBalance.toString() };
  });
};

export default highLowRoutes;
