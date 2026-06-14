/**
 * Charm 服務（05_MILESTONES M13、01_GDD §3.3）。
 *
 * 主要職責：
 *   1. 查詢玩家護符庫存（含裝備狀態）
 *   2. 裝備護符到指定槽位（1–3）：
 *      a. 驗證所有權
 *      b. 單一 $transaction：清空目標槽位 → 裝備指定護符（確保槽位唯一約束不衝突）
 *      c. 重新編譯 CompiledLoadout → 寫入 Redis（TTL 24h）
 *   3. 卸下指定槽位護符：updateMany 清空 → 重編譯 → 寫回 Redis
 *
 * Redis 失敗語義：快取寫回失敗僅記日誌，永不拋錯——
 * spin 路徑的 cache miss 重編譯可自癒。
 */
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { compileLoadout } from '../slot/loadout-compiler.js';
import {
  loadoutCacheKey,
  SLOT_LOADOUT_TTL_SECONDS,
  DAILY_LUCKY_SYMBOL_KEY,
  type CachedLoadout,
} from '../slot/slot.service.js';
import type { EquippedCharm } from '../slot/slot.types.js';
import { SLOT_SYMBOLS } from '../../config/constants.js';
import { ForbiddenError, NotFoundError } from '../../shared/errors.js';

// ─────────────────────────── 型別 ───────────────────────────

type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

export interface InventoryCharm {
  id: string;
  code: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  effect: unknown;
  enabled: boolean;
}

export interface InventoryItem {
  id: string;        // UserCharm.id
  charmId: string;
  equipped: boolean;
  slot: number | null;
  obtainedAt: string;
  charm: InventoryCharm;
}

export interface InventoryResult {
  items: InventoryItem[];
}

export interface EquippedCharmInfo {
  slot: number;
  userCharmId: string;
  charmId: string;
  name: string;
  type: string;
  rarity: string;
}

export interface LoadoutResult {
  equippedCharms: EquippedCharmInfo[];
  loadoutHash: string;
}

export interface CharmLog {
  warn: (obj: unknown, msg?: string) => void;
}

export interface CharmServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  log?: CharmLog;
}

// ─────────────────────────── service ───────────────────────────

export function createCharmService(deps: CharmServiceDeps) {
  const { prisma, redis } = deps;
  const log: CharmLog = deps.log ?? { warn: () => {} };

  // ── 今日幸運符號（與 slot.service 同語義：缺鍵/非法/故障 → null）──
  async function getTodayLuckySymbol(): Promise<SlotSymbol | null> {
    try {
      const raw = await redis.get(DAILY_LUCKY_SYMBOL_KEY);
      return (SLOT_SYMBOLS as readonly string[]).includes(raw ?? '')
        ? (raw as SlotSymbol)
        : null;
    } catch {
      return null;
    }
  }

  /**
   * 重新編譯 CompiledLoadout 並寫入 Redis。
   * 呼叫點：equip / unequip 完成後立即呼叫，確保下一次 spin 拿到最新 loadout。
   */
  async function recompileAndCache(userId: string): Promise<LoadoutResult> {
    const luckySymbol = await getTodayLuckySymbol();

    const rows = await prisma.userCharm.findMany({
      where: { userId, equipped: true, charm: { enabled: true } },
      select: {
        id: true,
        slot: true,
        charmId: true,
        charm: {
          select: {
            id: true,
            code: true,
            name: true,
            type: true,
            rarity: true,
            effect: true,
          },
        },
      },
      orderBy: { slot: 'asc' },
    });

    const charms: EquippedCharm[] = rows.map((row) => ({
      code: row.charm.code,
      type: row.charm.type,
      effect: row.charm.effect,
    }));

    const loadout = compileLoadout({ userId, charms, luckySymbol });

    const cached: CachedLoadout = {
      loadout,
      luckySymbol,
      charmCodes: charms.map((c) => c.code),
    };

    const key = loadoutCacheKey(userId);
    try {
      await redis.set(key, JSON.stringify(cached), 'EX', SLOT_LOADOUT_TTL_SECONDS);
    } catch (err) {
      log.warn({ err: (err as Error).message, userId }, 'charm: loadout 快取寫回失敗');
    }

    return {
      equippedCharms: rows
        .filter((r): r is typeof r & { slot: number } => r.slot !== null)
        .map((r) => ({
          slot: r.slot,
          userCharmId: r.id,
          charmId: r.charm.id,
          name: r.charm.name,
          type: r.charm.type,
          rarity: r.charm.rarity,
        })),
      loadoutHash: loadout.loadoutHash,
    };
  }

  // ─────────────────────────── 公開方法 ───────────────────────────

  /** GET /api/charm/inventory：回傳玩家全部護符（含裝備狀態）。 */
  async function getInventory(userId: string): Promise<InventoryResult> {
    const rows = await prisma.userCharm.findMany({
      where: { userId },
      include: { charm: true },
      orderBy: [{ equipped: 'desc' }, { slot: 'asc' }, { obtainedAt: 'asc' }],
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        charmId: row.charmId,
        equipped: row.equipped,
        slot: row.slot,
        obtainedAt: row.obtainedAt.toISOString(),
        charm: {
          id: row.charm.id,
          code: row.charm.code,
          name: row.charm.name,
          description: row.charm.description,
          type: row.charm.type,
          rarity: row.charm.rarity,
          effect: row.charm.effect,
          enabled: row.charm.enabled,
        },
      })),
    };
  }

  /**
   * POST /api/charm/equip：裝備護符到指定槽位。
   *
   * 交易語義：
   *   Step 1: 清空目標槽位（unequip 任何原有護符）
   *   Step 2: 裝備指定護符到目標槽位
   * 兩步驟必須在同一 $transaction 內，確保 @@unique([userId, slot]) 不會中途衝突。
   */
  async function equip(userId: string, userCharmId: string, slot: number): Promise<LoadoutResult> {
    // 驗證所有權
    const userCharm = await prisma.userCharm.findUnique({
      where: { id: userCharmId },
      select: { userId: true },
    });
    if (userCharm === null) throw new NotFoundError('護符不存在');
    if (userCharm.userId !== userId) throw new ForbiddenError('不可裝備他人護符');

    await prisma.$transaction(async (tx) => {
      // Step 1: 清空目標槽位（可能有其他護符或同一護符）
      await tx.userCharm.updateMany({
        where: { userId, slot, equipped: true },
        data: { equipped: false, slot: null },
      });

      // Step 2: 裝備到目標槽位（原本可能在其他槽位，直接更新即可）
      await tx.userCharm.update({
        where: { id: userCharmId },
        data: { equipped: true, slot },
      });
    });

    return recompileAndCache(userId);
  }

  /**
   * POST /api/charm/unequip：卸下指定槽位的護符。
   * 槽位原本為空時靜默成功（回傳當前 loadout）。
   */
  async function unequip(userId: string, slot: number): Promise<LoadoutResult> {
    await prisma.userCharm.updateMany({
      where: { userId, slot, equipped: true },
      data: { equipped: false, slot: null },
    });

    return recompileAndCache(userId);
  }

  return { getInventory, equip, unequip };
}

export type CharmService = ReturnType<typeof createCharmService>;
