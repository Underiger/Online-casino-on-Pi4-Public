/**
 * 扭蛋機（Gacha）服務 — 護符抽取管道（01_GDD §3.3 護符獲取）。
 *
 * 主要職責：
 *   1. pull(userId, count)：單抽（count=1）或十連抽（count=10）
 *      a. 取啟用護符池，依稀有度分組
 *      b. 依 GACHA_RARITY_WEIGHTS 加權抽稀有度（十連含 ≥1 張 RARE+ 保底），
 *         再於該稀有度池內均勻抽一枚（CSPRNG）
 *      c. 單一 $transaction：扣款（TxType.GACHA）→ 逐抽授予/判定重複 →
 *         重複轉換回饋入帳（TxType.GACHA）→ 讀回餘額
 *      d. 「一人一符」：抽到已擁有（含同批次先前已抽中）的護符 → 不重複授予，
 *         改退還 GACHA_DUPLICATE_REFUND[rarity] Coin
 *   2. getCatalog(userId)：扭蛋池 + 個人收集狀態 + 機率/回饋（前端展示用）
 *
 * 餘額鐵律：扣款/入帳一律走 wallet 模組；抽取與帳務同一交易，任一步失敗整筆回滾。
 * 併發安全：授予以 upsert（idempotent）執行，新/重複判定以「交易內快照 + 批次內遞增」
 * 的擁有集合為準——即使極端併發雙抽撞同符，也只會 upsert 一次、不拋唯一鍵衝突。
 */
import type { PrismaClient } from '@prisma/client';
import { rngInt } from '../../security/csprng.js';
import {
  CHARM_RARITY_ORDER,
  GACHA_DUPLICATE_REFUND,
  GACHA_RARITY_WEIGHTS,
  GACHA_SINGLE_COST,
  GACHA_TEN_COST,
  GACHA_TEN_PULL_COUNT,
  GACHA_TEN_PULL_FLOOR,
  type CharmRarity,
} from '../../config/constants.js';
import { ValidationError } from '../../shared/errors.js';
import type { WalletService } from '../wallet/wallet.service.js';

// ─────────────────────────── 型別 ───────────────────────────

/** 扭蛋池單一護符（純展示欄位，effect 不外露——展示靠 description） */
interface PoolCharm {
  id: string;
  code: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
}

export interface GachaDraw {
  charmId: string;
  code: string;
  name: string;
  description: string;
  type: string;
  rarity: string;
  /** false = 重複（已擁有），改為退幣 */
  isNew: boolean;
  /** 重複時退還的 Coin（字串；新護符為 "0"） */
  refund: string;
}

export interface GachaPullResult {
  results: GachaDraw[];
  /** 本次花費（字串） */
  cost: string;
  /** 重複轉換回饋總額（字串） */
  totalRefund: string;
  newBalance: string;
  /** 本次是否有抽到新護符（路由據此觸發收集成就） */
  grantedNew: boolean;
}

export interface GachaCatalogItem extends PoolCharm {
  owned: boolean;
}

export interface GachaRarityInfo {
  rarity: CharmRarity;
  /** 抽中機率（百分比字串，如 "60.0"） */
  rate: string;
  /** 重複轉換回饋（Coin 字串） */
  dupRefund: string;
}

export interface GachaCatalogResult {
  singleCost: number;
  tenCost: number;
  tenPullCount: number;
  floorRarity: CharmRarity;
  rarities: GachaRarityInfo[];
  pool: GachaCatalogItem[];
  ownedCount: number;
  totalCount: number;
}

type RngFn = (maxExclusive: number) => number;

export interface GachaServiceDeps {
  prisma: PrismaClient;
  wallet: Pick<WalletService, 'debit' | 'credit'>;
  /** 測試注入（預設 CSPRNG rngInt） */
  rng?: RngFn;
}

// ─────────────────────────── 純函式：抽樣 ───────────────────────────

const POOL_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  type: true,
  rarity: true,
} as const;

