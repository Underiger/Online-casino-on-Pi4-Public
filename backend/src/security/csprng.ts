/**
 * CSPRNG — 全專案唯一亂數出口（02_TDD §5.1）。
 *
 * ESLint `no-restricted-properties` 已全域禁用 Math.random；
 * 任何需要亂數的模組（轉軸抽樣、輪盤開獎、token、金鑰、nonce salt）
 * 一律從本檔匯入，嚴禁自行 import node:crypto 散落各處。
 *
 * - rngInt：crypto.randomInt — 均勻分布、無模偏差（modulo bias）
 * - rngBytes / rngToken：crypto.randomBytes — 金鑰與不透明 token
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';

/** [0, maxExclusive) 均勻整數；轉軸抽樣 rngInt(totalWeight)、輪盤 rngInt(37) */
export function rngInt(maxExclusive: number): number {
  return randomInt(maxExclusive);
}

/** [minInclusive, maxExclusive) 均勻整數 */
export function rngIntRange(minInclusive: number, maxExclusive: number): number {
  return randomInt(minInclusive, maxExclusive);
}

/** n 位元組密碼學隨機 Buffer（HMAC 金鑰、server seed） */
export function rngBytes(n: number): Buffer {
  return randomBytes(n);
}

/** base64url 編碼隨機 token（Gift Code、HMAC 金鑰下發格式） */
export function rngToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** hex 編碼隨機 token（refresh token 慣用格式） */
export function rngHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** UUID v4（nonce、familyId） */
export function rngUuid(): string {
  return randomUUID();
}
