/**
 * Socket.IO 中介層（02_TDD §2/§5、04_FOLDER_STRUCTURE §1 sockets/middleware.ts）：
 *
 * 1. createConnectionGauge — 跨 worker 連線計數：
 *    每個 worker 將自身連線數寫入 Redis `socket:conns:{instanceId}`（EX 90s，
 *    30s 心跳續期——worker 崩潰後鍵自然過期，計數自癒不漂移）；
 *    握手時 SCAN 加總所有 worker 得全域連線數。Redis 不可用 → 退化為本地計數
 *    （開發模式可接受；生產 Redis 由 redis plugin fail loud 保證存在）。
 *
 * 2. createHandshakeAuth — 握手驗證（io.use）：
 *    a. JWT：auth.token 或 query.token，驗證後綁定 socket.data.{userId,role}
 *    b. 連線上限：全域 ≥ 上限（預設 200）→ 拒絕握手，client 收到
 *       connect_error('server_full')（02_TDD §8：「全域連線數 > 200 拒絕新握手」）
 *
 * 3. createGameEventGuard — 遊戲事件 HMAC 簽章驗證（socket.use 封包中介層）：
 *    與 HTTP 層 plugins/hmac-guard.ts 共用 security/（hmac.ts + nonce.ts），
 *    驗證順序相同：欄位齊備 → 時間窗 ±5s → betAmount 萃取 → 簽章
 *    （current + prev 兩把金鑰）→ nonce（簽章合法後才消耗）→ seq 嚴格遞增。
 *    任一步失敗：IllegalPacketLog 落庫（fire-and-forget）+ ack 回錯誤碼，
 *    封包不進入事件 handler。Redis 故障：開發放行、生產 fail-closed。
 */
import { hostname } from 'node:os';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { PacketViolation } from '@prisma/client';
import { env } from '../config/env.js';
import type { JwtPayload } from '../plugins/auth.js';
import type { PacketViolationCode } from '../shared/errors.js';
import {
  HMAC_TIMESTAMP_TOLERANCE_MS,
  buildCanonical,
  verifySignature,
} from '../security/hmac.js';
import { createReplayGuard } from '../security/nonce.js';
import { createIllegalPacketService } from '../modules/audit/illegal-packet.service.js';
import { rngToken } from '../security/csprng.js';
import { SOCKET_EVENTS, type GameSocket } from './events.js';

// ═════════════════ 1. 跨 worker 連線計數 ═════════════════

/** 每 worker 計數鍵 TTL；心跳每 30s 續期，3 次心跳沒到（worker 死亡）即自動出列 */
const CONN_KEY_TTL_SECONDS = 90;
const CONN_HEARTBEAT_MS = 30_000;
/** 預設鍵前綴（測試可換前綴隔離） */
export const CONN_KEY_PREFIX = 'socket:conns';

export interface ConnectionGaugeOptions {
  redis: Redis;
  /** 本 worker 當前連線數來源（通常為 () => io.of('/').sockets.size） */
  localCount: () => number;
  /** 鍵前綴，預設 'socket:conns'（整合測試傳入隨機前綴互相隔離） */
  keyPrefix?: string;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

export interface ConnectionGauge {
  /** 全域連線數（所有 worker 加總）；Redis 不可用時退化為本地計數 */
  globalCount(): Promise<number>;
  /** 將本 worker 連線數發布至 Redis（fire-and-forget，連線增減時呼叫） */
  publish(): void;
  /** 啟動 30s 心跳續期（interval 已 unref，不阻止進程退出） */
  start(): void;
  /** 停止心跳並刪除本 worker 計數鍵（graceful shutdown 時呼叫） */
  stop(): void;
}

export function createConnectionGauge(opts: ConnectionGaugeOptions): ConnectionGauge {
  const prefix = opts.keyPrefix ?? CONN_KEY_PREFIX;
  // 唯一實例 ID：hostname + pid + 隨機尾碼（同進程多實例——如測試——也不互撞）
  const instanceId = `${hostname()}:${process.pid}:${rngToken(4)}`;
  const ownKey = `${prefix}:${instanceId}`;
  let timer: NodeJS.Timeout | null = null;

  // Redis 斷線重連期間 ioredis 會把命令排入 offline queue 等待——
  // 握手路徑不可被它拖慢，未 ready 一律直接走本地計數
  const redisReady = (): boolean => opts.redis.status === 'ready';

  function publish(): void {
    if (!redisReady()) return;
    opts.redis
      .set(ownKey, String(opts.localCount()), 'EX', CONN_KEY_TTL_SECONDS)
      .catch(() => {
        /* Redis 不可用：本地計數仍有效，握手時 globalCount 自動退化 */
      });
  }

  return {
    async globalCount(): Promise<number> {
      if (!redisReady()) return opts.localCount();
      try {
        const keys: string[] = [];
        let cursor = '0';
        do {
          const [next, batch] = await opts.redis.scan(
            cursor,
            'MATCH',
            `${prefix}:*`,
            'COUNT',
            100,
          );
          cursor = next;
          keys.push(...batch);
        } while (cursor !== '0');

        let total = opts.localCount(); // 本地以即時值為準（Redis 內的自身鍵跳過）
        if (keys.length > 0) {
          const values = await opts.redis.mget(keys);
          for (let i = 0; i < keys.length; i += 1) {
            if (keys[i] === ownKey) continue;
            const count = Number(values[i] ?? 0);
            if (Number.isFinite(count) && count > 0) total += count;
          }
        }
        return total;
      } catch (err) {
        opts.log?.warn(
          { err: (err as Error).message },
          'socket gauge: redis 不可用，連線上限退化為單 worker 本地計數',
        );
        return opts.localCount();
      }
    },

    publish,

    start(): void {
      if (timer !== null) return;
      publish();
      timer = setInterval(publish, CONN_HEARTBEAT_MS);
      timer.unref();
    },

    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (!redisReady()) return;
      opts.redis.del(ownKey).catch(() => {
        /* 刪不掉也會隨 TTL 過期 */
      });
    },
  };
}