function rarityRank(rarity: string): number {
  return CHARM_RARITY_ORDER.indexOf(rarity as CharmRarity);
}

/** 啟用護符依稀有度分組（只保留有護符的稀有度） */
function groupByRarity(charms: PoolCharm[]): Map<CharmRarity, PoolCharm[]> {
  const pools = new Map<CharmRarity, PoolCharm[]>();
  for (const c of charms) {
    if (rarityRank(c.rarity) < 0) continue; // 非預期稀有度值，跳過防呆
    const key = c.rarity as CharmRarity;
    const list = pools.get(key) ?? [];
    list.push(c);
    pools.set(key, list);
  }
  return pools;
}

/** 在給定稀有度集合內依權重抽一個稀有度（權重皆為正整數，rngInt 無模偏差） */
function rollRarity(candidates: readonly CharmRarity[], rng: RngFn): CharmRarity {
  const total = candidates.reduce((sum, r) => sum + GACHA_RARITY_WEIGHTS[r], 0);
  let roll = rng(total);
  for (const r of candidates) {
    roll -= GACHA_RARITY_WEIGHTS[r];
    if (roll < 0) return r;
  }
  return candidates[candidates.length - 1] as CharmRarity; // 浮點不參與，理論不會到這
}

/**
 * 規劃本次抽取的每一枚護符（稀有度加權 + 池內均勻 + 十連保底）。
 * 不碰 DB、不判定重複——純抽樣，便於單元測試。
 */
function planDraws(
  count: number,
  pools: Map<CharmRarity, PoolCharm[]>,
  rng: RngFn,
): PoolCharm[] {
  const available = CHARM_RARITY_ORDER.filter((r) => (pools.get(r)?.length ?? 0) > 0);

  const rarities: CharmRarity[] = [];
  for (let i = 0; i < count; i += 1) {
    rarities.push(rollRarity(available, rng));
  }

  // 十連保底：整批沒有任何 RARE+（且池中確實存在 RARE+）→ 把最後一抽改抽 RARE+
  if (count === GACHA_TEN_PULL_COUNT) {
    const floorRank = rarityRank(GACHA_TEN_PULL_FLOOR);
    const hasFloor = rarities.some((r) => rarityRank(r) >= floorRank);
    const floorCandidates = available.filter((r) => rarityRank(r) >= floorRank);
    if (!hasFloor && floorCandidates.length > 0) {
      rarities[count - 1] = rollRarity(floorCandidates, rng);
    }
  }

  return rarities.map((r) => {
    const pool = pools.get(r) as PoolCharm[]; // available 已保證非空
    return pool[rng(pool.length)] as PoolCharm;
  });
}

// ─────────────────────────── service ───────────────────────────

