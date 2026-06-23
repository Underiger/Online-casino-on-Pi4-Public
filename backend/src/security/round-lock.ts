/**
 * 多步驟回合併發鎖（02_TDD 風格延伸：High-Low / Blackjack 等需要在多次請求之間
 * 保留「進行中的一局」狀態的遊戲，防止同一玩家對同一回合的單一動作併發送出
 * 兩個請求，造成讀-改-寫競態（例如 hit 補兩張牌、或重複扣款）。
 *
 * | 機制 | 實作 |
 * |------|------|
 * | 取鎖 | `SET key token NX PX ttlMs` — 取不到視為「另一個請求正在處理」 |
 * | 釋放 | Lua 比對 token 才刪除 — 避免刪掉「鎖已過期、被別人重新搶到」的新鎖 |
 *
 * 這專案的 Redis 是單一實例（worker 之間共用，與 roulette leader lock 的
 * `SET NX EX` 同一前例），不是多節點部署，因此不需要正式 multi-node Redlock，
 * 單實例鎖語義已足夠安全；Redis 不可用時沿用全專案一致的 fail-closed 原則
 * （呼叫端會直接收到 Redis 例外，不靜默放行）。
 *
 * 射龍門不使用本工具：它整回合只有一次會動錢的操作（bet），改用 `GETDEL`
 * 把回合狀態「讀出同時刪除」做成單一原子操作即可，比鎖更簡單。
 */
import type { Redis } from 'ioredis';
import { rngUuid } from './csprng.js';
import { OptimisticLockError } from '../shared/errors.js';

/** 只刪除自己持有的 token，避免誤刪別人在鎖過期後重新取得的鎖 */
export const RELEASE_IF_OWNER_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export function createRoundLock(redis: Redis) {
  return {
    /**
     * 取鎖 → 執行 fn → 釋放鎖（finally，成功或失敗都釋放）。
     * 取不到鎖：拋 `OptimisticLockError`（409 OPTIMISTIC_LOCK_FAILED），呼叫端
     * 不重試、直接告知玩家稍後再試——回合動作本來就該是「同一時間最多一個在
     * 處理」，沒有排隊等待的必要。
     */
    async withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const token = rngUuid();
      const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
      if (acquired !== 'OK') {
        throw new OptimisticLockError('這一回合有其他操作正在處理中，請稍後再試');
      }
      try {
        return await fn();
      } finally {
        // 釋放失敗不拋錯：鎖本身有 TTL，最終會自然過期，不影響正確性，
        // 只是讓下一個請求多等一下子。
        await redis.eval(RELEASE_IF_OWNER_LUA, 1, key, token).catch(() => {});
      }
    },
  };
}

export type RoundLock = ReturnType<typeof createRoundLock>;
