/**
 * Charm 服務單元測試（M13 DoD）。
 *
 * 驗證：
 *   - getInventory: 回傳玩家護符清單
 *   - equip: 裝備、槽位替換、跨槽移動、所有權驗證
 *   - unequip: 卸下護符、空槽靜默成功
 *   - recompileAndCache: Redis 快取寫入正確；Redis 故障不影響裝備結果
 *
 * fake prisma 交易語義：深拷貝快照 + 拋錯還原 = 回滾。
 */
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { createCharmService } from '../../src/modules/charm/charm.service.js';
import { ForbiddenError, NotFoundError } from '../../src/shared/errors.js';
import {
  SLOT_LOADOUT_KEY_PREFIX,
  SLOT_LOADOUT_TTL_SECONDS,
} from '../../src/modules/slot/slot.service.js';

// ═════════════════ fake 型別 ═════════════════

interface FakeUserCharm {
  id: string;
  userId: string;
  charmId: string;
  equipped: boolean;
  slot: number | null;
  obtainedAt: Date;
}

interface FakeCharm {
  id: string;
  code: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  effect: unknown;
  enabled: boolean;
}

// ═════════════════ fake prisma ═════════════════

function createFakeCharmPrisma(
  initialUserCharms: FakeUserCharm[],
  charms: FakeCharm[],
) {
  let userCharms = initialUserCharms.map((u) => ({ ...u }));

  function findCharm(id: string): FakeCharm {
    const c = charms.find((ch) => ch.id === id);
    if (!c) throw new Error(`Charm ${id} not found in fakes`);
    return c;
  }

  function buildRow(uc: FakeUserCharm) {
    return { ...uc, charm: findCharm(uc.charmId) };
  }

  const client = {
    userCharm: {
      async findUnique({ where }: { where: { id: string }; select?: unknown }) {
        const uc = userCharms.find((u) => u.id === where.id);
        return uc ? buildRow(uc) : null;
      },

      async findMany({
        where,
        orderBy,
      }: {
        where: {
          userId?: string;
          equipped?: boolean;
          charm?: { enabled?: boolean };
        };
        select?: unknown;
        include?: unknown;
        orderBy?: unknown;
      }) {
        let filtered = [...userCharms];
        if (where.userId !== undefined)
          filtered = filtered.filter((u) => u.userId === where.userId);
        if (where.equipped !== undefined)
          filtered = filtered.filter((u) => u.equipped === where.equipped);
        if (where.charm?.enabled !== undefined) {
          filtered = filtered.filter(
            (u) => findCharm(u.charmId).enabled === where.charm?.enabled,
          );
        }
        // Sort by slot asc (nulls last)
        filtered.sort((a, b) => (a.slot ?? 999) - (b.slot ?? 999));
        return filtered.map(buildRow);
      },

      async updateMany({
        where,
        data,
      }: {
        where: { userId?: string; slot?: number | null; equipped?: boolean };
        data: { equipped?: boolean; slot?: number | null };
      }) {
        const matched = userCharms.filter((u) => {
          if (where.userId !== undefined && u.userId !== where.userId)
            return false;
          if (where.slot !== undefined && u.slot !== where.slot) return false;
          if (where.equipped !== undefined && u.equipped !== where.equipped)
            return false;
          return true;
        });
        for (const u of matched) {
          if (data.equipped !== undefined) u.equipped = data.equipped;
          if ('slot' in data) u.slot = data.slot ?? null;
        }
        return { count: matched.length };
      },

      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: { equipped?: boolean; slot?: number | null };
      }) {
        const uc = userCharms.find((u) => u.id === where.id);
        if (!uc) throw new Error('P2025: record not found');
        if (data.equipped !== undefined) uc.equipped = data.equipped;
        if ('slot' in data) uc.slot = data.slot ?? null;
        return buildRow(uc);
      },
    },

    async $transaction<T>(fn: (tx: typeof client) => Promise<T>): Promise<T> {
      const snapshot = userCharms.map((u) => ({ ...u }));
      try {
        return await fn(client);
      } catch (err) {
        userCharms.splice(0, userCharms.length, ...snapshot);
        throw err;
      }
    },
  };

  return {
    prisma: client as unknown as PrismaClient,
    userCharms,
  };
}

