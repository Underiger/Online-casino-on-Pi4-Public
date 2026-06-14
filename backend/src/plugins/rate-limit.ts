/**
 * rate-limit plugin（02_TDD：API 層令牌桶，Nginx limit_req 之後的第二道）。
 *
 * - 演算法：令牌桶（capacity = 突發上限、refillPerSec = 穩態速率），
 *   Redis Lua 原子執行——跨 cluster worker 共享計數。
 * - 計數維度：每使用者（JWT sub；未登入以 IP 代替）× 每路由分桶。
 * - 預設 10 req/s、burst 20（與 Nginx ratelimit.conf 對齊）；可依路由覆寫。
 * - Redis 不可用：fail-open（記錯誤日誌放行）——限流屬可降級防護，
 *   第一道 Nginx 限流仍在；與 hmac-guard 的 fail-closed 策略刻意不同。
 */
import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { RateLimitError } from '../shared/errors.js';

// ─────────────────────────── 純函式（單元測試直接覆蓋；Lua 與此同義） ───────────────────────────

export interface BucketRule {
  /** 桶容量（突發上限） */
  capacity: number;
  /** 每秒補充令牌數（穩態速率） */
  refillPerSec: number;
}

export interface BucketState {
  tokens: number;
  /** 上次補充時間（epoch ms） */
  updatedAt: number;
}

export interface ConsumeResult {
  allowed: boolean;
  state: BucketState;
  /** 拒絕時：估計多久後有足夠令牌（毫秒）；允許時為 0 */
  retryAfterMs: number;
}

/** 令牌桶取令牌；state 為 null 代表新桶（滿桶起算） */
export function consumeToken(
  state: BucketState | null,
  rule: BucketRule,
  nowMs: number,
  cost = 1,
): ConsumeResult {
  let tokens = state?.tokens ?? rule.capacity;
  const updatedAt = state?.updatedAt ?? nowMs;
  const elapsedMs = Math.max(0, nowMs - updatedAt); // 時鐘回撥視為 0，不倒扣
  tokens = Math.min(rule.capacity, tokens + (elapsedMs / 1_000) * rule.refillPerSec);

  if (tokens >= cost) {
    return {
      allowed: true,
      state: { tokens: tokens - cost, updatedAt: nowMs },
      retryAfterMs: 0,
    };
  }
  return {
    allowed: false,
    state: { tokens, updatedAt: nowMs },
    retryAfterMs: Math.ceil(((cost - tokens) / rule.refillPerSec) * 1_000),
  };
}

// ─────────────────────────── Redis Lua（與 consumeToken 同義的原子版本） ───────────────────────────

/**
 * KEYS[1] = 桶鍵；ARGV = capacity, refillPerSec, now(ms), cost
 * 回傳 {allowed(0|1), retryAfterMs}
 */
export const TOKEN_BUCKET_LUA = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local tokens = tonumber(redis.call('HGET', KEYS[1], 't'))
local updated = tonumber(redis.call('HGET', KEYS[1], 'ts'))
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end

local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = tokens + elapsed / 1000 * rate
if tokens > capacity then tokens = capacity end

local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry = math.ceil((cost - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 't', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 2000) + 1000)
return {allowed, retry}
`;

// ─────────────────────────── plugin ───────────────────────────

export interface RateLimitOptions {
  /** 預設規則：10 req/s、burst 20（與 nginx/conf.d/ratelimit.conf 對齊） */
  defaultRule?: BucketRule;
  /** 依路由覆寫：key 為 `${METHOD} ${routeUrl}`，如 'POST /api/slot/spin' */
  routeRules?: Record<string, BucketRule>;
  /** 路徑前綴白名單：不限流（健康檢查等） */
  allowList?: string[];
}

export const DEFAULT_RULE: BucketRule = { capacity: 20, refillPerSec: 10 };

export default fp<RateLimitOptions>(
  async (app, opts) => {
    const defaultRule = opts.defaultRule ?? DEFAULT_RULE;
    const routeRules = opts.routeRules ?? {};
    const allowList = opts.allowList ?? ['/healthz'];

    /** 已登入以 userId 計數（跨裝置共桶）；匿名退回 IP */
    function identityOf(request: FastifyRequest): string {
      const header = request.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        try {
          // 僅取分桶身分，無需驗證簽章（偽造 sub 只會撞別人桶，HMAC/JWT 另有把關）
          const decoded = app.jwt.decode<{ sub?: unknown }>(header.slice(7));
          if (decoded && typeof decoded.sub === 'string' && decoded.sub.length > 0) {
            return decoded.sub;
          }
        } catch {
          // 解碼失敗退回 IP
        }
      }
      return `ip:${request.ip}`;
    }

    app.addHook('preHandler', async (request, reply) => {
      const path = request.routeOptions.url ?? request.url;
      if (allowList.some((prefix) => path.startsWith(prefix))) return;

      const routeKey = `${request.method} ${path}`;
      const rule = routeRules[routeKey] ?? defaultRule;
      const bucketKey = `rl:${identityOf(request)}:${routeKey}`;

      let allowed: number;
      let retryAfterMs: number;
      try {
        const result = (await app.redis.eval(
          TOKEN_BUCKET_LUA,
          1,
          bucketKey,
          String(rule.capacity),
          String(rule.refillPerSec),
          String(Date.now()),
          '1',
        )) as [number, number];
        allowed = result[0];
        retryAfterMs = result[1];
      } catch (err) {
        // fail-open：限流為可降級防護，Redis 故障不阻斷服務（Nginx 第一道仍在）
        request.log.warn({ err: (err as Error).message }, 'rate-limit: redis 不可用，本次放行');
        return;
      }

      if (allowed !== 1) {
        void reply.header('retry-after', Math.max(1, Math.ceil(retryAfterMs / 1_000)));
        throw new RateLimitError();
      }
    });
  },
  { name: 'rate-limit', dependencies: ['redis', 'auth'] },
);
