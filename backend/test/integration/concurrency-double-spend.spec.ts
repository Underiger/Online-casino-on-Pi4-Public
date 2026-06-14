/**
 * M27 併發競態：雙花（double-spend）防護。
 *
 * 兩道防線各一組測試：
 *   1. HTTP 重放競態：同一張「合法簽章封包」併發送兩次 → 只有一次成功，
 *      另一次被 nonce 防線擋下（ERR_NONCE_REPLAY）。餘額只扣一次、僅一筆 BetRecord。
 *   2. 餘額鐵律（條件更新原子性）：餘額僅夠一注時併發扣款兩次 → 一成功一失敗
 *      （INSUFFICIENT_BALANCE），最終餘額一致、僅一筆 BalanceTransaction。
 *      （e2e-fakes 的 $transaction 以 mutex 模擬 PG 列鎖序列化，結果與真 DB 一致。）
 *
 * 環境假設：無需 PG / Redis（e2e-fakes in-memory）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import slotRoutes from '../../src/modules/slot/slot.routes.js';
import { createSlotService } from '../../src/modules/slot/slot.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { InsufficientBalanceError } from '../../src/shared/errors.js';
import { createE2EDb, createE2ERedis, type E2EDb } from '../helpers/e2e-fakes.js';
import {
  buildE2EApp,
  registerAndLogin,
  signSlotSpin,
  spinHeaders,
  type Session,
} from '../helpers/e2e-app.js';

const ALWAYS_CHERRY = (): number => 0; // CHERRY 三連，bet 10 → payout 40
const STUB_JACKPOT = {
  accumulate: async (): Promise<number> => 0,
  tryTriggerJackpot: (): boolean => false,
  payout: async (): Promise<null> => null,
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. HTTP 重放競態（slot spin）
// ═══════════════════════════════════════════════════════════════════════════

describe('雙花防護｜HTTP 重放競態：同一簽章封包併發送兩次', () => {
  let app: FastifyInstance | null = null;
  let db: E2EDb;
  let session: Session;

  beforeEach(async () => {
    db = createE2EDb();
    const redis = createE2ERedis();
    const slotService = createSlotService({
      prisma: db.prisma,
      redis: redis.redis,
      wallet: createWalletService(db.prisma),
      jackpot: STUB_JACKPOT,
      rng: ALWAYS_CHERRY,
      log: { warn: () => {}, error: () => {} },
    });
    app = await buildE2EApp({
      prisma: db.prisma,
      redis: redis.redis,
      registerRoutes: async (instance) => {
        await instance.register(slotRoutes, { prefix: '/api/slot', service: slotService });
      },
    });
    session = await registerAndLogin(app, 'racer_http');
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('併發兩次相同封包 → 恰一次 200、一次 400 ERR_NONCE_REPLAY；餘額只扣一次、僅一筆 BetRecord', async () => {
    const packet = signSlotSpin(session, { betAmount: 10, nonce: randomUUID(), seq: 1 });
    const headers = spinHeaders(session, packet);
    const payload = { betAmount: 10 };

    const [a, b] = await Promise.all([
      app!.inject({ method: 'POST', url: '/api/slot/spin', headers, payload }),
      app!.inject({ method: 'POST', url: '/api/slot/spin', headers, payload }),
    ]);

    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 400]);

    const rejected = [a, b].find((r) => r.statusCode === 400)!;
    expect(rejected.json()).toMatchObject({ error: { code: 'ERR_NONCE_REPLAY' } });

    // 只成功一次：餘額 5000 - 10 + 40 = 5030；僅一筆 BetRecord
    expect(db.users.find((u) => u.id === session.userId)!.balance).toBe(5_030n);
    expect(db.betRecords).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 餘額鐵律：條件更新原子性（wallet 併發扣款）
// ═══════════════════════════════════════════════════════════════════════════

describe('雙花防護｜餘額鐵律：併發扣款的條件更新原子性', () => {
  it('餘額僅夠一注時併發扣兩次 → 一成功一失敗(INSUFFICIENT_BALANCE)，最終餘額 0、僅一筆 tx', async () => {
    const db = createE2EDb({ users: [{ username: 'racer_a', balance: 10n }] });
    const wallet = createWalletService(db.prisma);
    const userId = db.users[0]!.id;

    const results = await Promise.allSettled([
      wallet.debit(userId, 10n, 'BET'),
      wallet.debit(userId, 10n, 'BET'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientBalanceError);

    // 只扣一次：餘額 0；帳本僅一筆（失敗的交易完整回滾，零落帳）
    expect(db.users[0]!.balance).toBe(0n);
    expect(db.balanceTxs).toHaveLength(1);
    expect(db.balanceTxs[0]!.delta).toBe(-10n);
  });

  it('餘額足夠兩注時併發扣兩次 → 皆成功，餘額正確、兩筆 tx（無誤殺）', async () => {
    const db = createE2EDb({ users: [{ username: 'racer_b', balance: 100n }] });
    const wallet = createWalletService(db.prisma);
    const userId = db.users[0]!.id;

    const results = await Promise.allSettled([
      wallet.debit(userId, 30n, 'BET'),
      wallet.debit(userId, 30n, 'BET'),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(db.users[0]!.balance).toBe(40n); // 100 - 30 - 30
    expect(db.balanceTxs).toHaveLength(2);
    // 帳本連續性：兩筆 before/after 不重疊、淨變動 -60
    const sumDelta = db.balanceTxs.reduce((acc, t) => acc + t.delta, 0n);
    expect(sumDelta).toBe(-60n);
  });
});
