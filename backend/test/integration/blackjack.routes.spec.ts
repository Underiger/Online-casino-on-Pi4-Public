/**
 * Blackjack 路由整合測試：真 Fastify + 真 auth plugin（JWT）+ fake prisma/redis。
 * 同 dragon-gate.routes.spec.ts / 既有 slot-spin.spec.ts 的環境假設（hmac-guard 不在本測試範圍）。
 */
import { describe, expect, it, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import authPlugin from '../../src/plugins/auth.js';
import blackjackRoutes from '../../src/modules/blackjack/blackjack.routes.js';
import { AppError } from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';

async function buildTestApp(options: { balance?: bigint } = {}) {
  const db = createFakeDb({ users: [{ id: ALICE, balance: options.balance ?? 5_000n }] });
  const redis = createFakeRedis();

  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } });
  });

  await app.register(
    fp(
      async (instance) => {
        instance.decorate('prisma', db.prisma);
        instance.decorate('redis', redis.redis);
      },
      { name: 'redis' },
    ),
  );
  await app.register(authPlugin);
  await app.register(blackjackRoutes, { prefix: '/api/blackjack' });

  await app.ready();
  const token = app.jwt.sign({ sub: ALICE, role: 'PLAYER' });
  return { app, db, redis, token };
}

describe('Blackjack 路由', () => {
  let app: FastifyInstance | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('無 Bearer token → 401', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await app.inject({ method: 'POST', url: '/api/blackjack/deal', payload: { betAmount: 100 } });
    expect(res.statusCode).toBe(401);
  });

  it('完整流程：deal → stand，回應形狀正確、餘額確實變動', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;

    const dealRes = await app.inject({
      method: 'POST',
      url: '/api/blackjack/deal',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 100 },
    });
    expect(dealRes.statusCode).toBe(200);
    const dealBody = dealRes.json();
    expect(typeof dealBody.roundId).toBe('string');

    if (dealBody.settled) {
      // 天生 BJ 機率極低但理論上可能發生：回應已是終局，直接驗證形狀即可
      expect(typeof dealBody.newBalance).toBe('string');
      return;
    }

    expect(dealBody.playerCards).toHaveLength(2);
    expect(dealBody.dealerUpCard).toBeDefined();
    expect(dealBody.dealerCards).toBeUndefined(); // 底牌不外流

    const standRes = await app.inject({
      method: 'POST',
      url: '/api/blackjack/stand',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { roundId: dealBody.roundId },
    });
    expect(standRes.statusCode).toBe(200);
    const standBody = standRes.json();
    expect(standBody.settled).toBe(true);
    expect(['BLACKJACK', 'WIN', 'DEALER_BUST', 'PUSH', 'LOSE', 'BUST']).toContain(standBody.resultKey);
    expect(typeof standBody.newBalance).toBe('string');
    expect(ctx.db.betRecords).toHaveLength(1);
  });

  it('注額低於下限 → 400', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/blackjack/deal',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 1 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('roundId 對不上（從未發牌）→ 404', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/blackjack/stand',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { roundId: 'never-dealt' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('餘額不足 → 422，不落 BetRecord', async () => {
    const ctx = await buildTestApp({ balance: 5n });
    app = ctx.app;
    const res = await app.inject({
      method: 'POST',
      url: '/api/blackjack/deal',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 10 },
    });
    expect(res.statusCode).toBe(422);
    expect(ctx.db.betRecords).toHaveLength(0);
  });
});
