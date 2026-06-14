/**
 * M27 併發競態：Jackpot 派彩樂觀鎖。
 *
 * 驗證「確保不會超額支付」的核心不變量——資金守恆：
 *     Σ(各次派彩額) + 最終池量 === 初始池量
 * 在多玩家「同時觸發派彩」下仍嚴格成立（每次派彩 remained = poolBefore − payout，
 * 樂觀鎖 WHERE version 序列化所有條件更新，落敗者重試而非重複支付）。
 *
 * 三組測試：
 *   1. 真併發：兩位玩家同時 payout → 皆成功、各入帳一次、守恆成立、無重複支付。
 *   2. 確定性競態（bumpJackpotVersionAfterRead=1）→ 重試一次後成功、金額正確。
 *   3. 重試耗盡（bump≥上限）→ 拋 OptimisticLockError，池量不變、零落帳（不超付）。
 *
 * 環境假設：無需 PG / Redis（e2e-fakes：jackpot 單行表 + mutex 序列化 $transaction，
 * 模擬 PG 列鎖；讀取仍在交易外，樂觀鎖競態照常成立）。
 */
import { describe, expect, it } from 'vitest';
import { createJackpotService } from '../../src/modules/jackpot/jackpot.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { OptimisticLockError } from '../../src/shared/errors.js';
import { createE2EDb } from '../helpers/e2e-fakes.js';

const SILENT = { warn: () => {}, error: () => {} };

function makeService(db: ReturnType<typeof createE2EDb>) {
  return createJackpotService({
    prisma: db.prisma,
    redis: createE2EDbRedis(),
    wallet: createWalletService(db.prisma),
    log: SILENT,
  });
}

// payout 僅用到 redis getset/set/incrby/decrby/get；以最小 fake 提供
function createE2EDbRedis() {
  const store = new Map<string, string>();
  return {
    async get(k: string) {
      return store.get(k) ?? null;
    },
    async set(k: string, v: string) {
      store.set(k, v);
      return 'OK' as const;
    },
    async getset(k: string, v: string) {
      const prev = store.get(k) ?? null;
      store.set(k, v);
      return prev;
    },
    async incrby(k: string, n: number | string) {
      const next = Number(store.get(k) ?? '0') + Number(n);
      store.set(k, String(next));
      return next;
    },
    async decrby(k: string, n: number | string) {
      const next = Number(store.get(k) ?? '0') - Number(n);
      store.set(k, String(next));
      return next;
    },
  } as unknown as Parameters<typeof createJackpotService>[0]['redis'];
}

describe('Jackpot 併發派彩｜樂觀鎖與資金守恆', () => {
  it('兩位玩家同時派彩 → 皆成功、各入帳一次、Σ派彩 + 最終池量 = 初始池量', async () => {
    const INITIAL = 100_000n;
    const db = createE2EDb({
      users: [
        { username: 'jp_winner_1', balance: 5_000n },
        { username: 'jp_winner_2', balance: 5_000n },
      ],
      jackpotPool: INITIAL,
    });
    const jackpot = makeService(db);
    const [u1, u2] = [db.users[0]!.id, db.users[1]!.id];

    const results = await Promise.all([jackpot.payout(u1), jackpot.payout(u2)]);

    // 兩次派彩皆成功（非 null）
    expect(results.every((r) => r !== null)).toBe(true);

    // 每位玩家恰一筆 JackpotHistory（無重複支付），且餘額 = 5000 + 自己那筆派彩
    expect(db.jackpotHistory).toHaveLength(2);
    for (const uid of [u1, u2]) {
      const hist = db.jackpotHistory.filter((h) => h.userId === uid);
      expect(hist).toHaveLength(1);
      expect(db.users.find((u) => u.id === uid)!.balance).toBe(5_000n + hist[0]!.payout);
    }

    // ★ 資金守恆：Σ派彩 + 最終池量 === 初始池量（嚴格相等 → 不可能超額支付）
    const totalPaid = db.jackpotHistory.reduce((acc, h) => acc + h.payout, 0n);
    expect(totalPaid + db.jackpotRow.pool).toBe(INITIAL);
    expect(db.jackpotRow.pool).toBeGreaterThan(0n);
  });

  it('確定性競態（讀後 version 被搶寫一次）→ 重試後成功，派彩金額正確（80%）', async () => {
    const INITIAL = 100_000n;
    const db = createE2EDb({
      users: [{ username: 'jp_retry', balance: 5_000n }],
      jackpotPool: INITIAL,
      bumpJackpotVersionAfterRead: 1, // 第一次條件更新必 STALE，逼出一次重試
    });
    const jackpot = makeService(db);
    const userId = db.users[0]!.id;

    const result = await jackpot.payout(userId);

    expect(result).not.toBeNull();
    expect(result!.payout).toBe(80_000n); // 100000 × 80%
    expect(db.jackpotRow.pool).toBe(20_000n); // remained = 100000 − 80000
    expect(db.jackpotHistory).toHaveLength(1);
    expect(db.users[0]!.balance).toBe(85_000n); // 5000 + 80000，僅入帳一次
  });

  it('重試耗盡（version 連續被搶寫超過上限）→ OptimisticLockError，池量不變、零落帳', async () => {
    const INITIAL = 100_000n;
    const db = createE2EDb({
      users: [{ username: 'jp_exhaust', balance: 5_000n }],
      jackpotPool: INITIAL,
      bumpJackpotVersionAfterRead: 3, // ≥ JACKPOT_PAYOUT_MAX_RETRIES（3）
    });
    const jackpot = makeService(db);
    const userId = db.users[0]!.id;

    await expect(jackpot.payout(userId)).rejects.toBeInstanceOf(OptimisticLockError);

    // 不超付：池量原封不動、無 History、餘額未變
    expect(db.jackpotRow.pool).toBe(INITIAL);
    expect(db.jackpotHistory).toHaveLength(0);
    expect(db.users[0]!.balance).toBe(5_000n);
  });
});
