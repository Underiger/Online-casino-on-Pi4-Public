/**
 * Roulette 服務單元測試（M15）。
 *
 * 覆蓋：
 *   - 純函式：顏色/直欄/打歸屬、單注回收（含 0 綠對外圍注全輸、大小邊界）、
 *     事件回放（cancel 語義）、熱門注型統計
 *   - 狀態機時序（vi.useFakeTimers）：BETTING→LOCK→RESULT→COOLDOWN→新回合循環、
 *     LOCK 才產生開獎號（rng(37)）、防重複啟動、Redis 鏡像
 *   - 下注驗證：格式/單注上限/總注上限/roundId/階段時窗/截止緩衝/餘額不足回退、
 *     注單寫入失敗原路退款
 *   - 取消：退款 + 結算跳過 + 取消後再下注生效
 *   - 結算：多人批量單交易（BetRecord/credit refId）、0 號全輸、無人下注、
 *     交易失敗全額退款
 *   - leader 選主：同鎖互斥、讓位接手、Redis 故障退化單機
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateHotBets,
  createRouletteService,
  foldEntries,
  readRouletteHistory,
  readRouletteState,
  rouletteBetReturn,
  rouletteColumnOf,
  rouletteDozenOf,
  rouletteEntriesKey,
  roulettePoolKey,
  ROULETTE_CURRENT_KEY,
  type RouletteService,
} from '../../src/modules/roulette/roulette.service.js';
import {
  ROULETTE_PHASE_DURATION_MS,
  rouletteColorOf,
  type RouletteBetsSnapshotPayload,
  type RoulettePersonalResult,
  type RoulettePhasePayload,
  type RouletteResultCommon,
  type RouletteSingleBet,
  type RouletteStoredEntry,
} from '../../src/modules/roulette/roulette.types.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';
const BOB = 'user_bob';

const { BETTING, LOCK, RESULT, COOLDOWN } = ROULETTE_PHASE_DURATION_MS;

interface SetupOptions {
  users?: Array<{ id: string; balance: bigint }>;
  rngValues?: number[];
  betRecordCreateThrows?: boolean;
  instanceId?: string;
  sharedRedis?: ReturnType<typeof createFakeRedis>;
}

function setup(options: SetupOptions = {}) {
  const db = createFakeDb({
    users: options.users ?? [
      { id: ALICE, balance: 10_000n },
      { id: BOB, balance: 10_000n },
    ],
    ...(options.betRecordCreateThrows !== undefined
      ? { betRecordCreateThrows: options.betRecordCreateThrows }
      : {}),
  });
  const fakeRedis = options.sharedRedis ?? createFakeRedis();

  const phases: RoulettePhasePayload[] = [];
  const results: Array<{
    common: RouletteResultCommon;
    perUser: Map<string, RoulettePersonalResult>;
  }> = [];
  const snapshots: RouletteBetsSnapshotPayload[] = [];
  const chatMessages: string[] = [];
  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  const rngQueue = [...(options.rngValues ?? [])];
  const rngCalls: number[] = [];

  const service = createRouletteService({
    prisma: db.prisma,
    redis: fakeRedis.redis,
    wallet: createWalletService(db.prisma),
    hooks: {
      onPhase: (payload) => phases.push(payload),
      onResult: (common, perUser) => results.push({ common, perUser: new Map(perUser) }),
      onSnapshot: (payload) => snapshots.push(payload),
    },
    chat: {
      sendSystemMessage: async (content: string) => {
        chatMessages.push(content);
        return {};
      },
    },
    log: { warn: (obj) => warnings.push(obj), error: (obj) => errors.push(obj) },
    rng: (maxExclusive) => {
      rngCalls.push(maxExclusive);
      return rngQueue.shift() ?? 0;
    },
    instanceId: options.instanceId ?? 'test-instance',
  });

  return {
    db,
    redis: fakeRedis,
    service,
    phases,
    results,
    snapshots,
    chatMessages,
    warnings,
    errors,
    rngCalls,
  };
}

/** startRound 後沖洗 beginRound 的微任務（fake timers 下 await 0ms 即 flush） */
async function startAndFlush(service: RouletteService): Promise<string> {
  service.startRound();
  await vi.advanceTimersByTimeAsync(0);
  const snapshot = await service.getRoundSnapshot();
  if (snapshot === null) throw new Error('round 未啟動');
  return snapshot.roundId;
}

