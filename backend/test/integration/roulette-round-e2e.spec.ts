/**
 * M27 輪盤全流程 E2E 整合測試（結算與帳目落地）。
 *
 * 與 roulette-round.spec.ts 的分工：
 *   roulette-round.spec.ts 聚焦「廣播路由」（phase 全服、result 個人化 user room、
 *   旁觀者 except 版）。本檔聚焦「一局完整資金流與持久化」：
 *     下注（即時扣款）→ 鎖盤 → 開獎 → 結算 →
 *     中獎者 wallet.credit 回收、未中者僅扣款，且每位參與者落一筆
 *     BetRecord(gameType=ROULETTE, roundId)。
 *
 * 以 vi.useFakeTimers 驅動回合時序；rng 注入決定開獎號（1＝紅）。
 * 環境假設：無需 PG / Redis（slot-fakes in-memory）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  createRouletteBroadcastHooks,
  initRouletteGateway,
  userRoom,
} from '../../src/modules/roulette/roulette.gateway.js';
import { createRouletteService } from '../../src/modules/roulette/roulette.service.js';
import { ROULETTE_PHASE_DURATION_MS } from '../../src/modules/roulette/roulette.types.js';
import { createWalletService } from '../../src/modules/wallet/wallet.service.js';
import { SOCKET_EVENTS, type GameServer, type GameSocket } from '../../src/sockets/events.js';
import { createFakeDb, createFakeRedis } from '../helpers/slot-fakes.js';

const ALICE = 'user_alice';
const BOB = 'user_bob';
const { BETTING, LOCK } = ROULETTE_PHASE_DURATION_MS;

// ─────────────────────────── fake io / socket（與 roulette-round.spec 同款，壓縮版） ───────────────────────────

function createFakeIo() {
  const io = {
    emit() {},
    to() {
      return { emit() {} };
    },
    except() {
      return { emit() {} };
    },
  };
  return io as unknown as GameServer;
}

function createFakeSocket(userId: string) {
  const handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  const socket = {
    id: `sock_${userId}`,
    data: { userId, role: 'PLAYER' },
    join() {},
    emit() {},
    on(event: string, handler: (payload: unknown, ack?: unknown) => void) {
      handlers.set(event, handler);
    },
  };
  async function clientEmit(event: string, payload: unknown): Promise<unknown[]> {
    const handler = handlers.get(event);
    if (handler === undefined) throw new Error(`未註冊 handler：${event}`);
    return new Promise((resolve) => {
      handler(payload, (...args: unknown[]) => resolve(args));
    });
  }
  return { socket: socket as unknown as GameSocket, clientEmit };
}

const fakeApp = () =>
  ({ log: { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} } }) as unknown as FastifyInstance;

function setup(rngValues: number[]) {
  const db = createFakeDb({
    users: [
      { id: ALICE, balance: 10_000n },
      { id: BOB, balance: 10_000n },
    ],
  });
  const fakeRedis = createFakeRedis();
  const io = createFakeIo();
  const rngQueue = [...rngValues];

  const service = createRouletteService({
    prisma: db.prisma,
    redis: fakeRedis.redis,
    wallet: createWalletService(db.prisma),
    hooks: createRouletteBroadcastHooks(io),
    log: { warn: () => {}, error: () => {} },
    rng: () => rngQueue.shift() ?? 0,
    instanceId: 'e2e-roulette',
  });

  const { install } = initRouletteGateway(fakeApp(), io, { service });
  return { db, service, install };
}

let stops: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  stops = [];
});

afterEach(async () => {
  for (const stop of stops) await stop();
  vi.useRealTimers();
});

describe('輪盤全流程 E2E：下注 → 鎖盤 → 開獎 → 結算 → 帳目落地', () => {
  it('開獎 1（紅）：紅注中獎回收、黑注僅扣款，雙方各落一筆 BetRecord(ROULETTE)', async () => {
    const env = setup([1]); // LOCK 時 rngInt(37) → 1（紅）
    stops.push(() => env.service.stop());

    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);
    const snapshot = await env.service.getRoundSnapshot();
    expect(snapshot).not.toBeNull();
    const { roundId } = snapshot!;

    const alice = createFakeSocket(ALICE);
    const bob = createFakeSocket(BOB);
    env.install(alice.socket);
    env.install(bob.socket);

    // Alice 下注紅 100（將中獎）；Bob 下注黑 100（將落空）
    const aliceAck = await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'RED', amount: 100 }],
    });
    const bobAck = await bob.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'BLACK', amount: 100 }],
    });
    expect(aliceAck).toEqual([null]);
    expect(bobAck).toEqual([null]);

    // 下注即時扣款：兩人各 10000 → 9900
    expect(env.db.users.find((u) => u.id === ALICE)!.balance).toBe(9_900n);
    expect(env.db.users.find((u) => u.id === BOB)!.balance).toBe(9_900n);

    // BETTING → LOCK → RESULT（結算）
    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    // 結算後：Alice 紅中（回收 2× = 200）→ 9900 + 200 = 10100；Bob 黑落空 → 9900
    expect(env.db.users.find((u) => u.id === ALICE)!.balance).toBe(10_100n);
    expect(env.db.users.find((u) => u.id === BOB)!.balance).toBe(9_900n);

    // 每位參與者各落一筆 ROULETTE BetRecord，且帶 roundId
    const roundBets = env.db.betRecords.filter((b) => b.gameType === 'ROULETTE');
    expect(roundBets).toHaveLength(2);
    expect(roundBets.every((b) => b.roundId === roundId)).toBe(true);
    expect(roundBets.map((b) => b.userId).sort()).toEqual([ALICE, BOB].sort());

    // 帳目：Alice 有一筆正向回收 tx（+200）；Bob 無任何正向 tx
    const alicePos = env.db.txRecords.filter((t) => t.userId === ALICE && t.delta > 0n);
    const bobPos = env.db.txRecords.filter((t) => t.userId === BOB && t.delta > 0n);
    expect(alicePos.some((t) => t.delta === 200n)).toBe(true);
    expect(bobPos).toHaveLength(0);
  });

  it('全帳守恆：本金與回收之和等於餘額淨變動（單注中獎）', async () => {
    const env = setup([1]); // 紅
    stops.push(() => env.service.stop());

    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);
    const { roundId } = (await env.service.getRoundSnapshot())!;

    const alice = createFakeSocket(ALICE);
    env.install(alice.socket);
    await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'STRAIGHT', amount: 100, number: 1 }], // 直注 1 號，命中 → 36× 回收
    });

    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    // STRAIGHT 命中回收 36× = 3600：10000 - 100 + 3600 = 13500
    expect(env.db.users.find((u) => u.id === ALICE)!.balance).toBe(13_500n);

    // BalanceTransaction 全帳回放：所有 delta 之和 == 餘額淨變動（+3500）
    const sumDelta = env.db.txRecords
      .filter((t) => t.userId === ALICE)
      .reduce((acc, t) => acc + t.delta, 0n);
    expect(sumDelta).toBe(3_500n);
  });
});