// ═════════════════ fake redis ═════════════════

function createFakeRedis(failOnSet = false) {
  const store = new Map<string, string>();
  const client = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
      if (failOnSet) throw new Error('redis set unavailable (injected)');
      store.set(key, value);
      return 'OK';
    },
  };
  return { redis: client as unknown as Redis, store };
}

// ═════════════════ 測試資料 ═════════════════

const USER_A = 'user_a';
const USER_B = 'user_b';

const CHARM_WEIGHT: FakeCharm = {
  id: 'charm_1',
  code: 'CHERRY_WEIGHT',
  name: '幸運蘋果',
  description: 'CHERRY 出現率 +30%',
  type: 'WEIGHT',
  rarity: 'COMMON',
  effect: { symbol: 'CHERRY', reels: [1, 2, 3], multiplier: 1.3 },
  enabled: true,
};

const CHARM_PITY: FakeCharm = {
  id: 'charm_2',
  code: 'PITY_SHIELD',
  name: '保底護盾',
  description: '10 次未中必觸發保底',
  type: 'PITY',
  rarity: 'RARE',
  effect: { threshold: 10, bonus: 0.5 },
  enabled: true,
};

const CHARM_DISABLED: FakeCharm = {
  id: 'charm_3',
  code: 'DISABLED',
  name: '已停用護符',
  description: '',
  type: 'WEIGHT',
  rarity: 'COMMON',
  effect: { symbol: 'CHERRY', reels: [1], multiplier: 2.0 },
  enabled: false,
};

const ALL_CHARMS = [CHARM_WEIGHT, CHARM_PITY, CHARM_DISABLED];

// ═════════════════ tests ═════════════════

describe('charmService.getInventory', () => {
  it('回傳該使用者所有護符', async () => {
    const { prisma } = createFakeCharmPrisma(
      [
        { id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: false, slot: null, obtainedAt: new Date() },
        { id: 'uc2', userId: USER_A, charmId: CHARM_PITY.id, equipped: true, slot: 1, obtainedAt: new Date() },
        { id: 'uc3', userId: USER_B, charmId: CHARM_WEIGHT.id, equipped: false, slot: null, obtainedAt: new Date() },
      ],
      ALL_CHARMS,
    );
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    const result = await service.getInventory(USER_A);

    expect(result.items).toHaveLength(2);
    expect(result.items.every((i) => i.charm)).toBe(true);
    const equipped = result.items.find((i) => i.equipped);
    expect(equipped?.slot).toBe(1);
  });
});