export function createGachaService(deps: GachaServiceDeps) {
  const { prisma, wallet } = deps;
  const rng: RngFn = deps.rng ?? rngInt;

  async function loadPool(): Promise<PoolCharm[]> {
    return prisma.charm.findMany({ where: { enabled: true }, select: POOL_SELECT });
  }

  /** POST /api/gacha/pull */
  async function pull(userId: string, count: number): Promise<GachaPullResult> {
    if (count !== 1 && count !== GACHA_TEN_PULL_COUNT) {
      throw new ValidationError(`抽取次數僅限 1 或 ${GACHA_TEN_PULL_COUNT}`);
    }
    const cost = count === 1 ? GACHA_SINGLE_COST : GACHA_TEN_COST;

    const pool = await loadPool();
    if (pool.length === 0) {
      // 種子保證 12 枚啟用護符；全數停用屬營運狀態，明確擋下而非靜默扣款
      throw new ValidationError('扭蛋池目前沒有可抽取的護符');
    }

    const pools = groupByRarity(pool);
    const planned = planDraws(count, pools, rng);

    const out = await prisma.$transaction(async (tx) => {
      // 1. 扣款（餘額不足拋 422 → 整筆回滾，未授予任何護符）
      const debit = await wallet.debit(userId, BigInt(cost), 'GACHA', {
        tx,
        memo: count === 1 ? '扭蛋單抽' : `扭蛋十連抽`,
      });
      let balance = debit.balance;

      // 2. 交易內擁有快照（批次內遞增，確保同批次重複抽中只授予一次）
      const owned = await tx.userCharm.findMany({
        where: { userId },
        select: { charmId: true },
      });
      const ownedSet = new Set(owned.map((o) => o.charmId));

      const results: GachaDraw[] = [];
      let totalRefund = 0;
      for (const charm of planned) {
        const isNew = !ownedSet.has(charm.id);
        if (isNew) {
          // upsert（非 create）：併發雙抽撞同符時 idempotent，不拋唯一鍵衝突
          await tx.userCharm.upsert({
            where: { userId_charmId: { userId, charmId: charm.id } },
            create: { userId, charmId: charm.id },
            update: {},
          });
          ownedSet.add(charm.id);
          results.push({ ...toDraw(charm), isNew: true, refund: '0' });
        } else {
          const refund = GACHA_DUPLICATE_REFUND[charm.rarity as CharmRarity] ?? 0;
          totalRefund += refund;
          results.push({ ...toDraw(charm), isNew: false, refund: String(refund) });
        }
      }

      // 3. 重複轉換回饋（與扣款同交易；refId 留空——非單筆下注）
      if (totalRefund > 0) {
        const credit = await wallet.credit(userId, BigInt(totalRefund), 'GACHA', {
          tx,
          memo: '扭蛋重複轉換',
        });
        balance = credit.balance;
      }

      const grantedNew = results.some((r) => r.isNew);
      return { results, totalRefund, balance, grantedNew };
    });

    return {
      results: out.results,
      cost: String(cost),
      totalRefund: String(out.totalRefund),
      newBalance: out.balance.toString(),
      grantedNew: out.grantedNew,
    };
  }

  /** GET /api/gacha/catalog：扭蛋池 + 個人收集狀態 + 機率/回饋。 */
  async function getCatalog(userId: string): Promise<GachaCatalogResult> {
    const [pool, owned] = await Promise.all([
      prisma.charm.findMany({
        where: { enabled: true },
        select: POOL_SELECT,
        orderBy: [{ rarity: 'asc' }, { name: 'asc' }],
      }),
      prisma.userCharm.findMany({ where: { userId }, select: { charmId: true } }),
    ]);
    const ownedSet = new Set(owned.map((o) => o.charmId));

    // 機率依「池中實際存在的稀有度」renormalize（與 planDraws 同口徑）
    const present = CHARM_RARITY_ORDER.filter((r) =>
      pool.some((c) => c.rarity === r),
    );
    const totalWeight = present.reduce((sum, r) => sum + GACHA_RARITY_WEIGHTS[r], 0);
    const rarities: GachaRarityInfo[] = present.map((r) => ({
      rarity: r,
      rate: totalWeight > 0 ? ((GACHA_RARITY_WEIGHTS[r] / totalWeight) * 100).toFixed(1) : '0.0',
      dupRefund: String(GACHA_DUPLICATE_REFUND[r]),
    }));

    const items: GachaCatalogItem[] = pool.map((c) => ({
      ...c,
      owned: ownedSet.has(c.id),
    }));

    return {
      singleCost: GACHA_SINGLE_COST,
      tenCost: GACHA_TEN_COST,
      tenPullCount: GACHA_TEN_PULL_COUNT,
      floorRarity: GACHA_TEN_PULL_FLOOR,
      rarities,
      pool: items,
      ownedCount: items.filter((i) => i.owned).length,
      totalCount: items.length,
    };
  }

  return { pull, getCatalog };
}

function toDraw(charm: PoolCharm): Omit<GachaDraw, 'isNew' | 'refund'> {
  return {
    charmId: charm.id,
    code: charm.code,
    name: charm.name,
    description: charm.description,
    type: charm.type,
    rarity: charm.rarity,
  };
}

export type GachaService = ReturnType<typeof createGachaService>;
