/**
 * Roulette 服務（01_GDD §4、02_TDD §5.3 回合時窗、05_MILESTONES M15）。
 *
 * ── 回合狀態機（setTimeout 驅動，伺服器排程） ──
 *   BETTING(15s) → LOCK(2s，CSPRNG rngInt(37) 產生結果) → RESULT(8s，廣播 + 結算)
 *   → COOLDOWN(5s，下注統計快照) → 新回合，無限循環。
 *   伺服器重啟不恢復舊回合：啟動即開新回合，客戶端由 roulette:phase 同步。
 *
 * ── Cluster 模式（02_TDD §2：Node ×2 workers）──
 *   全服只能有一台狀態機：以 Redis leader lock（SET NX EX + 心跳續期）選主，
 *   僅 leader 跑機器並廣播（io.emit 經 redis adapter 跨 worker 送達全服）；
 *   leader 每次階段轉換把 { roundId, phase, phaseEndsAt } 鏡像到
 *   `roulette:round:current`——非 leader worker 據此驗注、REST /state 據此查詢。
 *   leader 失聯（崩潰）→ 鍵 TTL 過期 → 其他 worker 接手開「新回合」（不接舊局）。
 *   Redis 不可用（開發單機）→ 直接視為本地 leader；無 adapter 時各 worker
 *   只廣播給自己的連線，對單一客戶端仍是一致的回合流。
 *
 * ── 下注一致性（錢與單據） ──
 *   下注 = wallet.debit 即時扣款 + Redis append-only list 記錄事件；順序與補償：
 *     1. HINCRBY 回合累計（原子佔額）→ 超過 5000 上限即 HINCRBY 回退、拒絕
 *     2. wallet.debit → 餘額不足回退佔額、拒絕
 *     3. RPUSH 下注事件 → 寫入失敗立即 wallet.credit(REFUND) 退款、拒絕
 *        （Redis 是結算唯一依據——沒進帳本的注，錢必須原路退回）
 *   取消（BETTING 內）：HINCRBY 負值原子認領 → credit(REFUND) → RPUSH cancel 標記
 *   （結算序列回放：cancel 清空先前累積，取消後再下注照常生效）。
 *   BETTING 截止前 250ms 拒收新注（再加 LOCK 2s 緩衝），杜絕「扣了款卻趕不上
 *   結算讀取」的競態。
 *
 * ── 結算（單一 PG 交易，02_TDD §4 批量結算） ──
 *   RESULT 開始時讀取事件 list 回放 → 每使用者 BetRecord（gameType=ROULETTE、
 *   roundId、serverSeedHash、detail 含注單與開獎號）→ 中獎 wallet.credit
 *   （refId=BetRecord.id）。交易失敗：對所有參與者逐一 best-effort 退款
 *   （credit REFUND）並記錯誤——玩家本金永不蒸發。
 *   結算後：聊天室系統訊息（GDD §4.2：開獎號碼/顏色/總注/最熱門注型；
 *   無人下注不發，避免空服每 30s 洗版）+ 歷史寫入 Redis list（REST /history）。
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { rngBytes, rngInt, rngToken } from '../../security/csprng.js';
import type { WalletService } from '../wallet/wallet.service.js';
import {
  ROULETTE_MAX_SINGLE_BET,
  ROULETTE_MAX_TOTAL_BET,
  ROULETTE_NUMBERS,
  ROULETTE_PHASE_DURATION_MS,
  ROULETTE_RETURN_MULTIPLIER,
  RouletteBetReqSchema,
  rouletteColorOf,
  type CancelBetsResult,
  type HotBetStat,
  type PlaceBetsResult,
  type RouletteBetsSnapshotPayload,
  type RouletteHistoryItem,
  type RoulettePersonalResult,
  type RoulettePhase,
  type RoulettePhasePayload,
  type RouletteResultCommon,
  type RouletteRoundSettlement,
  type RouletteRoundStateRes,
  type RouletteSingleBet,
  type RouletteStoredEntry,
} from './roulette.types.js';

// ─────────────────────────── Redis keys ───────────────────────────

export const ROULETTE_LEADER_KEY = 'roulette:leader';
export const ROULETTE_CURRENT_KEY = 'roulette:round:current';
export const ROULETTE_HISTORY_KEY = 'roulette:history';

export function rouletteEntriesKey(roundId: string): string {
  return `roulette:round:${roundId}:entries`;
}
export function rouletteTotalsKey(roundId: string): string {
  return `roulette:round:${roundId}:totals`;
}
export function roulettePoolKey(roundId: string): string {
  return `roulette:round:${roundId}:pool`;
}

/** leader lock TTL 與心跳（3 次心跳沒到即視為死亡，他機接手） */
export const ROULETTE_LEADER_TTL_SECONDS = 12;
export const ROULETTE_LEADER_HEARTBEAT_MS = 4_000;
/** 回合資料鍵 TTL：一輪 30s，留 6 倍餘量後自然清除 */
export const ROULETTE_ROUND_KEY_TTL_SECONDS = 180;
/** BETTING 截止前的拒收緩衝（搭配 LOCK 2s 保證結算讀取必含所有已扣款注單） */
export const ROULETTE_BETTING_CUTOFF_MS = 250;
/** 歷史保留回合數（Redis list） */
export const ROULETTE_HISTORY_SIZE = 100;
/** 熱門注型統計取前幾名 */
export const ROULETTE_HOT_BETS_TOP = 3;

