/**
 * Slot 路由整合測試（M11）：真 Fastify + 真 auth plugin（JWT）+ fake prisma/redis。
 *
 * 與既有整合測試一致的環境假設：無 PG / Redis 可跑。
 * hmac-guard 為 buildApp 的全域 hook，不在本測試範圍（其驗證邏輯已由
 * hmac.spec / nonce.spec / socket-connection.spec 覆蓋）；
 * 本檔聚焦路由 → service → wallet 組裝與 HTTP 邊界（401 / 400 / 422 / 200 / 序列化）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import authPlugin from '../../src/plugins/auth.js';
import slotRoutes from '../../src/modules/slot/slot.routes.js';
import { createSlotService } from '../../src/modules/slot/slot.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { AppError } from '../../src/shared/errors.js';
import { createFakeDb, createFakeRedis, makeRng } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';

async function buildTestApp(options: { balance?: bigint; rngPoints?: number[] } = {}) {
  const db = createFakeDb({ users: [{ id: ALICE, balance: options.balance ?? 5_000n }] });
  const redis = createFakeRedis();

  const app = Fastify({ logger: false });

  // 與 buildApp 同義的錯誤格式（AppError → { error: { code, message } }）
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } });
  });

  // 以名稱 'redis' 滿足 auth plugin 的 fp dependencies；一併掛 prisma fake
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

  // 決定性 rng 時注入 service；否則走路由內建組裝（真 csprng）
  const routeOpts =
    options.rngPoints !== undefined
      ? {
          service: createSlotService({
            prisma: app.prisma,
            redis: redis.redis,
            wallet: createWalletService(app.prisma),
            // M14 樁：不觸發、不派彩（觸發路徑由 slot.service 單元測試覆蓋）
            jackpot: {
              accumulate: async () => 0,
              tryTriggerJackpot: () => false,
              payout: async () => null,
            },
            rng: makeRng(options.rngPoints),
          }),
        }
      : {};
  await app.register(slotRoutes, { prefix: '/api/slot', ...routeOpts });

  await app.ready();
  const token = app.jwt.sign({ sub: ALICE, role: 'PLAYER' });
  return { app, db, redis, token };
}

describe('POST /api/slot/spin', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('無 Bearer token → 401 UNAUTHORIZED', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/slot/spin',
      payload: { betAmount: 10 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('注額非 10/50/100 → 400 VALIDATION_ERROR（凍結規格）', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;

    for (const betAmount of [20, 0, -10, 'abc']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/slot/spin',
        headers: { authorization: `Bearer ${ctx.token}` },
        payload: { betAmount },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('決定性中獎：200 + SpinRes 全欄位 + newBalance 字串序列化', async () => {
    const ctx = await buildTestApp({ rngPoints: [0, 0, 0] }); // CHERRY 三連
    app = ctx.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 10 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      betAmount: 10,
      reels: ['CHERRY', 'CHERRY', 'CHERRY'],
      payout: 40,
      newBalance: '5030', // BigInt → string（§1.6）
      pityActive: false,
      pityCounter: 0,
      jackpotTriggered: false,
      jackpotPoints: 0,
      luckySymbol: null,
    });
    expect(body['betRecordId']).toBeTypeOf('string');
    expect(body['serverSeedHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(ctx.db.betRecords).toHaveLength(1);
  });

  it('真 csprng 路徑：回應結構合法、帳目自洽（結構性斷言，不假設盤面）', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 100 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      reels: string[];
      payout: number;
      newBalance: string;
    };
    const VALID = ['CHERRY', 'LEMON', 'BELL', 'BAR', 'CLOVER', 'LUCKY7', 'DIAMOND', 'WILD'];
    expect(body.reels).toHaveLength(3);
    for (const symbol of body.reels) expect(VALID).toContain(symbol);
    // 帳目不變量：newBalance = 5000 − 100 + payout
    expect(body.newBalance).toBe((5_000 - 100 + body.payout).toString());
    expect(ctx.db.users[0]!.balance).toBe(BigInt(body.newBalance));
  });

  it('餘額不足 → 422 INSUFFICIENT_BALANCE，零落帳', async () => {
    const ctx = await buildTestApp({ balance: 5n });
    app = ctx.app;

    const res = await app.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 10 },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_BALANCE' } });
    expect(ctx.db.betRecords).toHaveLength(0);
    expect(ctx.db.txRecords).toHaveLength(0);
    expect(ctx.db.users[0]!.balance).toBe(5n);
  });
});

describe('GET /api/slot/paytable 與 /history', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('paytable：200、8 entries、需登入', async () => {
    const ctx = await buildTestApp();
    app = ctx.app;

    const unauth = await app.inject({ method: 'GET', url: '/api/slot/paytable' });
    expect(unauth.statusCode).toBe(401);

    const res = await app.inject({
      method: 'GET',
      url: '/api/slot/paytable',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entries: unknown[]; luckyMultiplierBonus: number };
    expect(body.entries).toHaveLength(8);
    expect(body.luckyMultiplierBonus).toBe(1.5);
  });

  it('history：spin 後可查得紀錄，createdAt 為 ISO 字串', async () => {
    const ctx = await buildTestApp({ rngPoints: [0, 0, 0] });
    app = ctx.app;

    await app.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: { authorization: `Bearer ${ctx.token}` },
      payload: { betAmount: 10 },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/slot/history?page=1&limit=20',
      headers: { authorization: `Bearer ${ctx.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      betAmount: 10,
      payout: 40,
      reels: ['CHERRY', 'CHERRY', 'CHERRY'],
      jackpotTriggered: false,
    });
    expect(Date.parse(body.items[0]!['createdAt'] as string)).not.toBeNaN();
  });
});
