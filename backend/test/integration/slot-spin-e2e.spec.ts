/**
 * M27 老虎機全流程 E2E 整合測試。
 *
 * 範圍（與 slot-spin.spec.ts 的分工）：
 *   slot-spin.spec.ts 聚焦「路由 → service → wallet」HTTP 邊界，且刻意略過 hmac-guard。
 *   本檔則「真的」掛上 plugins/hmac-guard.ts + rate-limit + auth 路由，跑完整鏈：
 *     註冊 → 登入（取 JWT + HMAC 會話金鑰）→ 以金鑰簽 canonical → POST /api/slot/spin。
 *   驗證：
 *     1. 簽章合法 → 200、餘額正確變動、BetRecord 與 BalanceTransaction 落庫。
 *     2. 安全防線在整合層真實生效：重放（ERR_NONCE_REPLAY）、Seq 倒退
 *        （ERR_SEQ_REGRESSION）、簽章竄改（ERR_BAD_SIGNATURE），且 IllegalPacketLog 落庫。
 *
 * 環境假設：與既有測試一致，無需 PG / Redis——以 e2e-fakes 的 in-memory fake 取代，
 * fake redis 支援 hmac 金鑰 mget / nonce SET NX / seq eval(SEQ_GUARD_LUA)，
 * 讓真實 hmac-guard 完整跑過而非降級跳過。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import slotRoutes from '../../src/modules/slot/slot.routes.js';
import { createSlotService } from '../../src/modules/slot/slot.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { createE2EDb, createE2ERedis, type E2EDb } from '../helpers/e2e-fakes.js';
import {
  buildE2EApp,
  registerAndLogin,
  signSlotSpin,
  spinHeaders,
  flushAsync,
  type Session,
} from '../helpers/e2e-app.js';

// rng 恆回 0 → 每軸抽到 CHERRY（cum 表首格），CHERRY 三連倍率 4×：bet 10 → payout 40。
const ALWAYS_CHERRY = (): number => 0;

/** 不觸發、不派彩的 jackpot 樁（觸發/派彩路徑由 slot.service / jackpot.service 單元測試覆蓋） */
const STUB_JACKPOT = {
  accumulate: async (): Promise<number> => 0,
  tryTriggerJackpot: (): boolean => false,
  payout: async (): Promise<null> => null,
};

async function buildApp(db: E2EDb, redis: ReturnType<typeof createE2ERedis>) {
  const slotService = createSlotService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
    jackpot: STUB_JACKPOT,
    rng: ALWAYS_CHERRY,
    log: { warn: () => {}, error: () => {} },
  });

  return buildE2EApp({
    prisma: db.prisma,
    redis: redis.redis,
    registerRoutes: async (app) => {
      await app.register(slotRoutes, { prefix: '/api/slot', service: slotService });
    },
  });
}

