/**
 * Blackjack 路由（掛載於 /api/blackjack；規格見 docs/04_API_SPEC.md Blackjack 章節）。
 *
 * POST /deal    — 下注開局（authenticate + 全域 hmac-guard；betAmount 是客戶端注額）
 * POST /hit     — 要牌（authenticate；不帶新注額，不需要 HMAC）
 * POST /stand   — 停牌（authenticate；同上）
 * POST /double  — 加倍（authenticate；加注金額＝伺服器存的原始注額，同上）
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { BLACKJACK_MAX_BET, BLACKJACK_MIN_BET } from '../../config/constants.js';
import { parse } from '../../shared/validation.js';
import { createWalletService } from '../wallet/wallet.service.js';
import { createBlackjackService, type BlackjackService } from './blackjack.service.js';
import type { ActionResult } from './blackjack.types.js';

const DealReqSchema = z.object({
  betAmount: z.number().int().min(BLACKJACK_MIN_BET).max(BLACKJACK_MAX_BET),
});

const RoundReqSchema = z.object({
  roundId: z.string().min(1),
});

export interface BlackjackRoutesOptions {
  /** 測試注入：覆寫整個 service（決定性 rng / fake 依賴） */
  service?: BlackjackService;
}

/** settled 是 discriminant；BigInt newBalance 在這裡序列化成字串 */
function serialize(result: ActionResult) {
  if (result.settled) {
    return {
      settled: true,
      roundId: result.roundId,
      resultKey: result.resultKey,
      playerCards: result.playerCards,
      dealerCards: result.dealerCards,
      betAmount: result.betAmount,
      payout: result.payout,
      newBalance: result.newBalance.toString(),
    };
  }
  return {
    settled: false,
    roundId: result.roundId,
    playerCards: result.playerCards,
    dealerUpCard: result.dealerUpCard,
    betAmount: result.betAmount,
    doubled: result.doubled,
  };
}

const blackjackRoutes: FastifyPluginAsync<BlackjackRoutesOptions> = async (app, opts) => {
  const wallet = createWalletService(app.prisma);
  const service =
    opts.service ??
    createBlackjackService({
      prisma: app.prisma,
      redis: app.redis,
      wallet,
      log: app.log,
    });

  app.post('/deal', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(DealReqSchema, request.body);
    const result = await service.deal(request.user.sub, body.betAmount);
    return serialize(result);
  });

  app.post('/hit', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(RoundReqSchema, request.body);
    const result = await service.hit(request.user.sub, body.roundId);
    return serialize(result);
  });

  app.post('/stand', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(RoundReqSchema, request.body);
    const result = await service.stand(request.user.sub, body.roundId);
    return serialize(result);
  });

  app.post('/double', { preHandler: [app.authenticate] }, async (request) => {
    const body = parse(RoundReqSchema, request.body);
    const result = await service.double(request.user.sub, body.roundId);
    return serialize(result);
  });
};

export default blackjackRoutes;