describe('charmService.equip', () => {
  it('裝備護符到空槽位，Redis 快取更新', async () => {
    const { prisma, userCharms } = createFakeCharmPrisma(
      [{ id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: false, slot: null, obtainedAt: new Date() }],
      ALL_CHARMS,
    );
    const { redis, store } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    const result = await service.equip(USER_A, 'uc1', 1);

    // 護符應已裝備在槽位 1
    expect(userCharms.find((u) => u.id === 'uc1')?.equipped).toBe(true);
    expect(userCharms.find((u) => u.id === 'uc1')?.slot).toBe(1);

    // 回傳 loadout 應包含此護符
    expect(result.equippedCharms).toHaveLength(1);
    expect(result.equippedCharms[0]?.slot).toBe(1);
    expect(result.loadoutHash).toBeTruthy();

    // Redis 應有 loadout 快取
    expect(store.has(`${SLOT_LOADOUT_KEY_PREFIX}${USER_A}`)).toBe(true);
  });

  it('裝備到已有護符的槽位：舊護符自動卸下', async () => {
    const { prisma, userCharms } = createFakeCharmPrisma(
      [
        { id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: true, slot: 1, obtainedAt: new Date() },
        { id: 'uc2', userId: USER_A, charmId: CHARM_PITY.id, equipped: false, slot: null, obtainedAt: new Date() },
      ],
      ALL_CHARMS,
    );
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    await service.equip(USER_A, 'uc2', 1);

    const uc1 = userCharms.find((u) => u.id === 'uc1')!;
    const uc2 = userCharms.find((u) => u.id === 'uc2')!;
    expect(uc1.equipped).toBe(false);
    expect(uc1.slot).toBeNull();
    expect(uc2.equipped).toBe(true);
    expect(uc2.slot).toBe(1);
  });

  it('從槽位 1 移動到槽位 2（跨槽移動）', async () => {
    const { prisma, userCharms } = createFakeCharmPrisma(
      [{ id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: true, slot: 1, obtainedAt: new Date() }],
      ALL_CHARMS,
    );
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    await service.equip(USER_A, 'uc1', 2);

    const uc1 = userCharms.find((u) => u.id === 'uc1')!;
    expect(uc1.slot).toBe(2);
    expect(uc1.equipped).toBe(true);
  });

  it('護符不存在 → NotFoundError', async () => {
    const { prisma } = createFakeCharmPrisma([], ALL_CHARMS);
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    await expect(service.equip(USER_A, 'nonexistent', 1)).rejects.toThrow(
      NotFoundError,
    );
  });

  it('裝備他人護符 → ForbiddenError', async () => {
    const { prisma } = createFakeCharmPrisma(
      [{ id: 'uc1', userId: USER_B, charmId: CHARM_WEIGHT.id, equipped: false, slot: null, obtainedAt: new Date() }],
      ALL_CHARMS,
    );
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    await expect(service.equip(USER_A, 'uc1', 1)).rejects.toThrow(ForbiddenError);
  });

  it('Redis 寫回失敗：服務仍成功（容錯）', async () => {
    const { prisma } = createFakeCharmPrisma(
      [{ id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: false, slot: null, obtainedAt: new Date() }],
      ALL_CHARMS,
    );
    const { redis } = createFakeRedis(true); // failOnSet = true
    const warnings: unknown[] = [];
    const service = createCharmService({
      prisma,
      redis,
      log: { warn: (obj) => warnings.push(obj) },
    });

    const result = await service.equip(USER_A, 'uc1', 1);

    expect(result.loadoutHash).toBeTruthy();
    expect(warnings).toHaveLength(1); // 應有警告
  });
});

describe('charmService.unequip', () => {
  it('卸下已裝備護符', async () => {
    const { prisma, userCharms } = createFakeCharmPrisma(
      [{ id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: true, slot: 1, obtainedAt: new Date() }],
      ALL_CHARMS,
    );
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    const result = await service.unequip(USER_A, 1);

    const uc1 = userCharms.find((u) => u.id === 'uc1')!;
    expect(uc1.equipped).toBe(false);
    expect(uc1.slot).toBeNull();
    expect(result.equippedCharms).toHaveLength(0);
  });

  it('空槽位卸下 → 靜默成功', async () => {
    const { prisma } = createFakeCharmPrisma([], ALL_CHARMS);
    const { redis } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    await expect(service.unequip(USER_A, 2)).resolves.toMatchObject({
      equippedCharms: [],
    });
  });
});

describe('charmService.recompileAndCache', () => {
  it('已裝備護符的 loadout 寫入 Redis；disabled 護符不進 loadout', async () => {
    const { prisma } = createFakeCharmPrisma(
      [
        { id: 'uc1', userId: USER_A, charmId: CHARM_WEIGHT.id, equipped: true, slot: 1, obtainedAt: new Date() },
        // disabled charm 裝備了，但 recompile 時被濾除
        { id: 'uc2', userId: USER_A, charmId: CHARM_DISABLED.id, equipped: true, slot: 2, obtainedAt: new Date() },
      ],
      ALL_CHARMS,
    );
    const { redis, store } = createFakeRedis();
    const service = createCharmService({ prisma, redis });

    const result = await service.equip(USER_A, 'uc1', 1); // triggers recompileAndCache

    const cacheKey = `${SLOT_LOADOUT_KEY_PREFIX}${USER_A}`;
    expect(store.has(cacheKey)).toBe(true);
    const cached = JSON.parse(store.get(cacheKey)!) as { loadout: { loadoutHash: string }; charmCodes: string[] };
    // 只有 enabled 護符（CHERRY_WEIGHT）進入 loadout；disabled 不進
    expect(cached.charmCodes).toContain('CHERRY_WEIGHT');
    expect(cached.charmCodes).not.toContain('DISABLED');
    expect(result.loadoutHash).toBe(cached.loadout.loadoutHash);
  });
});