// ─────────────────────────── 純函式（結算核心，測試直接覆蓋） ───────────────────────────

/** 直欄歸屬：1,4,…,34 → 第 1 欄；2,5,…,35 → 第 2 欄；3,6,…,36 → 第 3 欄 */
export function rouletteColumnOf(n: number): 1 | 2 | 3 | null {
  if (n < 1 || n > 36) return null;
  return ((((n - 1) % 3) + 1) as 1 | 2 | 3);
}

/** 打（dozen）歸屬：1–12 → 1、13–24 → 2、25–36 → 3 */
export function rouletteDozenOf(n: number): 1 | 2 | 3 | null {
  if (n < 1 || n > 36) return null;
  return (Math.ceil(n / 12) as 1 | 2 | 3);
}

/**
 * 單注回收額（含本金）：未中回 0。
 * 0（綠）對所有外圍注一律輸（標準歐式規則）；僅 STRAIGHT 0 可中。
 */
export function rouletteBetReturn(bet: RouletteSingleBet, winning: number): number {
  switch (bet.type) {
    case 'STRAIGHT':
      return winning === bet.number ? bet.amount * ROULETTE_RETURN_MULTIPLIER.STRAIGHT : 0;
    case 'RED':
      return rouletteColorOf(winning) === 'RED' ? bet.amount * ROULETTE_RETURN_MULTIPLIER.RED : 0;
    case 'BLACK':
      return rouletteColorOf(winning) === 'BLACK'
        ? bet.amount * ROULETTE_RETURN_MULTIPLIER.BLACK
        : 0;
    case 'ODD':
      return winning > 0 && winning % 2 === 1 ? bet.amount * ROULETTE_RETURN_MULTIPLIER.ODD : 0;
    case 'EVEN':
      return winning > 0 && winning % 2 === 0 ? bet.amount * ROULETTE_RETURN_MULTIPLIER.EVEN : 0;
    case 'HIGH':
      return winning >= 19 && winning <= 36 ? bet.amount * ROULETTE_RETURN_MULTIPLIER.HIGH : 0;
    case 'LOW':
      return winning >= 1 && winning <= 18 ? bet.amount * ROULETTE_RETURN_MULTIPLIER.LOW : 0;
    case 'COLUMN':
      return rouletteColumnOf(winning) === bet.column
        ? bet.amount * ROULETTE_RETURN_MULTIPLIER.COLUMN
        : 0;
    case 'DOZEN':
      return rouletteDozenOf(winning) === bet.dozen
        ? bet.amount * ROULETTE_RETURN_MULTIPLIER.DOZEN
        : 0;
  }
}

/**
 * 序列回放下注事件 → 每使用者最終注單。
 * cancel 標記清空該使用者先前累積；標記之後的再下注照常生效。
 */
export function foldEntries(entries: RouletteStoredEntry[]): Map<string, RouletteSingleBet[]> {
  const byUser = new Map<string, RouletteSingleBet[]>();
  for (const entry of entries) {
    if ('cancel' in entry) {
      byUser.delete(entry.userId);
      continue;
    }
    const existing = byUser.get(entry.userId);
    if (existing === undefined) {
      byUser.set(entry.userId, [...entry.bets]);
    } else {
      existing.push(...entry.bets);
    }
  }
  // 清掉折算後為空的使用者（cancel 後未再下注）
  for (const [userId, bets] of byUser) {
    if (bets.length === 0) byUser.delete(userId);
  }
  return byUser;
}

