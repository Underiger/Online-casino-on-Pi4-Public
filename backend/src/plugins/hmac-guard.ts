/**
 * hmac-guard plugin（02_TDD §5.2/5.3）：下注敏感路由的全域 preHandler。
 *
 * 驗證順序（先便宜後昂貴，狀態變更放最後）：
 *   1. 路由比對：僅 signedRoutes 內的路由受檢；allowList 一律放行
 *   2. JWT（canonical 的 userId 來自已驗證的 token，不信任 payload）
 *   3. 標頭齊備：x-sig / x-nonce / x-ts / x-seq
 *   4. 時間窗：|now - x-ts| ≤ 5000ms
 *   5. 簽章：timingSafeEqual 比對 current + prev（30s 輪換寬限）兩把金鑰
 *   6. Nonce：SET NX EX 10（簽章合法後才消耗——偽造封包不得燒掉合法 nonce/seq）
 *   7. Seq：Lua 原子嚴格遞增
 *
 * 任一步失敗：IllegalPacketLog 落庫（fire-and-forget）+ 400 PacketViolationError。
 * Redis 不可用：開發模式警告放行；生產模式 fail-closed（防重放不可降級）。
 */
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import type { PacketViolation } from '@prisma/client';
import { env } from '../config/env.js';
import {
  InternalError,
  PacketViolationError,
  UnauthorizedError,
  type PacketViolationCode,
} from '../shared/errors.js';
import {
  HMAC_TIMESTAMP_TOLERANCE_MS,
  buildCanonical,
  verifySignature,
} from '../security/hmac.js';
import { createReplayGuard } from '../security/nonce.js';
import { createIllegalPacketService } from '../modules/audit/illegal-packet.service.js';

// ─────────────────────────── 路由設定 ───────────────────────────

export interface SignedRouteSpec {
  /** canonical 的 gameType 欄位 */
  gameType: 'SLOT' | 'ROULETTE';
  /** 從已解析 body 萃取 betAmount（canonical 完整性綁定的注額） */
  betAmount: (body: unknown) => number;
}

/**
 * 受簽章保護的路由（規格凍結於 docs/04_API_SPEC.md §1.4）。
 * M11 / M15 實作對應路由時即自動受檢，無需回頭改本 plugin。
 */
