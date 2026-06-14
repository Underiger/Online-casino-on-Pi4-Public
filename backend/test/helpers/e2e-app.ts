/**
 * M27 端對端整合測試的 Fastify 組裝器 + 流程工具。
 *
 * 與真實 app.ts 同序組裝安全基座：
 *   錯誤處理 → fp(prisma) + fp(redis) → auth → rate-limit → hmac-guard → auth 路由 → 測試路由。
 *
 * 重點：本組裝器「真的」掛上 plugins/hmac-guard.ts 與 plugins/rate-limit.ts，
 * 搭配 e2e-fakes 的 fake redis（支援 eval/mget/set NX）——讓簽章鏈、防重放、
 * 限流在測試中完整跑過（而非如 slot-spin.spec 般略過 hmac-guard）。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import authPlugin from '../../src/plugins/auth.js';
import rateLimitPlugin from '../../src/plugins/rate-limit.js';
import hmacGuardPlugin from '../../src/plugins/hmac-guard.js';
import authRoutes from '../../src/modules/auth/auth.routes.js';
import { AppError } from '../../src/shared/errors.js';
import { buildCanonical, signCanonical } from '../../src/security/hmac.js';

export interface BuildE2EAppOptions {
  prisma: PrismaClient;
  redis: Redis;
  /** 註冊測試專屬路由（slot / gift-code…）；在 auth 路由之後呼叫 */
  registerRoutes?: (app: FastifyInstance) => Promise<void> | void;
}

export async function buildE2EApp(opts: BuildE2EAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // ── 全域錯誤處理（與 app.ts 同義：AppError / schema 驗證 / 通用 5xx） ──
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if ((err as { validation?: unknown }).validation) {
      return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    const statusCode = err.statusCode ?? 500;
    if (statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: { code: err.code ?? 'BAD_REQUEST', message: err.message } });
    }
    return reply.code(500).send({ error: { code: 'INTERNAL_ERROR', message: '伺服器內部錯誤' } });
  });

  // ── fp(prisma) + fp(redis)：滿足 auth / rate-limit / hmac-guard 的具名依賴 ──
  await app.register(fp(async (instance) => instance.decorate('prisma', opts.prisma), { name: 'prisma' }));
  await app.register(fp(async (instance) => instance.decorate('redis', opts.redis), { name: 'redis' }));

  await app.register(authPlugin);

  // ── 安全基座（與 app.ts 完全一致的設定：先限流再驗章） ──
  await app.register(rateLimitPlugin, {
    allowList: ['/healthz'],
    routeRules: {
      'POST /api/slot/spin': { capacity: 5, refillPerSec: 2 },
      'POST /api/roulette/bet': { capacity: 5, refillPerSec: 2 },
    },
  });
  await app.register(hmacGuardPlugin, {
    allowList: ['/healthz', '/api/auth'],
  });

  await app.register(authRoutes, { prefix: '/api/auth' });

  if (opts.registerRoutes !== undefined) {
    await opts.registerRoutes(app);
  }

  await app.ready();
  return app;
}

// ═══════════════════════════════════════════════════════════════════════════
// 流程工具
// ═══════════════════════════════════════════════════════════════════════════

export interface Session {
  userId: string;
  accessToken: string;
  refreshToken: string;
  hmacKey: string;
}

/** 真實走 POST /api/auth/register + /login，回傳會話（含 HMAC 金鑰） */
export async function registerAndLogin(
  app: FastifyInstance,
  username: string,
  password = 'Passw0rd!',
): Promise<Session> {
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password },
  });
  if (reg.statusCode !== 201) {
    throw new Error(`register 失敗（${reg.statusCode}）：${reg.body}`);
  }
  const { userId } = reg.json() as { userId: string };

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
  if (login.statusCode !== 200) {
    throw new Error(`login 失敗（${login.statusCode}）：${login.body}`);
  }
  const body = login.json() as { accessToken: string; refreshToken: string; hmacKey: string };
  return {
    userId,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    hmacKey: body.hmacKey,
  };
}

export interface SpinPacket {
  betAmount: number;
  sig: string;
  nonce: string;
  ts: number;
  seq: number;
}

/** 以會話金鑰簽出一個 slot:spin canonical（gameType=SLOT） */
export function signSlotSpin(
  session: Session,
  params: { betAmount: number; nonce: string; ts?: number; seq: number },
): SpinPacket {
  const ts = params.ts ?? Date.now();
  const canonical = buildCanonical({
    userId: session.userId,
    gameType: 'SLOT',
    betAmount: params.betAmount,
    nonce: params.nonce,
    timestamp: ts,
  });
  const sig = signCanonical(session.hmacKey, canonical);
  return { betAmount: params.betAmount, sig, nonce: params.nonce, ts, seq: params.seq };
}

/** 將簽章封包拆成 HTTP 標頭（x-sig/x-nonce/x-ts/x-seq + Bearer） */
export function spinHeaders(session: Session, packet: SpinPacket): Record<string, string> {
  return {
    authorization: `Bearer ${session.accessToken}`,
    'x-sig': packet.sig,
    'x-nonce': packet.nonce,
    'x-ts': String(packet.ts),
    'x-seq': String(packet.seq),
  };
}

/** 等待 fire-and-forget（如 IllegalPacketLog 落庫）排空的 macrotask */
export function flushAsync(ms = 10): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