let activeServices: RouletteService[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  activeServices = [];
});

afterEach(async () => {
  for (const service of activeServices) await service.stop();
  vi.useRealTimers();
});

function track<T extends { service: RouletteService }>(env: T): T {
  activeServices.push(env.service);
  return env;
}

// ═════════════════ 純函式 ═════════════════

describe('結算純函式', () => {
  it('顏色表：0 綠、紅名單命中、其餘黑', () => {
    expect(rouletteColorOf(0)).toBe('GREEN');
    expect(rouletteColorOf(1)).toBe('RED');
    expect(rouletteColorOf(2)).toBe('BLACK');
    expect(rouletteColorOf(18)).toBe('RED');
    expect(rouletteColorOf(19)).toBe('RED');
    expect(rouletteColorOf(10)).toBe('BLACK');
    expect(rouletteColorOf(36)).toBe('RED');
  });

  it('直欄/打歸屬與邊界（0 不屬任何欄/打）', () => {
    expect(rouletteColumnOf(1)).toBe(1);
    expect(rouletteColumnOf(2)).toBe(2);
    expect(rouletteColumnOf(3)).toBe(3);
    expect(rouletteColumnOf(34)).toBe(1);
    expect(rouletteColumnOf(36)).toBe(3);
    expect(rouletteColumnOf(0)).toBeNull();
    expect(rouletteDozenOf(1)).toBe(1);
    expect(rouletteDozenOf(12)).toBe(1);
    expect(rouletteDozenOf(13)).toBe(2);
    expect(rouletteDozenOf(24)).toBe(2);
    expect(rouletteDozenOf(25)).toBe(3);
    expect(rouletteDozenOf(36)).toBe(3);
    expect(rouletteDozenOf(0)).toBeNull();
  });

  it('單注回收：賠率表全類型 + 大小邊界（18/19）', () => {
    expect(rouletteBetReturn({ type: 'STRAIGHT', amount: 10, number: 7 }, 7)).toBe(360);
    expect(rouletteBetReturn({ type: 'STRAIGHT', amount: 10, number: 7 }, 8)).toBe(0);
    expect(rouletteBetReturn({ type: 'RED', amount: 100 }, 1)).toBe(200);
    expect(rouletteBetReturn({ type: 'BLACK', amount: 100 }, 2)).toBe(200);
    expect(rouletteBetReturn({ type: 'ODD', amount: 100 }, 9)).toBe(200);
    expect(rouletteBetReturn({ type: 'EVEN', amount: 100 }, 8)).toBe(200);
    expect(rouletteBetReturn({ type: 'LOW', amount: 100 }, 18)).toBe(200);
    expect(rouletteBetReturn({ type: 'HIGH', amount: 100 }, 18)).toBe(0);
    expect(rouletteBetReturn({ type: 'HIGH', amount: 100 }, 19)).toBe(200);
    expect(rouletteBetReturn({ type: 'COLUMN', amount: 100, column: 1 }, 4)).toBe(300);
    expect(rouletteBetReturn({ type: 'COLUMN', amount: 100, column: 2 }, 4)).toBe(0);
    expect(rouletteBetReturn({ type: 'DOZEN', amount: 100, dozen: 2 }, 13)).toBe(300);
  });

  it('0（綠）：所有外圍注全輸，僅 STRAIGHT 0 可中（標準歐式）', () => {
    const outside: RouletteSingleBet[] = [
      { type: 'RED', amount: 100 },
      { type: 'BLACK', amount: 100 },
      { type: 'ODD', amount: 100 },
      { type: 'EVEN', amount: 100 },
      { type: 'HIGH', amount: 100 },
      { type: 'LOW', amount: 100 },
      { type: 'COLUMN', amount: 100, column: 1 },
      { type: 'DOZEN', amount: 100, dozen: 1 },
    ];
    for (const bet of outside) {
      expect(rouletteBetReturn(bet, 0)).toBe(0);
    }
    expect(rouletteBetReturn({ type: 'STRAIGHT', amount: 100, number: 0 }, 0)).toBe(3_600);
  });

  it('foldEntries：cancel 清空先前累積、取消後再下注生效', () => {
    const entries: RouletteStoredEntry[] = [
      { userId: ALICE, bets: [{ type: 'RED', amount: 100 }] },
      { userId: BOB, bets: [{ type: 'BLACK', amount: 50 }] },
      { userId: ALICE, cancel: true },
      { userId: ALICE, bets: [{ type: 'ODD', amount: 30 }] },
    ];
    const byUser = foldEntries(entries);
    expect(byUser.get(ALICE)).toEqual([{ type: 'ODD', amount: 30 }]);
    expect(byUser.get(BOB)).toEqual([{ type: 'BLACK', amount: 50 }]);
  });

  it('aggregateHotBets：依 totalAmount 降冪取前 3', () => {
    const byUser = new Map<string, RouletteSingleBet[]>([
      [ALICE, [{ type: 'RED', amount: 300 }, { type: 'STRAIGHT', amount: 10, number: 7 }]],
      [BOB, [{ type: 'RED', amount: 200 }, { type: 'BLACK', amount: 400 }, { type: 'HIGH', amount: 50 }]],
    ]);
    expect(aggregateHotBets(byUser)).toEqual([
      { type: 'RED', totalAmount: 500, count: 2 }, // 300 + 200
      { type: 'BLACK', totalAmount: 400, count: 1 },
      { type: 'HIGH', totalAmount: 50, count: 1 },
    ]);
  });
});