/** 全服熱門注型統計：依 totalAmount 降冪取前 N（GDD §4.1 COOLDOWN 展示） */
export function aggregateHotBets(
  byUser: ReadonlyMap<string, RouletteSingleBet[]>,
  top = ROULETTE_HOT_BETS_TOP,
): HotBetStat[] {
  const stats = new Map<string, HotBetStat>();
  for (const bets of byUser.values()) {
    for (const bet of bets) {
      const stat = stats.get(bet.type) ?? { type: bet.type, totalAmount: 0, count: 0 };
      stat.totalAmount += bet.amount;
      stat.count += 1;
      stats.set(bet.type, stat);
    }
  }
  return [...stats.values()].sort((a, b) => b.totalAmount - a.totalAmount).slice(0, top);
}

// ─────────────────────────── 對外讀取（REST 路由用，無需機器實例） ───────────────────────────

interface RoundMirror {
  roundId: string;
  phase: RoulettePhase;
  phaseEndsAt: number;
}

function parseMirror(raw: string | null): RoundMirror | null {
  if (raw === null) return null;
  try {
    const data = JSON.parse(raw) as Partial<RoundMirror>;
    if (
      typeof data.roundId === 'string' &&
      typeof data.phase === 'string' &&
      typeof data.phaseEndsAt === 'number'
    ) {
      return data as RoundMirror;
    }
  } catch {
    /* 損毀視為不存在 */
  }
  return null;
}

/** GET /api/roulette/state：讀 Redis 鏡像 + 計數器（任何 worker 可答，不依賴機器實例）；
 *  Redis 不可用回 null（路由轉 404，客戶端退回等待 phase 廣播） */
export async function readRouletteState(redis: Redis): Promise<RouletteRoundStateRes | null> {
  try {
    const mirror = parseMirror(await redis.get(ROULETTE_CURRENT_KEY));
    if (mirror === null) return null;
    const [totals, poolRaw] = await Promise.all([
      redis.hvals(rouletteTotalsKey(mirror.roundId)),
      redis.get(roulettePoolKey(mirror.roundId)),
    ]);
    return {
      roundId: mirror.roundId,
      phase: mirror.phase,
      phaseEndsAt: new Date(mirror.phaseEndsAt).toISOString(),
      participantCount: totals.filter((v) => Number(v) > 0).length,
      totalPool: Number(poolRaw ?? '0'),
    };
  } catch {
    return null;
  }
}

/** GET /api/roulette/history：Redis list 近 100 回合分頁 */
export async function readRouletteHistory(
  redis: Redis,
  query: { page: number; limit: number },
): Promise<{ items: RouletteHistoryItem[]; total: number; page: number; limit: number }> {
  const start = (query.page - 1) * query.limit;
  const [raws, total] = await Promise.all([
    redis.lrange(ROULETTE_HISTORY_KEY, start, start + query.limit - 1),
    redis.llen(ROULETTE_HISTORY_KEY),
  ]);
  const items: RouletteHistoryItem[] = [];
  for (const raw of raws) {
    try {
      items.push(JSON.parse(raw) as RouletteHistoryItem);
    } catch {
      /* 損毀條目跳過 */
    }
  }
  return { items, total, page: query.page, limit: query.limit };
}

// ─────────────────────────── service ───────────────────────────

export interface RouletteLog {
  warn: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
}

/** 廣播出口（gateway 注入；leader 專用——非 leader 永不觸發） */
export interface RouletteBroadcastHooks {
  onPhase: (payload: RoulettePhasePayload) => void;
  onResult: (
    common: RouletteResultCommon,
    perUser: ReadonlyMap<string, RoulettePersonalResult>,
  ) => void;
  onSnapshot: (payload: RouletteBetsSnapshotPayload) => void;
}

export interface RouletteServiceDeps {
  prisma: PrismaClient;
  redis: Redis;
  wallet: Pick<WalletService, 'debit' | 'credit'>;
  hooks?: RouletteBroadcastHooks;
  /** 聊天室系統訊息（M17 chat.service）；未注入時略過 */
  chat?: { sendSystemMessage: (content: string) => Promise<unknown> };
  log?: RouletteLog;
  /** 注入式 rng（預設 csprng rngInt）；測試以決定性值驅動開獎 */
  rng?: (maxExclusive: number) => number;
  /** leader lock 持有者識別（預設隨機；測試可固定） */
  instanceId?: string;
}

interface ActiveRound {
  roundId: string;
  phase: RoulettePhase;
  phaseEndsAt: number; // epoch ms
  winningNumber: number | null; // LOCK 開始時產生
  serverSeedHash: string; // provably-fair 預留（02_TDD §5.1，同 slot）
}