// ═════════════════ 2. 握手驗證（JWT + 連線上限） ═════════════════

type HandshakeMiddleware = (socket: GameSocket, next: (err?: Error) => void) => void;

/** 握手拒絕錯誤：client 於 connect_error 收到 message（data.code 供程式判斷） */
function handshakeError(message: string, code: string): Error {
  return Object.assign(new Error(message), { data: { code } });
}

function tokenOf(socket: GameSocket): string | undefined {
  const auth = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof auth === 'string' && auth.length > 0) return auth;
  const query = socket.handshake.query['token'];
  if (typeof query === 'string' && query.length > 0) return query;
  return undefined;
}

export function createHandshakeAuth(
  app: FastifyInstance,
  gauge: ConnectionGauge,
  maxConnections: number,
): HandshakeMiddleware {
  return (socket, next) => {
    // ── JWT（先驗身份再查全域計數：未認證流量不消耗 Redis 往返） ──
    const token = tokenOf(socket);
    if (token === undefined) {
      next(handshakeError('缺少存取權杖（auth.token）', 'UNAUTHORIZED'));
      return;
    }
    let payload: JwtPayload;
    try {
      payload = app.jwt.verify<JwtPayload>(token);
    } catch {
      next(handshakeError('存取權杖無效或已過期', 'UNAUTHORIZED'));
      return;
    }
    socket.data.userId = payload.sub;
    socket.data.role = payload.role;

    // ── 連線上限（02_TDD §8：全域 ≥ 200 拒絕新握手，回 server_full） ──
    gauge
      .globalCount()
      .then((count) => {
        if (count >= maxConnections) {
          app.log.warn(
            { count, maxConnections, userId: payload.sub },
            'socket: 連線數已達上限，拒絕新握手',
          );
          next(handshakeError(SOCKET_EVENTS.SERVER_FULL, 'SERVER_FULL'));
          return;
        }
        next();
      })
      .catch((err: unknown) => {
        // globalCount 內部已對 Redis 故障退化，此處僅防未知例外
        app.log.error({ err }, 'socket: 連線計數失敗，放行握手（計數屬輔助防線）');
        next();
      });
  };
}

// ═════════════════ 3. 遊戲事件 HMAC 簽章驗證 ═════════════════

/** 受簽章保護的 Socket 事件（凍結於 docs/04_API_SPEC.md §4.2：slot:spin、roulette:bet） */
interface SignedEventSpec {
  gameType: 'SLOT' | 'ROULETTE';
  /** 從事件 payload 萃取 betAmount（canonical 完整性綁定的注額） */
  betAmount: (payload: unknown) => number;
}

export const SIGNED_SOCKET_EVENTS: Record<string, SignedEventSpec> = {
  [SOCKET_EVENTS.SLOT_SPIN]: {
    gameType: 'SLOT',
    betAmount: (payload) => Number((payload as { betAmount?: unknown } | null)?.betAmount),
  },
  [SOCKET_EVENTS.ROULETTE_BET]: {
    gameType: 'ROULETTE',
    // canonical 用總注額：bets[].amount 整數加總（docs/04_API_SPEC.md §4.2）
    betAmount: (payload) => {
      const bets = (payload as { bets?: unknown } | null)?.bets;
      if (!Array.isArray(bets) || bets.length === 0) return Number.NaN;
      let total = 0;
      for (const bet of bets) {
        const amount = Number((bet as { amount?: unknown } | null)?.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0) return Number.NaN;
        total += amount;
      }
      return total;
    },
  },
};