// ═════════════════ 狀態機時序 ═════════════════

describe('回合狀態機（fake timers）', () => {
  it('BETTING(15s)→LOCK(2s)→RESULT(8s)→COOLDOWN(5s)→新回合，無限循環', async () => {
    const env = track(setup({ rngValues: [17] }));
    const roundId = await startAndFlush(env.service);

    expect(env.service.getCurrentPhase()).toBe('BETTING');
    expect(env.service.getRemainingMs()).toBe(BETTING);
    expect(env.phases.map((p) => p.phase)).toEqual(['BETTING']);
    expect(env.rngCalls).toEqual([]); // 開獎號 LOCK 才產生

    await vi.advanceTimersByTimeAsync(BETTING);
    expect(env.service.getCurrentPhase()).toBe('LOCK');
    expect(env.rngCalls).toEqual([37]); // rngInt(37)

    await vi.advanceTimersByTimeAsync(LOCK);
    expect(env.service.getCurrentPhase()).toBe('RESULT');
    expect(env.results).toHaveLength(1);
    expect(env.results[0]!.common.winningNumber).toBe(17);

    await vi.advanceTimersByTimeAsync(RESULT);
    expect(env.service.getCurrentPhase()).toBe('COOLDOWN');
    expect(env.snapshots).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(COOLDOWN);
    expect(env.service.getCurrentPhase()).toBe('BETTING');
    const next = await env.service.getRoundSnapshot();
    expect(next!.roundId).not.toBe(roundId); // 新回合新 roundId

    expect(env.phases.map((p) => p.phase)).toEqual([
      'BETTING', 'LOCK', 'RESULT', 'COOLDOWN', 'BETTING',
    ]);
    // 同一回合四個階段共用 roundId
    expect(new Set(env.phases.slice(0, 4).map((p) => p.roundId)).size).toBe(1);
  });

  it('getRemainingMs 隨時間遞減；phaseEndsAt 為 ISO 字串', async () => {
    const env = track(setup());
    await startAndFlush(env.service);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(env.service.getRemainingMs()).toBe(BETTING - 6_000);
    expect(Date.parse(env.phases[0]!.phaseEndsAt)).not.toBeNaN();
  });

  it('防重複啟動：startRound 第二次為 no-op（單一 BETTING 廣播 + 警告）', async () => {
    const env = track(setup());
    await startAndFlush(env.service);
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.phases.map((p) => p.phase)).toEqual(['BETTING']);
    expect(env.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('階段鏡像寫入 Redis（roulette:round:current），REST readRouletteState 可讀', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);

    const mirror = JSON.parse(env.redis.store.get(ROULETTE_CURRENT_KEY)!) as {
      roundId: string;
      phase: string;
    };
    expect(mirror).toMatchObject({ roundId, phase: 'BETTING' });

    const state = await readRouletteState(env.redis.redis);
    expect(state).toMatchObject({ roundId, phase: 'BETTING', participantCount: 0, totalPool: 0 });
  });

  it('stop 之後不再轉換階段（graceful shutdown）', async () => {
    const env = track(setup());
    await startAndFlush(env.service);
    await env.service.stop();

    await vi.advanceTimersByTimeAsync(BETTING + LOCK + RESULT + COOLDOWN);
    expect(env.phases.map((p) => p.phase)).toEqual(['BETTING']); // 僅啟動那一次
  });
});

