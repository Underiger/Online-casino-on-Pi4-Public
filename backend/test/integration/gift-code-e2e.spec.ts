/**
 * M27 禮物碼全流程 E2E 整合測試。
 *
 * 流程：管理員產生禮物碼（admin.service.createGiftCode，真實 CSPRNG 產碼 + 稽核）
 *       → 玩家經 HTTP POST /api/gift-codes/redeem 兌換（需 JWT）
 *       → 驗證餘額增加、兌換紀錄落庫、重複兌換被拒。
 *
 * 重複兌換的兩種語義（皆須被拒）：
 *   1. 同一玩家重複兌換同一碼（maxUses>1 時）→ GIFT_CODE_ALREADY_REDEEMED
 *      （@@unique([giftCodeId,userId]) P2002）。
 *   2. 碼已用完（maxUses 達上限，另一玩家再兌）→ GIFT_CODE_ALREADY_USED
 *      （條件更新 used_count 競態防護）。
 *
 * 環境假設：無需 PG / Redis（e2e-fakes in-memory）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import giftCodeRoutes from '../../src/modules/gift-code/gift-code.routes.js';
import { createAdminService } from '../../src/modules/admin/admin.service.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { createE2EDb, createE2ERedis, type E2EDb, type FakeCharm } from '../helpers/e2e-fakes.js';
import { buildE2EApp, registerAndLogin } from '../helpers/e2e-app.js';

const ADMIN_ID = 'admin_e2e';
const DAY_MS = 24 * 60 * 60 * 1000;

function futureISO(offsetMs = DAY_MS): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

interface CreateOpts {
  amount?: number;
  maxUses?: number;
  charmId?: string;
  expiresAt?: string;
}

/** 以真實 admin.service 產生一個禮物碼，回傳明文 code */
async function adminCreateGiftCode(db: E2EDb, redis: ReturnType<typeof createE2ERedis>, opts: CreateOpts = {}) {
  const admin = createAdminService({
    prisma: db.prisma,
    redis: redis.redis,
    wallet: createWalletService(db.prisma),
  });
  return admin.createGiftCode(
    ADMIN_ID,
    {
      amount: opts.amount ?? 500,
      maxUses: opts.maxUses ?? 1,
      expiresAt: opts.expiresAt ?? futureISO(),
      ...(opts.charmId !== undefined ? { charmId: opts.charmId } : {}),
    },
    '127.0.0.1',
  );
}

async function redeem(app: FastifyInstance, accessToken: string, code: string) {
  return app.inject({
    method: 'POST',
    url: '/api/gift-codes/redeem',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { code },
  });
}

