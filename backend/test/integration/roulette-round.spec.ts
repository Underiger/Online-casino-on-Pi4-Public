/**
 * Roulette gateway 整合測試（M15）：gateway × service × fake io/socket，
 * 以 fake timers 驅動完整回合（下注 → 鎖盤 → 開獎 → 結算廣播 → 冷卻）。
 *
 * 與 socket-connection.spec 的分工：該檔以真連線覆蓋握手 / HMAC 中介層
 * （roulette:bet 簽章攔截已在 M08 測畢）；本檔聚焦中介層放行「之後」的
 * gateway 事件處理與廣播路由（bet_ack、user room 個人化 result、except 旁觀者版）。
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

// ─────────────────────────── fake io / socket ───────────────────────────

interface EmitRecord {
  target: 'all' | { to: string } | { except: string[] };
  event: string;
  payload: unknown;
}

function createFakeIo() {
  const emits: EmitRecord[] = [];
  const io = {
    emit(event: string, payload: unknown) {
      emits.push({ target: 'all', event, payload });
    },
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          emits.push({ target: { to: room }, event, payload });
        },
      };
    },
    except(rooms: string[]) {
      return {
        emit(event: string, payload: unknown) {
          emits.push({ target: { except: rooms }, event, payload });
        },
      };
    },
  };
  return { io: io as unknown as GameServer, emits };
}

function createFakeSocket(userId: string) {
  const handlers = new Map<string, (payload: unknown, ack?: unknown) => void>();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const joined: string[] = [];
  const socket = {
    id: `sock_${userId}`,
    data: { userId, role: 'PLAYER' },
    join(room: string) {
      joined.push(room);
    },
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
    on(event: string, handler: (payload: unknown, ack?: unknown) => void) {
      handlers.set(event, handler);
    },
  };
  /** 模擬客戶端 emit（帶 ack），回傳 ack 收到的引數 */
  async function clientEmit(event: string, payload: unknown): Promise<unknown[]> {
    const handler = handlers.get(event);
    if (handler === undefined) throw new Error(`未註冊 handler：${event}`);
    return new Promise((resolve) => {
      handler(payload, (...args: unknown[]) => resolve(args));
    });
  }
  return { socket: socket as unknown as GameSocket, emitted, joined, clientEmit };
}

const fakeApp = (log: { warn: () => void; error: () => void }) =>
  ({ log: { ...log, info: () => {}, debug: () => {} } }) as unknown as FastifyInstance;

// ─────────────────────────── 測試環境 ───────────────────────────

