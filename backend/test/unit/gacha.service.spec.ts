/**
 * 扭蛋機（Gacha）服務單元測試。
 *
 * 驗證：
 *   - pull 單抽：扣款、授予新護符、回傳餘額
 *   - pull 重複：已擁有 → 不重複授予、退幣（重複轉換）
 *   - pull 十連：回傳 10 筆、扣十連價、保底 ≥1 張 RARE+
 *   - pull 同批次重複：同一護符在一批中只授予一次，其餘退幣
 *   - pull 餘額不足：debit 拋錯 → 整筆回滾、未授予任何護符
 *   - pull 次數非法 → ValidationError
 *   - getCatalog：池 + owned 標記 + 機率/回饋
 *
 * rng 注入：恆回傳 0 → 稀有度抽樣恆取候選第一個（COMMON），保底時取 RARE；
 *           池內抽樣 rng(len)=0 → 取該稀有度第一枚。行為完全可預測。
 */
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { createGachaService } from '../../src/modules/gacha/gacha.service.js';
import { InsufficientBalanceError, ValidationError } from '../../src/shared/errors.js';
import {
  GACHA_SINGLE_COST,
  GACHA_TEN_COST,
  GACHA_TEN_PULL_COUNT,
  GACHA_DUPLICATE_REFUND,
} from '../../src/config/constants.js';

// ═════════════════ fakes ═════════════════

interface FakeCharm {
  id: string;
  code: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  enabled: boolean;
}

const CHARMS: FakeCharm[] = [
  { id: 'c_common_1', code: 'COMMON_1', name: '普通一', description: '', type: 'WEIGHT', rarity: 'COMMON', enabled: true },
  { id: 'c_common_2', code: 'COMMON_2', name: '普通二', description: '', type: 'WEIGHT', rarity: 'COMMON', enabled: true },
  { id: 'c_rare_1', code: 'RARE_1', name: '稀有一', description: '', type: 'PITY', rarity: 'RARE', enabled: true },
  { id: 'c_epic_1', code: 'EPIC_1', name: '史詩一', description: '', type: 'RULE', rarity: 'EPIC', enabled: true },
  { id: 'c_legend_1', code: 'LEGEND_1', name: '傳說一', description: '', type: 'BONUS', rarity: 'LEGENDARY', enabled: true },
  { id: 'c_disabled', code: 'DISABLED', name: '停用', description: '', type: 'WEIGHT', rarity: 'COMMON', enabled: false },
];

const USER = 'user_a';

function createFakePrisma(charms: FakeCharm[], initialOwned: string[]) {
  let userCharms = initialOwned.map((charmId) => ({ userId: USER, charmId }));

  const client = {
    charm: {
      async findMany({ where }: { where: { enabled?: boolean }; select?: unknown; orderBy?: unknown }) {
        return charms
          .filter((c) => where.enabled === undefined || c.enabled === where.enabled)
          .map((c) => ({
            id: c.id,
            code: c.code,
            name: c.name,
            description: c.description,
            type: c.type,
            rarity: c.rarity,
          }));
      },
    },
    userCharm: {
      async findMany({ where }: { where: { userId: string }; select?: unknown }) {
        return userCharms.filter((u) => u.userId === where.userId).map((u) => ({ charmId: u.charmId }));
      },
      async upsert({
        where,
        create,
      }: {
        where: { userId_charmId: { userId: string; charmId: string } };
        create: { userId: string; charmId: string };
        update: unknown;
      }) {
        const exists = userCharms.some(
          (u) => u.userId === where.userId_charmId.userId && u.charmId === where.userId_charmId.charmId,
        );
        if (!exists) userCharms.push({ userId: create.userId, charmId: create.charmId });
        return { userId: create.userId, charmId: create.charmId };
      },
    },
    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      const snapshot = userCharms.map((u) => ({ ...u }));
      try {
        return await fn(client);
      } catch (err) {
        userCharms = snapshot;
        throw err;
      }
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    get owned() {
      return userCharms.map((u) => u.charmId);
    },
  };
}

/** fake wallet：條件扣款（不足拋 422，不扣帳）+ 入帳，皆回傳最新餘額 */
function createFakeWallet(initialBalance: number) {
  let balance = BigInt(initialBalance);
  return {
    wallet: {
      async debit(_userId: string, amount: bigint) {
        if (balance < amount) throw new InsufficientBalanceError();
        balance -= amount;
        return { balance, version: 1, transactionId: 'tx_debit' };
      },
      async credit(_userId: string, amount: bigint) {
        balance += amount;
        return { balance, version: 2, transactionId: 'tx_credit' };
      },
    },
    get balance() {
      return balance;
    },
  };
}

const ZERO_RNG = (): number => 0;

// ═════════════════ tests ═════════════════