// ═════════════════ 下注驗證 ═════════════════

describe('placeBets', () => {
  it('happy path：扣款 + 注單入帳本 + ack 額度', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);

    const result = await env.service.placeBets(ALICE, {
      roundId,
      bets: [
        { type: 'STRAIGHT', amount: 100, number: 7 },
        { type: 'RED', amount: 50 },
      ],
    });

    expect(result).toEqual({
      ok: true,
      ack: { accepted: true, roundId, totalBet: 150, remaining: 4_850 },
    });
    expect(env.db.users[0]!.balance).toBe(9_850n);
    expect(env.db.txRecords[0]).toMatchObject({ type: 'BET', delta: -150n, refId: roundId });
    expect(env.redis.lists.get(rouletteEntriesKey(roundId))).toHaveLength(1);
    expect(env.redis.store.get(roulettePoolKey(roundId))).toBe('150');
  });

  it('格式錯誤（空注單 / STRAIGHT 缺號碼 / 未知注型）→ VALIDATION_ERROR、不扣款', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);

    const cases: unknown[] = [
      { roundId, bets: [] },
      { roundId, bets: [{ type: 'STRAIGHT', amount: 100 }] },
      { roundId, bets: [{ type: 'SPLIT', amount: 100 }] },
      { bets: [{ type: 'RED', amount: 100 }] },
      null,
    ];
    for (const payload of cases) {
      const result = await env.service.placeBets(ALICE, payload);
      expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    }
    expect(env.db.users[0]!.balance).toBe(10_000n);
  });

  it('單注 > 1000 → BET_LIMIT_EXCEEDED', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);

    const result = await env.service.placeBets(ALICE, {
      roundId,
      bets: [{ type: 'RED', amount: 1_001 }],
    });
    expect(result).toMatchObject({ ok: false, code: 'BET_LIMIT_EXCEEDED' });
    expect(env.db.users[0]!.balance).toBe(10_000n);
  });

  it('單回合總注 > 5000 → BET_LIMIT_EXCEEDED，佔額回退（後續仍可下到上限）', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);

    const first = await env.service.placeBets(ALICE, {
      roundId,
      bets: Array.from({ length: 4 }, () => ({ type: 'RED', amount: 1_000 })),
    });
    expect(first.ok).toBe(true);

    const second = await env.service.placeBets(ALICE, {
      roundId,
      bets: [{ type: 'BLACK', amount: 1_000 }, { type: 'ODD', amount: 500 }],
    });
    expect(second).toMatchObject({ ok: false, code: 'BET_LIMIT_EXCEEDED' });
    expect(env.db.users[0]!.balance).toBe(6_000n); // 僅第一筆扣款

    // 佔額已回退：剛好補滿 1000 仍可下
    const third = await env.service.placeBets(ALICE, {
      roundId,
      bets: [{ type: 'BLACK', amount: 1_000 }],
    });
    expect(third).toMatchObject({ ok: true, ack: { totalBet: 5_000, remaining: 0 } });
  });

  it('roundId 不符 / 非 BETTING 階段 / 截止前 250ms → ROULETTE_PHASE_CLOSED', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);
    const bets = [{ type: 'RED', amount: 100 }];

    expect(await env.service.placeBets(ALICE, { roundId: 'R-stale', bets })).toMatchObject({
      ok: false,
      code: 'ROULETTE_PHASE_CLOSED',
    });

    // 截止緩衝：剩 200ms（< 250ms）拒收
    await vi.advanceTimersByTimeAsync(BETTING - 200);
    expect(await env.service.placeBets(ALICE, { roundId, bets })).toMatchObject({
      ok: false,
      code: 'ROULETTE_PHASE_CLOSED',
    });

    // LOCK 階段拒收
    await vi.advanceTimersByTimeAsync(200);
    expect(env.service.getCurrentPhase()).toBe('LOCK');
    expect(await env.service.placeBets(ALICE, { roundId, bets })).toMatchObject({
      ok: false,
      code: 'ROULETTE_PHASE_CLOSED',
    });
    expect(env.db.users[0]!.balance).toBe(10_000n);
  });

  it('餘額不足 → INSUFFICIENT_BALANCE，佔額回退（重新下小注成功）', async () => {
    const env = track(setup({ users: [{ id: ALICE, balance: 100n }] }));
    const roundId = await startAndFlush(env.service);

    const result = await env.service.placeBets(ALICE, {
      roundId,
      bets: [{ type: 'RED', amount: 200 }],
    });
    expect(result).toMatchObject({ ok: false, code: 'INSUFFICIENT_BALANCE' });
    expect(env.db.users[0]!.balance).toBe(100n);
    expect(env.db.txRecords).toHaveLength(0); // 零落帳

    const retry = await env.service.placeBets(ALICE, {
      roundId,
      bets: [{ type: 'RED', amount: 100 }],
    });
    expect(retry).toMatchObject({ ok: true, ack: { totalBet: 100 } });
  });

  it('注單寫入失敗（rpush 故障）→ 原路退款 + INTERNAL_ERROR（錢不留在系統）', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);
    env.redis.failOn.add('rpush');

    const result = await env.service.placeBets(ALICE, {
      roundId,
      bets: [{ type: 'RED', amount: 500 }],
    });

    expect(result).toMatchObject({ ok: false, code: 'INTERNAL_ERROR' });
    expect(env.db.users[0]!.balance).toBe(10_000n); // BET 後 REFUND 原路退回
    expect(env.db.txRecords.map((tx) => tx.type)).toEqual(['BET', 'REFUND']);
    expect(env.errors.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════ 取消 ═════════════════

describe('cancelBets', () => {
  it('BETTING 內取消：退款 + 結算跳過；取消後再下注照常結算', async () => {
    const env = track(setup({ rngValues: [1] })); // 開 1（紅）
    const roundId = await startAndFlush(env.service);

    await env.service.placeBets(ALICE, { roundId, bets: [{ type: 'BLACK', amount: 300 }] });
    const cancel = await env.service.cancelBets(ALICE, { roundId });
    expect(cancel).toEqual({ ok: true, cancelled: true, refunded: 300 });
    expect(env.db.users[0]!.balance).toBe(10_000n);
    expect(env.db.txRecords.map((tx) => tx.type)).toEqual(['BET', 'REFUND']);

    // 取消後再下注（紅 100，將中獎 200）
    await env.service.placeBets(ALICE, { roundId, bets: [{ type: 'RED', amount: 100 }] });

    await vi.advanceTimersByTimeAsync(BETTING + LOCK);
    const { common, perUser } = env.results[0]!;
    expect(common.totalPool).toBe(100); // 被取消的 300 不計入
    expect(perUser.get(ALICE)).toMatchObject({ totalBet: 100, payout: 200 });
  });

  it('無下注取消 → cancelled=false；非 BETTING → ROULETTE_PHASE_CLOSED', async () => {
    const env = track(setup());
    const roundId = await startAndFlush(env.service);

    expect(await env.service.cancelBets(ALICE, { roundId })).toEqual({
      ok: true,
      cancelled: false,
      refunded: 0,
    });

    await env.service.placeBets(ALICE, { roundId, bets: [{ type: 'RED', amount: 100 }] });
    await vi.advanceTimersByTimeAsync(BETTING); // → LOCK
    expect(await env.service.cancelBets(ALICE, { roundId })).toMatchObject({
      ok: false,
      code: 'ROULETTE_PHASE_CLOSED',
    });
  });
});

// ═════════════════ 結算 ═════════════════

describe('settleRound（RESULT 階段批量結算）', () => {
  it('多人結算：BetRecord + 中獎 credit（refId=BetRecord.id）+ 個人結果 + 統計 + 聊天 + 歷史', async () => {
    const env = track(setup({ rngValues: [7] })); // 7 = 紅 / 奇 / 小 / 第1欄 / 第1打
    const roundId = await startAndFlush(env.service);

    await env.service.placeBets(ALICE, {
      roundId,
      bets: [
        { type: 'RED', amount: 100 },
        { type: 'STRAIGHT', amount: 10, number: 7 },
        { type: 'DOZEN', amount: 30, dozen: 1 },
      ],
    });
    await env.service.placeBets(BOB, {
      roundId,
      bets: [
        { type: 'BLACK', amount: 100 },
        { type: 'HIGH', amount: 50 },
      ],
    });

    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    // 個人結果：alice 贏 200+360+90=650、bob 全輸
    const { common, perUser } = env.results[0]!;
    expect(common).toMatchObject({
      roundId,
      winningNumber: 7,
      color: 'RED',
      totalPool: 290,
      participantCount: 2,
    });
    expect(perUser.get(ALICE)).toEqual({
      totalBet: 140,
      payout: 650,
      newBalance: 10_000n - 140n + 650n,
    });
    expect(perUser.get(BOB)).toEqual({ totalBet: 150, payout: 0, newBalance: 9_850n });

    // BetRecord：每人一筆，gameType=ROULETTE、roundId、seedHash、detail 含注單與開獎
    expect(env.db.betRecords).toHaveLength(2);
    const aliceRecord = env.db.betRecords.find((r) => r.userId === ALICE)!;
    expect(aliceRecord).toMatchObject({
      gameType: 'ROULETTE',
      amount: 140n,
      payout: 650n,
      roundId,
    });
    expect(aliceRecord.serverSeedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(aliceRecord.detail).toMatchObject({ winningNumber: 7, color: 'RED' });

    // 中獎 credit refId 指向 BetRecord；輸家無 PAYOUT Tx
    const payoutTxs = env.db.txRecords.filter((tx) => tx.type === 'PAYOUT');
    expect(payoutTxs).toHaveLength(1);
    expect(payoutTxs[0]).toMatchObject({ userId: ALICE, delta: 650n, refId: aliceRecord.id });

    // 熱門注型：RED 100 / BLACK 100 / HIGH 50（降冪、同額保留入列順序）
    expect(common.hotBets.map((h) => h.type)).toEqual(['RED', 'BLACK', 'HIGH']);

    // 聊天系統訊息：開獎號碼 / 顏色 / 總注
    expect(env.chatMessages).toHaveLength(1);
    expect(env.chatMessages[0]).toContain('7');
    expect(env.chatMessages[0]).toContain('紅');
    expect(env.chatMessages[0]).toContain('290');

    // 歷史寫入（REST /history 可讀）
    const history = await readRouletteHistory(env.redis.redis, { page: 1, limit: 10 });
    expect(history.total).toBe(1);
    expect(history.items[0]).toMatchObject({ roundId, winningNumber: 7, totalPool: 290 });

    // COOLDOWN 快照
    await vi.advanceTimersByTimeAsync(RESULT);
    expect(env.snapshots[0]).toMatchObject({ roundId, totalPool: 290, betsCount: 5 });
  });

  it('開 0（綠）：外圍注全輸、STRAIGHT 0 中 36 倍', async () => {
    const env = track(setup({ rngValues: [0] }));
    const roundId = await startAndFlush(env.service);

    await env.service.placeBets(ALICE, {
      roundId,
      bets: [
        { type: 'RED', amount: 100 },
        { type: 'EVEN', amount: 100 }, // 0 不算偶數（標準規則）
        { type: 'STRAIGHT', amount: 10, number: 0 },
      ],
    });
    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    const { common, perUser } = env.results[0]!;
    expect(common.color).toBe('GREEN');
    expect(perUser.get(ALICE)).toMatchObject({ totalBet: 210, payout: 360 });
  });

  it('無人下注：result 廣播 totalPool=0、不發聊天訊息、零 BetRecord', async () => {
    const env = track(setup());
    await startAndFlush(env.service);
    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    expect(env.results[0]!.common).toMatchObject({ totalPool: 0, participantCount: 0 });
    expect(env.results[0]!.perUser.size).toBe(0);
    expect(env.chatMessages).toHaveLength(0);
    expect(env.db.betRecords).toHaveLength(0);
  });

  it('結算交易失敗 → 全額退款（REFUND）、記錯誤、回合照常推進', async () => {
    const env = track(setup({ rngValues: [7], betRecordCreateThrows: true }));
    const roundId = await startAndFlush(env.service);

    await env.service.placeBets(ALICE, { roundId, bets: [{ type: 'RED', amount: 500 }] });
    await env.service.placeBets(BOB, { roundId, bets: [{ type: 'BLACK', amount: 300 }] });

    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    // 本金退回（BET → REFUND 對沖）、無 BetRecord、無 PAYOUT
    expect(env.db.users[0]!.balance).toBe(10_000n);
    expect(env.db.users[1]!.balance).toBe(10_000n);
    expect(env.db.betRecords).toHaveLength(0);
    expect(env.db.txRecords.filter((tx) => tx.type === 'REFUND')).toHaveLength(2);
    expect(env.results[0]!.perUser.size).toBe(0); // 個人結果清空（personalPayout null 版廣播）
    expect(env.errors.length).toBeGreaterThanOrEqual(1);

    // 機器不死：照常進 COOLDOWN → 新回合
    await vi.advanceTimersByTimeAsync(RESULT + COOLDOWN);
    expect(env.service.getCurrentPhase()).toBe('BETTING');
  });
});

describe('結算容錯（Redis / hooks 故障不殺機器）', () => {
  it('注單讀取故障（lrange）：本回合不結算、記錯誤、回合照常推進', async () => {
    const env = track(setup({ rngValues: [7] }));
    const roundId = await startAndFlush(env.service);
    await env.service.placeBets(ALICE, { roundId, bets: [{ type: 'RED', amount: 100 }] });

    env.redis.failOn.add('lrange');
    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    expect(env.results[0]!.perUser.size).toBe(0);
    expect(env.errors.length).toBeGreaterThanOrEqual(1);

    env.redis.failOn.delete('lrange');
    await vi.advanceTimersByTimeAsync(RESULT + COOLDOWN);
    expect(env.service.getCurrentPhase()).toBe('BETTING'); // 機器不死
  });

  it('phase 廣播 hook 拋錯 / 鏡像寫入故障：僅記警告、狀態機照常運轉', async () => {
    const env = track(setup());
    env.redis.failOn.add('set'); // 鏡像寫入故障
    let thrown = 0;
    const service = createRouletteService({
      prisma: env.db.prisma,
      redis: env.redis.redis,
      wallet: createWalletService(env.db.prisma),
      hooks: {
        onPhase: () => {
          thrown += 1;
          throw new Error('socket down');
        },
        onResult: () => {},
        onSnapshot: () => {},
      },
      log: { warn: () => {} },
      rng: () => 0,
      instanceId: 'broken-hooks',
    });
    activeServices.push(service);

    service.startRound();
    await vi.advanceTimersByTimeAsync(BETTING);

    expect(thrown).toBe(2); // BETTING + LOCK 兩次廣播都拋了，但機器仍轉換
    expect(service.getCurrentPhase()).toBe('LOCK');
  });
});

// ═════════════════ leader 選主 ═════════════════

describe('leader 選主（cluster 單一狀態機）', () => {
  it('兩實例同鎖互斥：僅先取得者跑狀態機；停機後另一實例接手開新回合', async () => {
    const shared = createFakeRedis();
    const a = track(setup({ instanceId: 'worker-a', sharedRedis: shared }));
    const b = track(setup({ instanceId: 'worker-b', sharedRedis: shared }));

    a.service.start();
    await vi.advanceTimersByTimeAsync(0);
    b.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(a.phases.map((p) => p.phase)).toEqual(['BETTING']); // a 是 leader
    expect(b.phases).toHaveLength(0); // b 待命

    await a.service.stop(); // 釋放 leader lock
    expect(shared.store.has('roulette:leader')).toBe(false);

    // b 心跳（4s）後接手，開「新」回合
    await vi.advanceTimersByTimeAsync(4_000);
    expect(b.phases.map((p) => p.phase)).toEqual(['BETTING']);
    expect(b.phases[0]!.roundId).not.toBe(a.phases[0]!.roundId);
  });

  it('Redis 不可用：退化本機 leader，狀態機照常運行（開發單機模式）', async () => {
    const env = track(setup());
    env.redis.failOn.add('set');
    env.redis.failOn.add('get');

    env.service.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(env.service.getCurrentPhase()).toBe('BETTING');
    expect(env.phases.map((p) => p.phase)).toEqual(['BETTING']);
  });
});
