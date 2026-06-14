/**
 * 防重放：Nonce + Sequence（02_TDD §5.3）。
 *
 * | 機制     | 實作                                                            |
 * |----------|-----------------------------------------------------------------|
 * | Nonce    | SET nonce:{userId}:{nonce} 1 NX EX 10 — SET 失敗 = 重放         |
 * | Sequence | last_seq:{userId} — Lua 原子比較交換，x-seq 必須嚴格遞增         |
 *
 * Nonce TTL 10 秒即可：時間窗檢查（±5s）已擋掉更舊的封包，
 * nonce 只需覆蓋時間窗內的重放空間。
 */
import type { Redis } from 'ioredis';

export const NONCE_TTL_SECONDS = 10;
/** seq 計數器壽命 = refresh token 壽命（會話結束自然過期） */
export const SEQ_TTL_SECONDS = 7 * 86_400;

/**
 * 原子「嚴格遞增才寫入」：
 *   KEYS[1] = last_seq:{userId}
 *   ARGV[1] = 候選 seq；ARGV[2] = TTL 秒
 * 回傳 1 = 接受；0 = 倒退或重複（拒絕，且不動現值）。
 * 鍵不存在時現值視為 -1，首個請求任何 seq ≥ 0 都接受。
 */
export const SEQ_GUARD_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
local candidate = tonumber(ARGV[1])
if candidate == nil then
  return 0
end
if candidate > current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
`;

export function createReplayGuard(redis: Redis) {
  return {
    /**
     * nonce 首見回 true；重複（重放）回 false。
     * SET NX 本身即原子——並發同 nonce 只有一個成功。
     */
    async checkNonce(userId: string, nonce: string): Promise<boolean> {
      const result = await redis.set(
        `nonce:${userId}:${nonce}`,
        '1',
        'EX',
        NONCE_TTL_SECONDS,
        'NX',
      );
      return result === 'OK';
    },

    /** seq 嚴格遞增回 true；倒退或重複回 false */
    async checkSeq(userId: string, seq: number): Promise<boolean> {
      const result = await redis.eval(
        SEQ_GUARD_LUA,
        1,
        `last_seq:${userId}`,
        String(seq),
        String(SEQ_TTL_SECONDS),
      );
      return result === 1;
    },

    /** 登出 / 重新登入時重置（可選；seq 鍵也會隨 TTL 自然過期） */
    async resetSeq(userId: string): Promise<void> {
      await redis.del(`last_seq:${userId}`);
    },
  };
}

export type ReplayGuard = ReturnType<typeof createReplayGuard>;