function setup(rngValues: number[] = [0]) {
  const db = createFakeDb({
    users: [
      { id: ALICE, balance: 10_000n },
      { id: BOB, balance: 10_000n },
    ],
  });
  const fakeRedis = createFakeRedis();
  const { io, emits } = createFakeIo();
  const rngQueue = [...rngValues];

  const service = createRouletteService({
    prisma: db.prisma,
    redis: fakeRedis.redis,
    wallet: createWalletService(db.prisma),
    hooks: createRouletteBroadcastHooks(io), // 直接接 fake io：驗證廣播路由
    log: { warn: () => {}, error: () => {} },
    rng: () => rngQueue.shift() ?? 0,
    instanceId: 'gateway-test',
  });

  const { install, owned } = initRouletteGateway(
    fakeApp({ warn: () => {}, error: () => {} }),
    io,
    { service }, // 注入：生命週期由測試掌控
  );

  return { db, fakeRedis, io, emits, service, install, owned };
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

// ─────────────────────────── 測試 ───────────────────────────

describe('roulette gateway 整合（fake io/socket 全回合）', () => {
  it('注入 service 時 owned=false（initSocketServer 不代管生命週期）', () => {
    const env = setup();
    stops.push(() => env.service.stop());
    expect(env.owned).toBe(false);
  });

  it('連線安裝：join user room + 推送當前 phase（中途加入即時同步）', async () => {
    const env = setup();
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);

    const alice = createFakeSocket(ALICE);
    env.install(alice.socket);
    await vi.advanceTimersByTimeAsync(0); // flush getRoundSnapshot().then

    expect(alice.joined).toEqual([userRoom(ALICE)]);
    expect(alice.emitted).toHaveLength(1);
    expect(alice.emitted[0]!.event).toBe(SOCKET_EVENTS.ROULETTE_PHASE);
    expect(alice.emitted[0]!.payload).toMatchObject({ phase: 'BETTING' });
  });

  it('roulette:bet 成功：ack(null) + 個人 bet_ack + 扣款', async () => {
    const env = setup();
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);
    const { roundId } = (await env.service.getRoundSnapshot())!;

    const alice = createFakeSocket(ALICE);
    env.install(alice.socket);

    const ackArgs = await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'RED', amount: 100 }],
    });

    expect(ackArgs).toEqual([null]);
    const betAck = alice.emitted.find((e) => e.event === SOCKET_EVENTS.ROULETTE_BET_ACK);
    expect(betAck!.payload).toEqual({
      accepted: true,
      roundId,
      totalBet: 100,
      remaining: 4_900,
    });
    expect(env.db.users[0]!.balance).toBe(9_900n);
  });

  it('roulette:bet 失敗（roundId 過期）：ack 錯誤碼 + bet_ack accepted=false', async () => {
    const env = setup();
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);

    const alice = createFakeSocket(ALICE);
    env.install(alice.socket);

    const ackArgs = await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId: 'R-stale',
      bets: [{ type: 'RED', amount: 100 }],
    });

    expect(ackArgs).toEqual(['ROULETTE_PHASE_CLOSED']);
    const betAck = alice.emitted.find((e) => e.event === SOCKET_EVENTS.ROULETTE_BET_ACK);
    expect(betAck!.payload).toMatchObject({ accepted: false, roundId: 'R-stale' });
    expect(env.db.users[0]!.balance).toBe(10_000n);
  });

  it('roulette:cancel：ack(null, { cancelled, refunded })', async () => {
    const env = setup();
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);
    const { roundId } = (await env.service.getRoundSnapshot())!;

    const alice = createFakeSocket(ALICE);
    env.install(alice.socket);
    await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'RED', amount: 250 }],
    });

    const ackArgs = await alice.clientEmit(SOCKET_EVENTS.ROULETTE_CANCEL, { roundId });
    expect(ackArgs).toEqual([null, { cancelled: true, refunded: 250 }]);
    expect(env.db.users[0]!.balance).toBe(10_000n);
  });

  it('全回合廣播路由：phase 全服、result 對參與者 user room 個人化、旁觀者走 except', async () => {
    const env = setup([1]); // 開 1（紅）
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);
    const { roundId } = (await env.service.getRoundSnapshot())!;

    const alice = createFakeSocket(ALICE);
    env.install(alice.socket);
    await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'RED', amount: 100 }],
    });

    // BETTING → LOCK → RESULT（結算 + 廣播）
    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    // phase 廣播全部走 io.emit（全服）
    const phaseEmits = env.emits.filter((e) => e.event === SOCKET_EVENTS.ROULETTE_PHASE);
    expect(phaseEmits.map((e) => (e.payload as { phase: string }).phase)).toEqual([
      'BETTING',
      'LOCK',
      'RESULT',
    ]);
    expect(phaseEmits.every((e) => e.target === 'all')).toBe(true);

    // result：alice（參與者）收個人化版本（user room）
    const resultEmits = env.emits.filter((e) => e.event === SOCKET_EVENTS.ROULETTE_RESULT);
    expect(resultEmits).toHaveLength(2);

    const personal = resultEmits.find(
      (e) => typeof e.target === 'object' && 'to' in e.target,
    )!;
    expect(personal.target).toEqual({ to: userRoom(ALICE) });
    expect(personal.payload).toMatchObject({
      roundId,
      winningNumber: 1,
      color: 'RED',
      personalPayout: 200,
      newBalance: (10_000n - 100n + 200n).toString(),
    });

    // 旁觀者：except 參與者房間、personalPayout null
    const spectator = resultEmits.find(
      (e) => typeof e.target === 'object' && 'except' in e.target,
    )!;
    expect(spectator.target).toEqual({ except: [userRoom(ALICE)] });
    expect(spectator.payload).toMatchObject({ personalPayout: null, newBalance: null });

    // COOLDOWN：bets_snapshot 全服
    await vi.advanceTimersByTimeAsync(ROULETTE_PHASE_DURATION_MS.RESULT);
    const snapshot = env.emits.find((e) => e.event === SOCKET_EVENTS.ROULETTE_BETS_SNAPSHOT)!;
    expect(snapshot.target).toBe('all');
    expect(snapshot.payload).toMatchObject({ roundId, totalPool: 100, betsCount: 1 });
  });

  it('無人下注的回合：result 單一全服廣播（不走 except）', async () => {
    const env = setup([5]);
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    const resultEmits = env.emits.filter((e) => e.event === SOCKET_EVENTS.ROULETTE_RESULT);
    expect(resultEmits).toHaveLength(1);
    expect(resultEmits[0]!.target).toBe('all');
    expect(resultEmits[0]!.payload).toMatchObject({
      winningNumber: 5,
      personalPayout: null,
      totalPool: 0,
    });
  });

  it('多人結算：兩位參與者各收自己的個人化 result', async () => {
    const env = setup([2]); // 開 2（黑）
    stops.push(() => env.service.stop());
    env.service.startRound();
    await vi.advanceTimersByTimeAsync(0);
    const { roundId } = (await env.service.getRoundSnapshot())!;

    const alice = createFakeSocket(ALICE);
    const bob = createFakeSocket(BOB);
    env.install(alice.socket);
    env.install(bob.socket);
    await alice.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'BLACK', amount: 100 }],
    });
    await bob.clientEmit(SOCKET_EVENTS.ROULETTE_BET, {
      roundId,
      bets: [{ type: 'RED', amount: 100 }],
    });

    await vi.advanceTimersByTimeAsync(BETTING + LOCK);

    const personalEmits = env.emits.filter(
      (e) => e.event === SOCKET_EVENTS.ROULETTE_RESULT && typeof e.target === 'object' && 'to' in e.target,
    );
    expect(personalEmits).toHaveLength(2);
    const aliceResult = personalEmits.find(
      (e) => (e.target as { to: string }).to === userRoom(ALICE),
    )!;
    const bobResult = personalEmits.find(
      (e) => (e.target as { to: string }).to === userRoom(BOB),
    )!;
    expect(aliceResult.payload).toMatchObject({ personalPayout: 200 }); // 黑中 1:1
    expect(bobResult.payload).toMatchObject({ personalPayout: 0 });

    const spectator = env.emits.find(
      (e) => e.event === SOCKET_EVENTS.ROULETTE_RESULT && typeof e.target === 'object' && 'except' in e.target,
    )!;
    expect((spectator.target as { except: string[] }).except.sort()).toEqual(
      [userRoom(ALICE), userRoom(BOB)].sort(),
    );
  });
});