interface GuardVerdict {
  ok: boolean;
  /** ack 第一參數回傳的錯誤碼 */
  code?: PacketViolationCode | 'INTERNAL_ERROR';
  /** IllegalPacketLog 落庫的違規類型（INTERNAL_ERROR 不落庫） */
  violation?: PacketViolation;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sampleOf(payload: unknown): string | null {
  try {
    const json = JSON.stringify(payload);
    return typeof json === 'string' ? json.slice(0, 1_024) : null;
  } catch {
    return null;
  }
}

/**
 * 回傳「為單一 socket 安裝封包中介層」的安裝器。
 * 驗證邏輯與 plugins/hmac-guard.ts 同序同義（02_TDD §5.2/5.3 一體適用）。
 */
export function createGameEventGuard(app: FastifyInstance): (socket: GameSocket) => void {
  const replay = createReplayGuard(app.redis);
  const illegalPackets = createIllegalPacketService(app.prisma, app.log);

  /** Redis 故障：開發放行（警告）、生產 fail-closed（防重放不可降級） */
  function redisUnavailable(err: unknown): GuardVerdict {
    if (env.NODE_ENV === 'production') {
      app.log.error({ err }, 'socket hmac: redis 不可用，拒絕封包（fail-closed）');
      return { ok: false, code: 'INTERNAL_ERROR' };
    }
    app.log.warn(
      { err: (err as Error).message },
      'socket hmac: redis 不可用，開發模式跳過簽章驗證',
    );
    return { ok: true };
  }

  async function verify(
    userId: string,
    spec: SignedEventSpec,
    payload: unknown,
  ): Promise<GuardVerdict> {
    // ── 欄位齊備（payload 必須是物件且帶 sig/nonce/ts/seq） ──
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, code: 'ERR_BAD_SIGNATURE', violation: 'BAD_SIGNATURE' };
    }
    const fields = payload as Record<string, unknown>;
    const sig = stringField(fields, 'sig');
    const nonce = stringField(fields, 'nonce');
    if (sig === undefined || nonce === undefined) {
      return { ok: false, code: 'ERR_BAD_SIGNATURE', violation: 'BAD_SIGNATURE' };
    }

    // ── 時間窗 ±5s ──
    const ts = Number(fields['ts']);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > HMAC_TIMESTAMP_TOLERANCE_MS) {
      return { ok: false, code: 'ERR_STALE_REQUEST', violation: 'STALE_TIMESTAMP' };
    }

    // ── betAmount（canonical 完整性綁定） ──
    const betAmount = spec.betAmount(payload);
    if (!Number.isSafeInteger(betAmount) || betAmount < 0) {
      return { ok: false, code: 'ERR_BAD_SIGNATURE', violation: 'BAD_SIGNATURE' };
    }

    // ── 簽章（current + prev 兩把金鑰，timingSafeEqual） ──
    let keys: string[];
    try {
      keys = await app.hmacKeys.getActiveKeys(userId);
    } catch (err) {
      return redisUnavailable(err);
    }
    if (keys.length === 0) {
      return { ok: false, code: 'ERR_BAD_SIGNATURE', violation: 'BAD_SIGNATURE' };
    }
    const canonical = buildCanonical({
      userId,
      gameType: spec.gameType,
      betAmount,
      nonce,
      timestamp: ts,
    });
    if (!verifySignature(keys, canonical, sig)) {
      return { ok: false, code: 'ERR_BAD_SIGNATURE', violation: 'BAD_SIGNATURE' };
    }

    // ── Nonce（簽章合法後才消耗——偽造封包燒不掉合法 nonce/seq） ──
    let nonceFresh: boolean;
    try {
      nonceFresh = await replay.checkNonce(userId, nonce);
    } catch (err) {
      return redisUnavailable(err);
    }
    if (!nonceFresh) {
      return { ok: false, code: 'ERR_NONCE_REPLAY', violation: 'NONCE_REPLAY' };
    }

    // ── Seq 嚴格遞增 ──
    const seq = Number(fields['seq']);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      return { ok: false, code: 'ERR_SEQ_REGRESSION', violation: 'SEQ_REGRESSION' };
    }
    let seqOk: boolean;
    try {
      seqOk = await replay.checkSeq(userId, seq);
    } catch (err) {
      return redisUnavailable(err);
    }
    if (!seqOk) {
      return { ok: false, code: 'ERR_SEQ_REGRESSION', violation: 'SEQ_REGRESSION' };
    }

    return { ok: true };
  }

  return function install(socket: GameSocket): void {
    socket.use((packet, next) => {
      const [event, payload] = packet as [string, unknown, ...unknown[]];
      const spec = SIGNED_SOCKET_EVENTS[event];
      if (spec === undefined) {
        next();
        return;
      }
      // 帶 ack 的 emit 其回呼為 packet 最後一個元素（socket.io 於中介層前已附加）
      const last: unknown = packet[packet.length - 1];
      const ack = typeof last === 'function' ? (last as (err: string) => void) : null;

      verify(socket.data.userId, spec, payload)
        .then((verdict) => {
          if (verdict.ok) {
            next();
            return;
          }
          if (verdict.violation !== undefined) {
            illegalPackets.record({
              userId: socket.data.userId,
              ip: socket.handshake.address,
              violation: verdict.violation,
              endpoint: `SOCKET ${event}`,
              rawSample: sampleOf(payload),
            });
          }
          // 不呼叫 next()：封包不進入事件 handler；錯誤碼經 ack 回傳
          ack?.(verdict.code ?? 'ERR_BAD_SIGNATURE');
        })
        .catch((err: unknown) => {
          app.log.error({ err, event }, 'socket hmac: 驗證流程未知例外，封包丟棄');
          ack?.('INTERNAL_ERROR');
        });
    });
  };
}