export function createRouletteService(deps: RouletteServiceDeps) {
  const { prisma, redis, wallet } = deps;
  const log: RouletteLog = deps.log ?? { warn: () => {} };
  const logError = (obj: unknown, msg?: string): void => {
    (log.error ?? log.warn)(obj, msg);
  };
  const rng = deps.rng ?? rngInt;
  const instanceId = deps.instanceId ?? `roulette:${rngToken(6)}`;

  // ── 機器狀態（僅 leader 持有 round ≠ null） ──
  let round: ActiveRound | null = null;
  let phaseTimer: NodeJS.Timeout | null = null;
  let running = false; // 機器循環進行中（防重複啟動）
  let stopped = false; // stop() 之後一切排程靜默退出
  let isLeader = false;
  let leaseTimer: NodeJS.Timeout | null = null;
  let startedLeadership = false;

  function newRoundId(): string {
    return `R${Date.now().toString(36)}-${rngToken(6)}`;
  }

  function schedule(fn: () => Promise<void>, ms: number): void {
    if (stopped) return;
    phaseTimer = setTimeout(() => {
      fn().catch((err: unknown) => {
        // 機器永不死亡：未知例外記錯誤，COOLDOWN 時長後強制開新回合
        logError({ err: (err as Error).message }, 'roulette: 階段轉換例外，重啟新回合');
        if (!stopped) schedule(beginRound, ROULETTE_PHASE_DURATION_MS.COOLDOWN);
      });
    }, ms);
    phaseTimer.unref?.();
  }

  /** 階段鏡像 → Redis（非 leader 驗注、REST /state 依據）；故障僅記日誌 */
  async function mirrorState(): Promise<void> {
    if (round === null) return;
    try {
      await redis.set(
        ROULETTE_CURRENT_KEY,
        JSON.stringify({
          roundId: round.roundId,
          phase: round.phase,
          phaseEndsAt: round.phaseEndsAt,
        }),
        'EX',
        60,
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'roulette: 階段鏡像寫入失敗');
    }
  }

  async function countParticipants(roundId: string): Promise<number> {
    try {
      const totals = await redis.hvals(rouletteTotalsKey(roundId));
      return totals.filter((v) => Number(v) > 0).length;
    } catch {
      return 0;
    }
  }

  async function readPool(roundId: string): Promise<number> {
    try {
      return Number((await redis.get(roulettePoolKey(roundId))) ?? '0');
    } catch {
      return 0;
    }
  }

  async function broadcastPhase(): Promise<void> {
    if (round === null) return;
    const payload: RoulettePhasePayload = {
      roundId: round.roundId,
      phase: round.phase,
      phaseEndsAt: new Date(round.phaseEndsAt).toISOString(),
      participantCount: await countParticipants(round.roundId),
    };
    try {
      deps.hooks?.onPhase(payload);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'roulette: phase 廣播失敗');
    }
  }

  // ── 狀態機四階段 ──

  async function beginRound(): Promise<void> {
    if (stopped) return;
    round = {
      roundId: newRoundId(),
      phase: 'BETTING',
      phaseEndsAt: Date.now() + ROULETTE_PHASE_DURATION_MS.BETTING,
      winningNumber: null,
      serverSeedHash: createHash('sha256').update(rngBytes(32)).digest('hex'),
    };
    await mirrorState();
    await broadcastPhase();
    schedule(lockPhase, ROULETTE_PHASE_DURATION_MS.BETTING);
  }

  async function lockPhase(): Promise<void> {
    if (stopped || round === null) return;
    round.phase = 'LOCK';
    round.phaseEndsAt = Date.now() + ROULETTE_PHASE_DURATION_MS.LOCK;
    // GDD §4.1：LOCK 階段以 CSPRNG 產生結果（廣播留到 RESULT）
    round.winningNumber = rng(ROULETTE_NUMBERS);
    await mirrorState();
    await broadcastPhase();
    schedule(resultPhase, ROULETTE_PHASE_DURATION_MS.LOCK);
  }

  async function resultPhase(): Promise<void> {
    if (stopped || round === null) return;
    round.phase = 'RESULT';
    round.phaseEndsAt = Date.now() + ROULETTE_PHASE_DURATION_MS.RESULT;
    await mirrorState();
    await broadcastPhase();

    const settlement = await settleRound(round);
    try {
      deps.hooks?.onResult(settlement.common, settlement.perUser);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'roulette: result 廣播失敗');
    }
    await sendRoundChatMessage(settlement.common);
    await pushHistory(settlement.common);

    schedule(cooldownPhase, ROULETTE_PHASE_DURATION_MS.RESULT);
  }

  async function cooldownPhase(): Promise<void> {
    if (stopped || round === null) return;
    const settledRoundId = round.roundId;
    round.phase = 'COOLDOWN';
    round.phaseEndsAt = Date.now() + ROULETTE_PHASE_DURATION_MS.COOLDOWN;
    await mirrorState();
    await broadcastPhase();

    // 下注統計快照（GDD §4.1 COOLDOWN 展示熱門注型）
    try {
      const entries = await readEntries(settledRoundId);
      const byUser = foldEntries(entries);
      let betsCount = 0;
      for (const bets of byUser.values()) betsCount += bets.length;
      deps.hooks?.onSnapshot({
        roundId: settledRoundId,
        totalPool: await readPool(settledRoundId),
        betsCount,
        hotBets: aggregateHotBets(byUser),
      });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'roulette: bets_snapshot 廣播失敗');
    }

    schedule(beginRound, ROULETTE_PHASE_DURATION_MS.COOLDOWN);
  }

  // ── 結算 ──

  async function readEntries(roundId: string): Promise<RouletteStoredEntry[]> {
    const raws = await redis.lrange(rouletteEntriesKey(roundId), 0, -1);
    const entries: RouletteStoredEntry[] = [];
    for (const raw of raws) {
      try {
        entries.push(JSON.parse(raw) as RouletteStoredEntry);
      } catch {
        log.warn({ roundId }, 'roulette: 下注事件損毀，跳過（金額以 BetRecord 對帳）');
      }
    }
    return entries;
  }

  /**
   * 結算（RESULT 開始時呼叫）：序列回放注單 → 單一 PG 交易批量落帳。
   * 交易失敗：逐使用者 best-effort 退還本金（credit REFUND）——本金永不蒸發。
   */
  async function settleRound(current: ActiveRound): Promise<RouletteRoundSettlement> {
    // 防禦：winningNumber 必於 LOCK 產生；缺失（理論不可能）即補產生
    const winning = current.winningNumber ?? rng(ROULETTE_NUMBERS);
    const common: RouletteResultCommon = {
      roundId: current.roundId,
      winningNumber: winning,
      color: rouletteColorOf(winning),
      totalPool: 0,
      participantCount: 0,
      hotBets: [],
    };
    const perUser = new Map<string, RoulettePersonalResult>();

    let byUser: Map<string, RouletteSingleBet[]>;
    try {
      byUser = foldEntries(await readEntries(current.roundId));
    } catch (err) {
      // Redis 讀取失敗：扣款已發生但注單不可得——無從結算也無從退款，
      // 記錯誤待對帳（生產 Redis 由 plugin fail loud 保證，此路徑屬極端故障）
      logError(
        { err: (err as Error).message, roundId: current.roundId },
        'roulette: 注單讀取失敗，本回合無法結算（需以 BalanceTransaction 對帳）',
      );
      return { common, perUser };
    }

    if (byUser.size === 0) return { common, perUser };

    common.hotBets = aggregateHotBets(byUser);
    for (const bets of byUser.values()) {
      common.totalPool += bets.reduce((sum, bet) => sum + bet.amount, 0);
    }
    common.participantCount = byUser.size;

    try {
      // ── 單一 PG 交易：逐玩家 BetRecord + 中獎 credit（02_TDD §4 批量結算） ──
      await prisma.$transaction(async (tx) => {
        for (const [userId, bets] of byUser) {
          const totalBet = bets.reduce((sum, bet) => sum + bet.amount, 0);
          const payout = bets.reduce((sum, bet) => sum + rouletteBetReturn(bet, winning), 0);

          const betRecord = await tx.betRecord.create({
            data: {
              userId,
              gameType: 'ROULETTE',
              amount: BigInt(totalBet),
              payout: BigInt(payout),
              roundId: current.roundId,
              serverSeedHash: current.serverSeedHash,
              detail: {
                roundId: current.roundId,
                winningNumber: winning,
                color: common.color,
                bets,
              },
            },
          });

          let newBalance: bigint;
          if (payout > 0) {
            const credit = await wallet.credit(userId, BigInt(payout), 'PAYOUT', {
              tx,
              refId: betRecord.id,
            });
            newBalance = credit.balance;
          } else {
            const user = await tx.user.findUniqueOrThrow({
              where: { id: userId },
              select: { balance: true },
            });
            newBalance = user.balance;
          }
          perUser.set(userId, { totalBet, payout, newBalance });
        }
      });
    } catch (err) {
      // 結算交易失敗：整筆回滾（零 BetRecord、零賠付）→ 退還所有本金
      logError(
        { err: (err as Error).message, roundId: current.roundId },
        'roulette: 結算交易失敗，退還全部本金',
      );
      perUser.clear();
      for (const [userId, bets] of byUser) {
        const totalBet = bets.reduce((sum, bet) => sum + bet.amount, 0);
        try {
          await wallet.credit(userId, BigInt(totalBet), 'REFUND', {
            refId: current.roundId,
            memo: '輪盤結算失敗退款',
          });
        } catch (refundErr) {
          logError(
            { err: (refundErr as Error).message, userId, totalBet, roundId: current.roundId },
            'roulette: 退款失敗——需人工對帳',
          );
        }
      }
    }

    return { common, perUser };
  }

  async function sendRoundChatMessage(common: RouletteResultCommon): Promise<void> {
    // 無人下注不發系統訊息（空服時每 30s 一則會洗版聊天室）
    if (deps.chat === undefined || common.totalPool <= 0) return;
    const colorLabel = common.color === 'RED' ? '紅' : common.color === 'BLACK' ? '黑' : '綠';
    const hottest = common.hotBets[0];
    const hottestLabel =
      hottest !== undefined ? `｜最熱門：${hottest.type}（${hottest.totalAmount} Coin）` : '';
    try {
      await deps.chat.sendSystemMessage(
        `🎡 輪盤開獎：${common.winningNumber}（${colorLabel}）｜本輪總下注 ${common.totalPool} Coin${hottestLabel}`,
      );
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'roulette: 系統訊息發送失敗');
    }
  }

  async function pushHistory(common: RouletteResultCommon): Promise<void> {
    const item: RouletteHistoryItem = {
      roundId: common.roundId,
      winningNumber: common.winningNumber,
      color: common.color,
      totalPool: common.totalPool,
      participantCount: common.participantCount,
      resolvedAt: new Date().toISOString(),
    };
    try {
      await redis.lpush(ROULETTE_HISTORY_KEY, JSON.stringify(item));
      await redis.ltrim(ROULETTE_HISTORY_KEY, 0, ROULETTE_HISTORY_SIZE - 1);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'roulette: 歷史寫入失敗');
    }
  }

  // ── leader 選主 ──

  async function tryAcquireLeadership(): Promise<boolean> {
    try {
      const result = await redis.set(
        ROULETTE_LEADER_KEY,
        instanceId,
        'EX',
        ROULETTE_LEADER_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    } catch (err) {
      // Redis 不可用：退化單機模式直接視為 leader（檔頭 cluster 說明）
      log.warn(
        { err: (err as Error).message },
        'roulette: leader lock 不可用，退化為本機狀態機',
      );
      return true;
    }
  }

  function haltMachine(): void {
    if (phaseTimer !== null) {
      clearTimeout(phaseTimer);
      phaseTimer = null;
    }
    running = false;
    round = null;
  }

  /** 任何 worker 可用的回合快照：leader 用本機、否則讀 Redis 鏡像 */
  async function getRoundSnapshot(): Promise<RoundMirror | null> {
    if (round !== null) {
      return { roundId: round.roundId, phase: round.phase, phaseEndsAt: round.phaseEndsAt };
    }
    try {
      return parseMirror(await redis.get(ROULETTE_CURRENT_KEY));
    } catch {
      return null;
    }
  }

  /**
   * 立即開新回合（重啟不恢復舊回合——GDD：客戶端由 roulette:phase 同步）。
   * 防重複啟動：機器循環進行中時為 no-op。
   */
  function startRound(): void {
    if (running) {
      log.warn('roulette: 狀態機已在運行，忽略重複 startRound');
      return;
    }
    if (stopped) return;
    running = true;
    isLeader = true; // 直接呼叫視為本機持有機器（leader 選主走 start()）
    beginRound().catch((err: unknown) => {
      logError({ err: (err as Error).message }, 'roulette: 回合啟動失敗');
      running = false;
    });
  }

  async function leadershipTick(): Promise<void> {
    if (stopped) return;
    if (isLeader) {
      // 續租：仍持有 → EXPIRE；被搶走（理論上只在本機長停頓後）→ 讓位
      try {
        const owner = await redis.get(ROULETTE_LEADER_KEY);
        if (owner === instanceId) {
          await redis.expire(ROULETTE_LEADER_KEY, ROULETTE_LEADER_TTL_SECONDS);
        } else if (owner === null) {
          const reacquired = await tryAcquireLeadership();
          if (!reacquired) {
            isLeader = false;
            haltMachine();
            log.warn('roulette: leader 租約過期且被接手，本機狀態機停止');
          }
        } else {
          isLeader = false;
          haltMachine();
          log.warn({ owner }, 'roulette: leader 易主，本機狀態機停止');
        }
      } catch {
        // Redis 不可用：維持本機 leader（單機退化模式）
      }
      return;
    }
    const acquired = await tryAcquireLeadership();
    if (acquired && !stopped) {
      isLeader = true;
      startRound();
    }
  }

  return {
    // ── 對外狀態查詢（prompt 要求三件套） ──

    /** 本機機器當前階段（非 leader 回 null——以 getStateSnapshot 讀鏡像） */
    getCurrentPhase(): RoulettePhase | null {
      return round?.phase ?? null;
    },

    /** 當前階段剩餘毫秒（非 leader 回 null） */
    getRemainingMs(): number | null {
      if (round === null) return null;
      return Math.max(0, round.phaseEndsAt - Date.now());
    },

    /** 任何 worker 可用的回合快照：leader 用本機、否則讀 Redis 鏡像 */
    getRoundSnapshot,

    /** 立即開新回合（防重複啟動；leader 選主請走 start()） */
    startRound,

    /**
     * Cluster 入口：leader 選主迴圈（搶到鎖才 startRound；心跳續租、
     * 失聯讓位、空缺接手開新回合）。重複呼叫 no-op。
     */
    start(): void {
      if (startedLeadership || stopped) return;
      startedLeadership = true;
      void leadershipTick();
      leaseTimer = setInterval(() => {
        void leadershipTick();
      }, ROULETTE_LEADER_HEARTBEAT_MS);
      leaseTimer.unref?.();
    },

    /** graceful shutdown：停機器、停心跳、釋放 leader lock（best-effort） */
    async stop(): Promise<void> {
      stopped = true;
      if (leaseTimer !== null) {
        clearInterval(leaseTimer);
        leaseTimer = null;
      }
      haltMachine();
      if (isLeader) {
        isLeader = false;
        try {
          const owner = await redis.get(ROULETTE_LEADER_KEY);
          if (owner === instanceId) await redis.del(ROULETTE_LEADER_KEY);
        } catch {
          /* 鍵會隨 TTL 過期，他機自然接手 */
        }
      }
    },

    // ── 下注（Socket roulette:bet；HMAC 已由 M06/M08 中介層驗畢） ──

    async placeBets(userId: string, rawPayload: unknown): Promise<PlaceBetsResult> {
      const parsed = RouletteBetReqSchema.safeParse(rawPayload);
      if (!parsed.success) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '下注格式錯誤' };
      }
      const { roundId, bets } = parsed.data;

      // 單注上限（zod 僅驗正整數；上限依凍結錯誤碼回 BET_LIMIT_EXCEEDED）
      for (const bet of bets) {
        if (bet.amount > ROULETTE_MAX_SINGLE_BET) {
          return {
            ok: false,
            code: 'BET_LIMIT_EXCEEDED',
            message: `單注上限 ${ROULETTE_MAX_SINGLE_BET} Coin`,
          };
        }
      }
      const total = bets.reduce((sum, bet) => sum + bet.amount, 0);

      // 回合時窗（02_TDD §5.3）：roundId 一致 + BETTING + 截止前 250ms 緩衝
      const snapshot = await getRoundSnapshot();
      if (
        snapshot === null ||
        snapshot.roundId !== roundId ||
        snapshot.phase !== 'BETTING' ||
        Date.now() > snapshot.phaseEndsAt - ROULETTE_BETTING_CUTOFF_MS
      ) {
        return {
          ok: false,
          code: 'ROULETTE_PHASE_CLOSED',
          message: '本回合已停止下注，請等待下一輪',
        };
      }

      const totalsKey = rouletteTotalsKey(roundId);

      // 1) 原子佔額：HINCRBY 後檢查總注上限，超限回退
      let newTotal: number;
      try {
        newTotal = await redis.hincrby(totalsKey, userId, total);
      } catch (err) {
        log.warn({ err: (err as Error).message, userId }, 'roulette: 注額計數不可用，拒絕下注');
        return { ok: false, code: 'INTERNAL_ERROR', message: '服務暫時不可用，請稍後再試' };
      }
      if (newTotal > ROULETTE_MAX_TOTAL_BET) {
        try {
          await redis.hincrby(totalsKey, userId, -total);
        } catch {
          /* 回退失敗僅影響上限計數（偏保守：少能下注），不影響金錢 */
        }
        return {
          ok: false,
          code: 'BET_LIMIT_EXCEEDED',
          message: `單回合總注上限 ${ROULETTE_MAX_TOTAL_BET} Coin（已下 ${newTotal - total}）`,
        };
      }

      // 2) 即時扣款（條件更新；不足 422 整筆回滾）
      try {
        await wallet.debit(userId, BigInt(total), 'BET', {
          refId: roundId,
          memo: '輪盤下注',
        });
      } catch (err) {
        try {
          await redis.hincrby(totalsKey, userId, -total);
        } catch {
          /* 同上：計數偏保守無金錢風險 */
        }
        const isBalance =
          typeof err === 'object' &&
          err !== null &&
          (err as { code?: string }).code === 'INSUFFICIENT_BALANCE';
        if (isBalance) {
          return { ok: false, code: 'INSUFFICIENT_BALANCE', message: '餘額不足' };
        }
        logError({ err: (err as Error).message, userId }, 'roulette: 下注扣款失敗');
        return { ok: false, code: 'INTERNAL_ERROR', message: '下注失敗，請稍後再試' };
      }

      // 3) 注單入帳本（append-only）；失敗即退款——沒進帳本的注不可留錢
      const entry: RouletteStoredEntry = { userId, bets };
      try {
        await redis.rpush(rouletteEntriesKey(roundId), JSON.stringify(entry));
        await redis.incrby(roulettePoolKey(roundId), total);
        await Promise.all([
          redis.expire(rouletteEntriesKey(roundId), ROULETTE_ROUND_KEY_TTL_SECONDS),
          redis.expire(totalsKey, ROULETTE_ROUND_KEY_TTL_SECONDS),
          redis.expire(roulettePoolKey(roundId), ROULETTE_ROUND_KEY_TTL_SECONDS),
        ]);
      } catch (err) {
        logError(
          { err: (err as Error).message, userId, total },
          'roulette: 注單寫入失敗，原路退款',
        );
        try {
          await wallet.credit(userId, BigInt(total), 'REFUND', {
            refId: roundId,
            memo: '輪盤下注寫入失敗退款',
          });
        } catch (refundErr) {
          logError(
            { err: (refundErr as Error).message, userId, total },
            'roulette: 退款失敗——需人工對帳',
          );
        }
        try {
          await redis.hincrby(totalsKey, userId, -total);
        } catch {
          /* 計數偏保守 */
        }
        return { ok: false, code: 'INTERNAL_ERROR', message: '下注失敗，請稍後再試' };
      }

      return {
        ok: true,
        ack: {
          accepted: true,
          roundId,
          totalBet: newTotal,
          remaining: ROULETTE_MAX_TOTAL_BET - newTotal,
        },
      };
    },

    // ── 取消（Socket roulette:cancel；僅 BETTING 階段） ──

    async cancelBets(userId: string, rawPayload: unknown): Promise<CancelBetsResult> {
      const roundId =
        typeof rawPayload === 'object' &&
        rawPayload !== null &&
        typeof (rawPayload as Record<string, unknown>)['roundId'] === 'string'
          ? ((rawPayload as Record<string, unknown>)['roundId'] as string)
          : null;
      if (roundId === null) {
        return { ok: false, code: 'VALIDATION_ERROR', message: '取消格式錯誤' };
      }

      const snapshot = await getRoundSnapshot();
      if (snapshot === null || snapshot.roundId !== roundId || snapshot.phase !== 'BETTING') {
        return { ok: false, code: 'ROULETTE_PHASE_CLOSED', message: '本回合已鎖盤，無法取消' };
      }

      const totalsKey = rouletteTotalsKey(roundId);
      try {
        const currentRaw = await redis.hget(totalsKey, userId);
        const current = Number(currentRaw ?? '0');
        if (!Number.isSafeInteger(current) || current <= 0) {
          return { ok: true, cancelled: false, refunded: 0 };
        }
        // 原子認領：併發雙取消時 HINCRBY 後為負者輸，回補後拒絕
        const after = await redis.hincrby(totalsKey, userId, -current);
        if (after < 0) {
          await redis.hincrby(totalsKey, userId, current);
          return { ok: true, cancelled: false, refunded: 0 };
        }

        await redis.rpush(
          rouletteEntriesKey(roundId),
          JSON.stringify({ userId, cancel: true } satisfies RouletteStoredEntry),
        );
        await redis.incrby(roulettePoolKey(roundId), -current);

        await wallet.credit(userId, BigInt(current), 'REFUND', {
          refId: roundId,
          memo: '輪盤下注取消退款',
        });
        return { ok: true, cancelled: true, refunded: current };
      } catch (err) {
        logError({ err: (err as Error).message, userId, roundId }, 'roulette: 取消下注失敗');
        return { ok: false, code: 'INTERNAL_ERROR', message: '取消失敗，請稍後再試' };
      }
    },
  };
}

export type RouletteService = ReturnType<typeof createRouletteService>;