describe('gachaService.pull — 單抽', () => {
  it('抽到新護符：扣款、授予、回傳餘額', async () => {
    const db = createFakePrisma(CHARMS, []);
    const w = createFakeWallet(10_000);
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    const res = await service.pull(USER, 1);

    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.isNew).toBe(true);
    expect(res.results[0]?.rarity).toBe('COMMON'); // ZERO_RNG → 第一個稀有度
    expect(res.cost).toBe(String(GACHA_SINGLE_COST));
    expect(res.totalRefund).toBe('0');
    expect(res.grantedNew).toBe(true);
    expect(res.newBalance).toBe(String(10_000 - GACHA_SINGLE_COST));
    expect(db.owned).toContain('c_common_1');
  });

  it('抽到已擁有護符：不重複授予，退幣（重複轉換）', async () => {
    const db = createFakePrisma(CHARMS, ['c_common_1']); // 已擁有第一枚 COMMON
    const w = createFakeWallet(10_000);
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    const res = await service.pull(USER, 1);

    expect(res.results[0]?.isNew).toBe(false);
    expect(res.results[0]?.refund).toBe(String(GACHA_DUPLICATE_REFUND.COMMON));
    expect(res.grantedNew).toBe(false);
    expect(res.totalRefund).toBe(String(GACHA_DUPLICATE_REFUND.COMMON));
    // 餘額 = 起始 - 單抽價 + 重複回饋
    expect(res.newBalance).toBe(String(10_000 - GACHA_SINGLE_COST + GACHA_DUPLICATE_REFUND.COMMON));
    // 擁有數不變（仍只有 1 枚）
    expect(db.owned).toEqual(['c_common_1']);
  });

  it('餘額不足：debit 拋 422，未授予任何護符', async () => {
    const db = createFakePrisma(CHARMS, []);
    const w = createFakeWallet(100); // 不足單抽 500
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    await expect(service.pull(USER, 1)).rejects.toThrow(InsufficientBalanceError);
    expect(db.owned).toHaveLength(0);
    expect(w.balance).toBe(100n); // 餘額未動
  });

  it('次數非法 → ValidationError', async () => {
    const db = createFakePrisma(CHARMS, []);
    const w = createFakeWallet(10_000);
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    await expect(service.pull(USER, 3)).rejects.toThrow(ValidationError);
  });
});

describe('gachaService.pull — 十連', () => {
  it('回傳 10 筆、扣十連價、保底至少一張 RARE+', async () => {
    const db = createFakePrisma(CHARMS, []);
    const w = createFakeWallet(100_000);
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    const res = await service.pull(USER, GACHA_TEN_PULL_COUNT);

    expect(res.results).toHaveLength(GACHA_TEN_PULL_COUNT);
    expect(res.cost).toBe(String(GACHA_TEN_COST));
    // ZERO_RNG → 前 9 抽 COMMON、保底把第 10 抽改成 RARE
    const floorPlus = res.results.filter((r) => ['RARE', 'EPIC', 'LEGENDARY'].includes(r.rarity));
    expect(floorPlus.length).toBeGreaterThanOrEqual(1);
    expect(res.results[GACHA_TEN_PULL_COUNT - 1]?.rarity).toBe('RARE');
  });

  it('同批次重複：同一護符只授予一次，其餘退幣', async () => {
    const db = createFakePrisma(CHARMS, []);
    const w = createFakeWallet(100_000);
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    const res = await service.pull(USER, GACHA_TEN_PULL_COUNT);

    // 前 9 抽都是同一枚 COMMON（c_common_1）：第 1 抽 new，其餘 8 抽 dup；第 10 抽 RARE new
    const newOnes = res.results.filter((r) => r.isNew);
    const dupOnes = res.results.filter((r) => !r.isNew);
    expect(newOnes).toHaveLength(2); // c_common_1 + c_rare_1
    expect(dupOnes).toHaveLength(8);
    // 擁有集合去重後僅 2 枚
    expect(new Set(db.owned).size).toBe(2);
    expect(res.totalRefund).toBe(String(GACHA_DUPLICATE_REFUND.COMMON * 8));
  });
});

describe('gachaService.getCatalog', () => {
  it('回傳啟用護符池（排除 disabled）+ owned 標記 + 機率/回饋', async () => {
    const db = createFakePrisma(CHARMS, ['c_rare_1']);
    const w = createFakeWallet(10_000);
    const service = createGachaService({ prisma: db.prisma, wallet: w.wallet, rng: ZERO_RNG });

    const cat = await service.getCatalog(USER);

    // 5 枚啟用（排除 1 枚 disabled）
    expect(cat.totalCount).toBe(5);
    expect(cat.pool.some((p) => p.code === 'DISABLED')).toBe(false);
    expect(cat.ownedCount).toBe(1);
    expect(cat.pool.find((p) => p.id === 'c_rare_1')?.owned).toBe(true);
    // 4 種稀有度都在池中 → 4 筆 rarity info，機率加總 100
    expect(cat.rarities).toHaveLength(4);
    const sum = cat.rarities.reduce((s, r) => s + Number(r.rate), 0);
    expect(sum).toBeCloseTo(100, 1);
    expect(cat.singleCost).toBe(GACHA_SINGLE_COST);
    expect(cat.tenCost).toBe(GACHA_TEN_COST);
  });
});