describe('禮物碼全流程 E2E：管理員產生 → 玩家兌換', () => {
  let app: FastifyInstance | null = null;
  let db: E2EDb;
  let redis: ReturnType<typeof createE2ERedis>;

  beforeEach(async () => {
    db = createE2EDb({
      charms: [
        {
          id: 'charm_clover',
          code: 'CLOVER_CHARM',
          name: '四葉草護符',
          type: 'WEIGHT',
          effect: { symbol: 'CLOVER', reels: [1, 2, 3], multiplier: 1.3 },
          enabled: true,
        } as FakeCharm,
      ],
    });
    redis = createE2ERedis();
    app = await buildE2EApp({
      prisma: db.prisma,
      redis: redis.redis,
      registerRoutes: async (instance) => {
        await instance.register(giftCodeRoutes, { prefix: '/api/gift-codes' });
      },
    });
  });

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('產生 → 兌換：HTTP 200、餘額 +500、兌換紀錄落庫、used_count 遞增', async () => {
    const gift = await adminCreateGiftCode(db, redis, { amount: 500, maxUses: 1 });
    expect(gift.code).toMatch(/^[A-Z0-9]{16}$/); // CSPRNG 大寫去混淆字元集
    expect(db.giftCodes).toHaveLength(1);

    const player = await registerAndLogin(app!, 'redeemer_one');
    const res = await redeem(app!, player.accessToken, gift.code);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      amount: '500',
      newBalance: '5500', // 5000 新手禮包 + 500
    });
    expect(db.users.find((u) => u.id === player.userId)!.balance).toBe(5_500n);
    expect(db.giftCodeRedemptions).toHaveLength(1);
    expect(db.giftCodes[0]!.usedCount).toBe(1);
  });

  it('同一玩家重複兌換同一碼（maxUses=2）→ 409 GIFT_CODE_ALREADY_REDEEMED，餘額僅增一次', async () => {
    const gift = await adminCreateGiftCode(db, redis, { amount: 300, maxUses: 2 });
    const player = await registerAndLogin(app!, 'redeemer_dup');

    const first = await redeem(app!, player.accessToken, gift.code);
    expect(first.statusCode).toBe(200);
    expect(db.users.find((u) => u.id === player.userId)!.balance).toBe(5_300n);

    const second = await redeem(app!, player.accessToken, gift.code);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: 'GIFT_CODE_ALREADY_REDEEMED' } });

    // 餘額僅增一次；交易回滾使 used_count 維持 1（第二次條件更新已回滾）
    expect(db.users.find((u) => u.id === player.userId)!.balance).toBe(5_300n);
    expect(db.giftCodeRedemptions).toHaveLength(1);
    expect(db.giftCodes[0]!.usedCount).toBe(1);
  });

  it('碼已用完（maxUses=1，另一玩家再兌）→ 409 GIFT_CODE_ALREADY_USED', async () => {
    const gift = await adminCreateGiftCode(db, redis, { amount: 250, maxUses: 1 });

    const playerA = await registerAndLogin(app!, 'redeemer_a');
    const playerB = await registerAndLogin(app!, 'redeemer_b');

    const a = await redeem(app!, playerA.accessToken, gift.code);
    expect(a.statusCode).toBe(200);

    const b = await redeem(app!, playerB.accessToken, gift.code);
    expect(b.statusCode).toBe(409);
    expect(b.json()).toMatchObject({ error: { code: 'GIFT_CODE_ALREADY_USED' } });

    // B 餘額未變、無兌換紀錄
    expect(db.users.find((u) => u.id === playerB.userId)!.balance).toBe(5_000n);
    expect(db.giftCodeRedemptions).toHaveLength(1);
  });

  it('附贈護符的禮物碼：兌換後授予護符並回傳護符名稱', async () => {
    const gift = await adminCreateGiftCode(db, redis, {
      amount: 100,
      maxUses: 1,
      charmId: 'charm_clover',
    });
    const player = await registerAndLogin(app!, 'redeemer_charm');

    const res = await redeem(app!, player.accessToken, gift.code);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      charmId: 'charm_clover',
      charmName: '四葉草護符',
    });
    expect(
      db.userCharms.some((c) => c.userId === player.userId && c.charmId === 'charm_clover'),
    ).toBe(true);
  });

  it('不存在的碼 → 404 GIFT_CODE_NOT_FOUND', async () => {
    const player = await registerAndLogin(app!, 'redeemer_none');
    const res = await redeem(app!, player.accessToken, 'NOSUCHCODE000000');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'GIFT_CODE_NOT_FOUND' } });
  });

  it('過期的碼 → 409 GIFT_CODE_EXPIRED', async () => {
    // 直接植入一筆已過期的碼（admin.createGiftCode 不允許產生過去時間）
    db.giftCodes.push({
      id: 'gc_expired',
      code: 'EXPIREDCODE00000',
      amount: 999n,
      charmId: null,
      maxUses: 1,
      usedCount: 0,
      expiresAt: new Date(Date.now() - DAY_MS),
      createdById: ADMIN_ID,
      createdAt: new Date(),
    });
    const player = await registerAndLogin(app!, 'redeemer_expired');
    const res = await redeem(app!, player.accessToken, 'EXPIREDCODE00000');
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'GIFT_CODE_EXPIRED' } });
  });
});