export const DEFAULT_SIGNED_ROUTES: Record<string, SignedRouteSpec> = {
  'POST /api/slot/spin': {
    gameType: 'SLOT',
    betAmount: (body) => Number((body as { betAmount?: unknown } | null)?.betAmount),
  },
  'POST /api/roulette/bet': {
    gameType: 'ROULETTE',
    // canonical 用總注額：bets[].amount 整數加總（docs/04_API_SPEC.md §4.2）
    betAmount: (body) => {
      const bets = (body as { bets?: unknown } | null)?.bets;
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

export interface HmacGuardOptions {
  /** 路徑前綴白名單：一律跳過簽章檢查 */
  allowList?: string[];
  /** 覆寫受保護路由表（預設 DEFAULT_SIGNED_ROUTES） */
  signedRoutes?: Record<string, SignedRouteSpec>;
}

// ─────────────────────────── plugin ───────────────────────────

function headerOf(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sampleOf(body: unknown): string | null {
  try {
    const json = JSON.stringify(body);
    return typeof json === 'string' ? json.slice(0, 1_024) : null;
  } catch {
    return null;
  }
}

export default fp<HmacGuardOptions>(
  async (app, opts) => {
    const allowList = opts.allowList ?? [];
    const signedRoutes = opts.signedRoutes ?? DEFAULT_SIGNED_ROUTES;
    const replay = createReplayGuard(app.redis);
    const illegalPackets = createIllegalPacketService(app.prisma, app.log);

    /** Redis 故障：開發放行（警告）、生產 fail-closed */
    function redisUnavailable(request: FastifyRequest, err: unknown): void {
      if (env.NODE_ENV === 'production') {
        request.log.error({ err }, 'hmac-guard: redis 不可用，拒絕請求（fail-closed）');
        throw new InternalError('安全驗證暫時不可用，請稍後再試');
      }
      request.log.warn(
        { err: (err as Error).message },
        'hmac-guard: redis 不可用，開發模式跳過簽章驗證',
      );
    }

    app.addHook('preHandler', async (request, _reply) => {
      const path = request.routeOptions.url ?? request.url;
      const routeKey = `${request.method} ${path}`;
      const spec = signedRoutes[routeKey];
      if (spec === undefined) return;
      if (allowList.some((prefix) => path.startsWith(prefix))) return;

      // ── JWT（全域 preHandler 先於路由層 authenticate，須自行驗證） ──
      if (!request.user) {
        try {
          await request.jwtVerify();
        } catch {
          throw new UnauthorizedError('存取權杖無效或已過期');
        }
      }
      const userId = request.user.sub;

      const reject = (
        violation: PacketViolation,
        code: PacketViolationCode,
        message: string,
      ): PacketViolationError => {
        illegalPackets.record({
          userId,
          ip: request.ip,
          violation,
          endpoint: routeKey,
          rawSample: sampleOf(request.body),
        });
        return new PacketViolationError(code, message);
      };

      // ── 標頭齊備 ──
      const sig = headerOf(request, 'x-sig');
      const nonce = headerOf(request, 'x-nonce');
      const tsRaw = headerOf(request, 'x-ts');
      const seqRaw = headerOf(request, 'x-seq');
      if (!sig || !nonce || !tsRaw || !seqRaw) {
        throw reject('BAD_SIGNATURE', 'ERR_BAD_SIGNATURE', '缺少簽章標頭（x-sig/x-nonce/x-ts/x-seq）');
      }

      // ── 時間窗 ──
      const ts = Number(tsRaw);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > HMAC_TIMESTAMP_TOLERANCE_MS) {
        throw reject('STALE_TIMESTAMP', 'ERR_STALE_REQUEST', '請求時間戳無效或超出容忍窗');
      }

      // ── betAmount（canonical 完整性綁定） ──
      const betAmount = spec.betAmount(request.body);
      if (!Number.isSafeInteger(betAmount) || betAmount < 0) {
        throw reject('BAD_SIGNATURE', 'ERR_BAD_SIGNATURE', '注額欄位無效，無法重組 canonical');
      }

      // ── 簽章 ──
      let keys: string[];
      try {
        keys = await app.hmacKeys.getActiveKeys(userId);
      } catch (err) {
        redisUnavailable(request, err);
        return; // 開發模式放行
      }
      if (keys.length === 0) {
        throw reject('BAD_SIGNATURE', 'ERR_BAD_SIGNATURE', 'HMAC 金鑰不存在或已失效，請重新登入');
      }
      const canonical = buildCanonical({
        userId,
        gameType: spec.gameType,
        betAmount,
        nonce,
        timestamp: ts,
      });
      if (!verifySignature(keys, canonical, sig)) {
        throw reject('BAD_SIGNATURE', 'ERR_BAD_SIGNATURE', '簽章驗證失敗');
      }

      // ── Nonce（簽章合法後才消耗） ──
      let nonceFresh: boolean;
      try {
        nonceFresh = await replay.checkNonce(userId, nonce);
      } catch (err) {
        redisUnavailable(request, err);
        return;
      }
      if (!nonceFresh) {
        throw reject('NONCE_REPLAY', 'ERR_NONCE_REPLAY', '偵測到重放封包（nonce 重複）');
      }

      // ── Seq ──
      const seq = Number(seqRaw);
      if (!Number.isSafeInteger(seq) || seq < 0) {
        throw reject('SEQ_REGRESSION', 'ERR_SEQ_REGRESSION', '序號格式無效');
      }
      let seqOk: boolean;
      try {
        seqOk = await replay.checkSeq(userId, seq);
      } catch (err) {
        redisUnavailable(request, err);
        return;
      }
      if (!seqOk) {
        throw reject('SEQ_REGRESSION', 'ERR_SEQ_REGRESSION', '序號倒退或重複，封包已拒絕');
      }
    });
  },
  { name: 'hmac-guard', dependencies: ['redis', 'prisma', 'auth'] },
);
