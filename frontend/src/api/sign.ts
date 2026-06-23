/**
 * WebCrypto HMAC-SHA256 簽章（04_FOLDER_STRUCTURE §2 api/sign.ts）。
 *
 * - 金鑰來源：登入/refresh 回應中的 hmacKey（base64url），存於 Pinia auth store 記憶體，
 *   永不落 localStorage（02_TDD §5.2 安全要求）。
 * - canonical：`${userId}|${gameType}|${betAmount}|${nonce}|${timestamp}`
 *   （與後端 security/hmac.ts buildCanonical 完全對應，docs/04_API_SPEC.md §1.4）
 * - 用法：HTTP 路由傳 x-sig / x-nonce / x-ts / x-seq headers；
 *   Socket 事件傳 payload.sig / .nonce / .ts / .seq 欄位。
 * - seq 嚴格遞增計數器儲存於 auth store（重新整理後歸零，Server 端 TTL 自然過期同步清零）。
 *
 * 需要 HTTPS 或 localhost（SubtleCrypto 在 insecure context 不可用）。
 */

/** HMAC 金鑰匯入快取（避免每次請求都 importKey） */
const keyCache = new Map<string, CryptoKey>();

async function importHmacKey(base64urlKey: string): Promise<CryptoKey> {
  const cached = keyCache.get(base64urlKey);
  if (cached !== undefined) return cached;

  // base64url → Uint8Array
  const base64 = base64urlKey.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  keyCache.set(base64urlKey, key);
  return key;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface SignedHeaders {
  'x-sig': string;
  'x-nonce': string;
  'x-ts': string;
  'x-seq': string;
}

export interface SignPayload {
  /** HMAC 金鑰（base64url，來自 auth store，僅存記憶體） */
  hmacKey: string;
  userId: string;
  gameType: 'SLOT' | 'ROULETTE' | 'DRAGON_GATE' | 'HIGH_LOW' | 'BLACKJACK';
  betAmount: number;
  /** 嚴格遞增序號（由呼叫端傳入，呼叫後外部自增） */
  seq: number;
}

export interface SignResult {
  sig: string;
  nonce: string;
  ts: number;
  seq: number;
}

/**
 * 計算 HMAC-SHA256 簽章，回傳供 HTTP header 或 Socket payload 使用的欄位。
 * nonce 由此生成（crypto.randomUUID），ts 為 Date.now()。
 */
export async function signRequest(p: SignPayload): Promise<SignResult> {
  const nonce = crypto.randomUUID();
  const ts = Date.now();
  const canonical = `${p.userId}|${p.gameType}|${p.betAmount}|${nonce}|${ts}`;

  const key = await importHmacKey(p.hmacKey);
  const encoded = new TextEncoder().encode(canonical);
  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoded);
  const sig = toHex(sigBuffer);

  return { sig, nonce, ts, seq: p.seq };
}

/**
 * 將 SignResult 轉為 HTTP HMAC headers。
 */
export function toHmacHeaders(result: SignResult): SignedHeaders {
  return {
    'x-sig': result.sig,
    'x-nonce': result.nonce,
    'x-ts': String(result.ts),
    'x-seq': String(result.seq),
  };
}

/** 清空金鑰快取（登出時呼叫） */
export function clearKeyCache(): void {
  keyCache.clear();
}
