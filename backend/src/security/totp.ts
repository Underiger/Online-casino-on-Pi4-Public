/**
 * TOTP（RFC 6238）+ AES-256-GCM 機密加密 + 一次性備用碼（M21；02_TDD §5.5/§5.7）。
 *
 * 全專案 2FA 的純密碼學出口——admin 模組只依賴本檔，便於單元測試替換與審查。
 *
 * - TOTP：otplib v13 functional API（內建 noble-crypto + scure-base32 預設外掛），
 *   6 位數、30s 週期、SHA-1（Google Authenticator / 1Password 等相容）。
 *   驗證容忍 ±1 個時間步（epochTolerance [30,30]）以吸收輸入延遲與時鐘漂移。
 * - secret 加密：AES-256-GCM（金鑰取自 env.AES_256_GCM_KEY，32 bytes）。
 *   儲存格式 `iv:authTag:ciphertext`（皆 hex）；GCM 同時提供機密性與完整性（authTag），
 *   密文遭竄改 decrypt 會拋錯而非回傳偽明文。
 * - 備用碼：10 組人類可讀碼，明文僅產生當下回傳一次；DB 僅存 sha256（雜湊比對、一次性消耗）。
 */
import { createCipheriv, createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import { env } from '../config/env.js';
import { rngBytes } from './csprng.js';

const AES_ALGO = 'aes-256-gcm';
// env 已驗證 AES_256_GCM_KEY 為 64 hex 字元 → 恰 32 bytes
const AES_KEY = Buffer.from(env.AES_256_GCM_KEY, 'hex');
const GCM_IV_BYTES = 12; // GCM 推薦 96-bit IV
const GCM_TAG_BYTES = 16;

/** otpauth URI 服務名稱（顯示於驗證器 App） */
export const TOTP_ISSUER = 'Virtual Casino';
/** 驗證時間容忍：前後各 1 個 30s 步 */
const TOTP_EPOCH_TOLERANCE: [number, number] = [30, 30];
/** 備用碼組數 */
export const RECOVERY_CODE_COUNT = 10;
/** 每組備用碼隨機位元組數（hex 後 10 字元） */
const RECOVERY_CODE_BYTES = 5;

// ───────────────────────── TOTP（otplib 包裝） ─────────────────────────

/** 產生 Base32 TOTP secret */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** 組 otpauth://totp/... URI（前端產 QR Code 用） */
export function buildOtpAuthUri(label: string, secret: string): string {
  return generateURI({ issuer: TOTP_ISSUER, label, secret });
}

/** 驗證 6 位 TOTP；非 6 位數字或驗證例外一律 false（不洩漏原因） */
export function verifyTotp(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return verifySync({ secret, token, epochTolerance: TOTP_EPOCH_TOLERANCE }).valid;
  } catch {
    return false;
  }
}

/** 產生當前時間步 TOTP（測試與內部用；永不經 API 外洩） */
export function currentTotp(secret: string): string {
  return generateSync({ secret });
}

// ───────────────────────── AES-256-GCM ─────────────────────────

/** 加密明文 secret → `iv:tag:ciphertext`（hex） */
export function encryptSecret(plain: string): string {
  const iv = rngBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(AES_ALGO, AES_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/** 解密 `iv:tag:ciphertext`；格式錯誤或 authTag 不符（遭竄改）一律拋錯 */
export function decryptSecret(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) throw new Error('TOTP 機密格式損毀');
  const [ivHex, tagHex, ctHex] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new Error('TOTP 機密格式損毀');
  }
  const decipher = createDecipheriv(AES_ALGO, AES_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString(
    'utf8',
  );
}

// ───────────────────────── 備用碼（一次性，sha256） ─────────────────────────

/** 正規化：去分隔符、轉小寫——比對前統一格式（容忍使用者輸入的連字號/大小寫） */
function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
}

/** sha256(正規化備用碼)；DB 僅存此雜湊 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}

/** 產生 N 組備用碼：plain 僅此一次回傳給管理員，hashed 落庫 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): {
  plain: string[];
  hashed: string[];
} {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const raw = rngBytes(RECOVERY_CODE_BYTES).toString('hex'); // 10 hex 字元
    const formatted = `${raw.slice(0, 5)}-${raw.slice(5)}`; // xxxxx-xxxxx 易讀
    plain.push(formatted);
    hashed.push(hashRecoveryCode(formatted));
  }
  return { plain, hashed };
}

/**
 * 比對備用碼：命中回傳該筆 hash（供呼叫方從清單移除以實現一次性），未命中回 null。
 * 對每一筆做常數時間比對（不提前 return），避免「哪一組命中」的時間側信道。
 */
export function matchRecoveryCode(code: string, hashedList: readonly string[]): string | null {
  const target = Buffer.from(hashRecoveryCode(code), 'hex');
  let matched: string | null = null;
  for (const h of hashedList) {
    let buf: Buffer;
    try {
      buf = Buffer.from(h, 'hex');
    } catch {
      continue;
    }
    if (buf.length === target.length && timingSafeEqual(buf, target)) {
      matched = h;
    }
  }
  return matched;
}
