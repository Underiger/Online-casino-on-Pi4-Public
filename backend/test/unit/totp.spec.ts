/**
 * security/totp.ts 單元測試（M21）：AES-256-GCM 加解密、TOTP 驗證、一次性備用碼。
 */
import { describe, expect, it } from 'vitest';
import {
  buildOtpAuthUri,
  currentTotp,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  verifyTotp,
} from '../../src/security/totp.js';

describe('totp: AES-256-GCM 加解密', () => {
  it('明文加密後可正確解密還原', () => {
    const plain = generateTotpSecret();
    const enc = encryptSecret(plain);
    expect(enc).not.toBe(plain);
    expect(enc.split(':')).toHaveLength(3); // iv:tag:ciphertext
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('每次加密的 IV 不同（密文不重複）', () => {
    const plain = 'JBSWY3DPEHPK3PXP';
    expect(encryptSecret(plain)).not.toBe(encryptSecret(plain));
  });

  it('密文遭竄改（authTag 不符）→ 解密拋錯', () => {
    const enc = encryptSecret('secret-value');
    const [iv, tag, ct] = enc.split(':') as [string, string, string];
    // 翻轉密文最後一個 hex 字元
    const flipped = ct.slice(0, -1) + (ct.at(-1) === 'a' ? 'b' : 'a');
    expect(() => decryptSecret(`${iv}:${tag}:${flipped}`)).toThrow();
  });

  it('格式錯誤 → 解密拋錯', () => {
    expect(() => decryptSecret('not-a-valid-payload')).toThrow();
    expect(() => decryptSecret('aa:bb')).toThrow();
  });
});

describe('totp: TOTP 驗證', () => {
  it('產生的 secret 為非空 Base32 字串', () => {
    const secret = generateTotpSecret();
    expect(secret.length).toBeGreaterThanOrEqual(16);
    expect(/^[A-Z2-7]+$/.test(secret)).toBe(true);
  });

  it('otpauth URI 含 issuer 與 secret', () => {
    const secret = generateTotpSecret();
    const uri = buildOtpAuthUri('admin', secret);
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=');
  });

  it('當前時間步的 TOTP 可通過驗證', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, currentTotp(secret))).toBe(true);
  });

  it('錯誤碼 / 非 6 位數字 → 驗證失敗', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
    expect(verifyTotp(secret, '12345')).toBe(false);
    expect(verifyTotp(secret, 'abcdef')).toBe(false);
    expect(verifyTotp(secret, '')).toBe(false);
  });
});

describe('totp: 一次性備用碼', () => {
  it('產生 10 組備用碼，明文與雜湊數量一致', () => {
    const { plain, hashed } = generateRecoveryCodes();
    expect(plain).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    // plain 為 xxxxx-xxxxx 格式
    for (const code of plain) expect(/^[0-9a-f]{5}-[0-9a-f]{5}$/.test(code)).toBe(true);
    // hashed 為 sha256 hex（64 字元）
    for (const h of hashed) expect(/^[0-9a-f]{64}$/.test(h)).toBe(true);
  });

  it('hashRecoveryCode 正規化大小寫與分隔符', () => {
    expect(hashRecoveryCode('ABCDE-12345')).toBe(hashRecoveryCode('abcde12345'));
    expect(hashRecoveryCode('ab cde-123 45')).toBe(hashRecoveryCode('abcde12345'));
  });

  it('matchRecoveryCode 命中回傳該筆 hash、未命中回 null', () => {
    const { plain, hashed } = generateRecoveryCodes();
    const target = plain[3]!;
    expect(matchRecoveryCode(target, hashed)).toBe(hashRecoveryCode(target));
    // 大小寫/分隔符變體仍命中
    expect(matchRecoveryCode(target.toUpperCase(), hashed)).toBe(hashRecoveryCode(target));
    expect(matchRecoveryCode('ffff0-ffff0', hashed)).toBeNull();
  });
});