describe('Slot 全流程 E2E：註冊 → 登入 → 簽章 spin', () => {
  let app: FastifyInstance | null = null;
  let db: E2EDb;
  let session: Session;

  beforeEach(async () => {
    db = createE2EDb();
    const redis = createE2ERedis();
    app = await buildApp(db, redis);
    session = await registerAndLogin(app, 'alice_e2e');
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('簽章合法 → 200，餘額 5000→5030，BetRecord 與 BalanceTransaction 落庫', async () => {
    const packet = signSlotSpin(session, { betAmount: 10, nonce: randomUUID(), seq: 1 });
    const res = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: spinHeaders(session, packet),
      payload: { betAmount: 10 },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      betAmount: 10,
      reels: ['CHERRY', 'CHERRY', 'CHERRY'],
      payout: 40,
      newBalance: '5030',
    });

    // 餘額鐵律：BetRecord + 兩筆 BalanceTransaction（BET -10 / PAYOUT +40）
    expect(db.betRecords).toHaveLength(1);
    expect(db.betRecords[0]).toMatchObject({ userId: session.userId, gameType: 'SLOT' });
    const deltas = db.balanceTxs
      .filter((t) => t.userId === session.userId)
      .map((t) => `${t.type}:${t.delta.toString()}`);
    expect(deltas).toContain('BET:-10');
    expect(deltas).toContain('PAYOUT:40');
    expect(db.users.find((u) => u.id === session.userId)!.balance).toBe(5_030n);
  });

  it('重放同一封包（相同 sig/nonce/seq）→ 400 ERR_NONCE_REPLAY + IllegalPacketLog(NONCE_REPLAY)，餘額不再變動', async () => {
    const packet = signSlotSpin(session, { betAmount: 10, nonce: randomUUID(), seq: 1 });

    const first = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: spinHeaders(session, packet),
      payload: { betAmount: 10 },
    });
    expect(first.statusCode).toBe(200);
    const balanceAfterFirst = db.users.find((u) => u.id === session.userId)!.balance;

    // 完全相同的封包再送一次（模擬攔截重放）
    const replay = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: spinHeaders(session, packet),
      payload: { betAmount: 10 },
    });

    expect(replay.statusCode).toBe(400);
    expect(replay.json()).toMatchObject({ error: { code: 'ERR_NONCE_REPLAY' } });
    // 重放不得二次扣款 / 再記一筆下注
    expect(db.users.find((u) => u.id === session.userId)!.balance).toBe(balanceAfterFirst);
    expect(db.betRecords).toHaveLength(1);

    await flushAsync(); // IllegalPacketLog 為 fire-and-forget
    const violations = db.illegalPacketLogs.filter((l) => l.userId === session.userId);
    expect(violations.some((l) => l.violation === 'NONCE_REPLAY')).toBe(true);
    expect(violations.find((l) => l.violation === 'NONCE_REPLAY')!.endpoint).toBe(
      'POST /api/slot/spin',
    );
  });

  it('Seq 倒退（新 nonce、較小 seq）→ 400 ERR_SEQ_REGRESSION + IllegalPacketLog(SEQ_REGRESSION)', async () => {
    // 先以 seq=5 推進序號水位
    const high = signSlotSpin(session, { betAmount: 10, nonce: randomUUID(), seq: 5 });
    const ok = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: spinHeaders(session, high),
      payload: { betAmount: 10 },
    });
    expect(ok.statusCode).toBe(200);

    // 再以「全新 nonce」（避免被 nonce 防線先攔）但 seq=3（倒退）
    const lower = signSlotSpin(session, { betAmount: 10, nonce: randomUUID(), seq: 3 });
    const res = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: spinHeaders(session, lower),
      payload: { betAmount: 10 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ERR_SEQ_REGRESSION' } });

    await flushAsync();
    expect(
      db.illegalPacketLogs.some(
        (l) => l.userId === session.userId && l.violation === 'SEQ_REGRESSION',
      ),
    ).toBe(true);
  });

  it('簽章竄改（改 betAmount 不重簽）→ 400 ERR_BAD_SIGNATURE + IllegalPacketLog(BAD_SIGNATURE)', async () => {
    // 對 betAmount=10 簽章，但送出 betAmount=100（合法 literal）——伺服器以 100 重組 canonical → 簽章不符
    const signedFor10 = signSlotSpin(session, { betAmount: 10, nonce: randomUUID(), seq: 1 });
    const res = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: spinHeaders(session, signedFor10),
      payload: { betAmount: 100 }, // 竄改注額
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ERR_BAD_SIGNATURE' } });
    // 竄改封包不得進入 handler：無扣款、無下注紀錄
    expect(db.betRecords).toHaveLength(0);

    await flushAsync();
    expect(
      db.illegalPacketLogs.some(
        (l) => l.userId === session.userId && l.violation === 'BAD_SIGNATURE',
      ),
    ).toBe(true);
  });

  it('缺少簽章標頭 → 400 ERR_BAD_SIGNATURE（封包不進 handler）', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      headers: { authorization: `Bearer ${session.accessToken}` }, // 無 x-sig/x-nonce/x-ts/x-seq
      payload: { betAmount: 10 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'ERR_BAD_SIGNATURE' } });
    expect(db.betRecords).toHaveLength(0);
  });

  it('未帶 JWT → 401 UNAUTHORIZED（hmac-guard 先驗身份）', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/slot/spin',
      payload: { betAmount: 10 },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });
});
