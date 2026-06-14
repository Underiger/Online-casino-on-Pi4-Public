/**
 * HMAC-SHA256 請求簽章（02_TDD §5.2）。
 *
 * 金鑰生命週期：
 * - 登入成功 → 產生 32-byte 會話金鑰，存 Redis `hmac:{userId}`（TTL = refresh 壽命 7d），
 *   以 TLS 登入回應一次性下發（base64url）；前端僅存記憶體。
 * - 每次 refresh → 重新產生（自然達成 ≤24h 輪換）；舊金鑰移至 `hmac:{userId}:prev`
 *   保留 30 秒，容忍輪換瞬間的在途請求。
 * - 登出 / 封鎖 → DEL 兩把金鑰，所有後續簽章即刻失效。
 *
 * canonical 由伺服器依「已驗證的 JWT userId + 解析後欄位」重組——
 * 任一欄位被改動簽章即失效（完整性綁定 userId+gameType+betAmount+nonce+timestamp）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';
import { rngToken } from './csprng.js';

/** 會話金鑰長度（位元組） */
export const HMAC_KEY_BYTES = 32;
/** 時間窗容忍：|now - x-ts| ≤ 5000ms（02_TDD §5.3） */
export const HMAC_TIMESTAMP_TOLERANCE_MS = 5_000;
/** 輪換後舊金鑰寬限（秒） */
export const HMAC_PREV_KEY_GRACE_SECONDS = 30;

// ═════════════════ 純函式 ═════════════════

/** 產生 base64url 編碼的 32-byte 會話金鑰 */
export function generateHmacKey(): string {
  return rngToken(HMAC_KEY_BYTES);
}

export interface CanonicalParts {
  userId: string;
  gameType: string;
  betAmount: number | string;
  nonce: string;
  timestamp: number | string;
}

/** canonical = `${userId}|${gameType}|${betAmount}|${nonce}|${timestamp}` */
export function buildCanonical(p: CanonicalParts): string {
  return `${p.userId}|${p.gameType}|${p.betAmount}|${p.nonce}|${p.timestamp}`;
}

/** HMAC-SHA256(key, canonical) → hex */
export function signCanonical(keyB64url: string, canonical: string): string {
  return createHmac('sha256', Buffer.from(keyB64url, 'base64url'))
    .update(canonical)
    .digest('hex');
}

/**
 * 常數時間比較兩個 hex 字串。
 * 長度不同或含非 hex 字元（Buffer.from('hex') 會默默截斷）一律 false，
 * 確保 timingSafeEqual 的等長前置條件。
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  // hex 解析遇非法字元會提前截斷——截斷後長度對不上原字串即視為非法輸入
  if (bufA.length * 2 !== a.length || bufB.length * 2 !== b.length) return false;
  if (bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 以多把金鑰（current + prev 寬限）驗證簽章，任一把通過即合法 */
export function verifySignature(
  keys: readonly string[],
  canonical: string,
  signatureHex: string,
): boolean {
  let valid = false;
  for (const key of keys) {
    // 不提前 return：每把金鑰都做完整比較，避免金鑰數量造成的時間側信道
    if (safeEqualHex(signCanonical(key, canonical), signatureHex)) valid = true;
  }
  return valid;
}

// ═════════════════ Redis 金鑰存放（02_TDD：hmac:{userId} → { key, issuedAt }） ═════════════════

interface StoredHmacKey {
  key: string;
  issuedAt: number;
}

export interface HmacKeyStoreOptions {
  /** 金鑰 TTL（秒）；= Refresh Token 壽命 */
  ttlSeconds: number;
  /** 輪換後舊金鑰寬限（秒），預設 30 */
  graceSeconds?: number;
}

function parseStoredKey(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredHmacKey>;
    return typeof parsed.key === 'string' && parsed.key.length > 0 ? parsed.key : null;
  } catch {
    return null; // 損毀資料視同無金鑰，強制重新協商
  }
}

export function createHmacKeyStore(redis: Redis, options: HmacKeyStoreOptions) {
  const graceSeconds = options.graceSeconds ?? HMAC_PREV_KEY_GRACE_SECONDS;
  const currentKeyOf = (userId: string): string => `hmac:${userId}`;
  const prevKeyOf = (userId: string): string => `hmac:${userId}:prev`;

  return {
    /**
     * 輪換（無現存金鑰時等同首次協商）：
     * 舊金鑰 → prev（30s 寬限），新金鑰 → current（TTL 7d），回傳新金鑰明文。
     */
    async rotate(userId: string): Promise<string> {
      const next: StoredHmacKey = { key: generateHmacKey(), issuedAt: Date.now() };
      const current = await redis.get(currentKeyOf(userId));
      if (current !== null) {
        await redis.set(prevKeyOf(userId), current, 'EX', graceSeconds);
      }
      await redis.set(currentKeyOf(userId), JSON.stringify(next), 'EX', options.ttlSeconds);
      return next.key;
    },

    /** 登出 / 封鎖：兩把金鑰即刻失效 */
    async revoke(userId: string): Promise<void> {
      await redis.del(currentKeyOf(userId), prevKeyOf(userId));
    },

    /** 驗章用：[current, prev?]，prev 僅在輪換寬限期內存在 */
    async getActiveKeys(userId: string): Promise<string[]> {
      const raw = await redis.mget(currentKeyOf(userId), prevKeyOf(userId));
      const keys: string[] = [];
      for (const entry of raw) {
        const key = parseStoredKey(entry ?? null);
        if (key !== null) keys.push(key);
      }
      return keys;
    },
  };
}

export type HmacKeyStore = ReturnType<typeof createHmacKeyStore>;
