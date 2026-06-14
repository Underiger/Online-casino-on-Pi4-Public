/**
 * 異常下注偵測（02_TDD §5.7；M06 落地頻率視窗，M24 補齊三條規則）。
 *
 * 偵測規則（Redis 滑動視窗 / 日統計）：
 *   1. 下注頻率 > 2 次/秒                       → BET_RATE        ✅ M06
 *   2. 勝率連續 3 個 5 分鐘視窗 > 99%           → WIN_RATE        ✅ M24
 *   3. 單日淨贏 > 全服 P99 × 10                 → NET_WIN_OUTLIER ✅ M24
 *
 * 命中後僅「標記」（onFlag 回呼），不自動封鎖——人工裁決（02_TDD §5.7）。
 * onFlag 由呼叫方注入（slot.routes.ts / roulette.gateway.ts），可寫 User.flagged
 * 並記稽核日誌；預設僅記警告日誌。
 *
 * Redis 失敗時靜默略過（偵測屬輔助功能，永不阻斷下注主流程）。
 */
import type { Redis } from 'ioredis';

export type AnomalyReason = 'BET_RATE' | 'WIN_RATE' | 'NET_WIN_OUTLIER';

// ─────────────────────────── 規則 1：下注頻率 ────────────────────────────────

/** 頻率規則：每 1 秒視窗超過 2 次下注即標記 */
export const BET_RATE_WINDOW_SECONDS = 1;
export const BET_RATE_MAX_PER_WINDOW = 2;

// ─────────────────────────── 規則 2：勝率 ────────────────────────────────────

/** 勝率視窗：5 分鐘桶（連續 3 個視窗 > 99% 才標記） */
export const WIN_RATE_BUCKET_SECONDS = 5 * 60;
export const WIN_RATE_THRESHOLD = 0.99;
/** 勝率分母下限：桶內下注筆數 ≥ 此值才納入判定（避免 1/1=100% 誤報） */
export const WIN_RATE_MIN_BETS = 10;
/** 連續高勝率視窗數門檻 */
export const WIN_RATE_CONSEC_WINDOWS = 3;

// ─────────────────────────── 規則 3：單日淨贏 ────────────────────────────────

/** 單日淨贏超過全服 P99 的倍數門檻 */
export const NET_WIN_OUTLIER_MULTIPLIER = 10;

// ─────────────────────────── Redis 鍵 ─────────────────────────────────────────

/** 下注頻率計數鍵：anomaly:freq:{userId}:{bucket1s} */
const freqKey = (userId: string, bucket: number): string => `anomaly:freq:${userId}:${bucket}`;
/** 勝率 wins 計數鍵：anomaly:wr:win:{userId}:{bucket5m} */
const winKey = (userId: string, bucket: number): string => `anomaly:wr:win:${userId}:${bucket}`;
/** 勝率 total 計數鍵：anomaly:wr:total:{userId}:{bucket5m} */
const totalKey = (userId: string, bucket: number): string => `anomaly:wr:total:${userId}:${bucket}`;
/** 單日淨贏累計鍵：anomaly:netwin:{userId}:{dateKey} */
export const netwinKey = (userId: string, dateKey: string): string =>
  `anomaly:netwin:${userId}:${dateKey}`;
/** 全服 P99 快取鍵（由 monitor-scan.job.ts 寫入）：anomaly:p99:{dateKey} */
export const p99Key = (dateKey: string): string => `anomaly:p99:${dateKey}`;

// ─────────────────────────── 日期工具 ────────────────────────────────────────

/** Asia/Taipei 當日日期字串（YYYY-MM-DD），鏡像 daily.service.ts 同款邏輯 */
function getTodayDateKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
}

// ─────────────────────────── 介面 ────────────────────────────────────────────

export interface AnomalyDetectorOptions {
  /**
   * 命中異常時的回呼（fire-and-forget）。
   * M24：由 slot.routes.ts 注入，寫 User.flagged + 稽核日誌。
   * 預設僅輸出警告日誌。
   */
  onFlag?: (userId: string, reason: AnomalyReason) => void;
  log?: { warn: (obj: unknown, msg?: string) => void };
}

// ─────────────────────────── 工廠 ────────────────────────────────────────────

export function createAnomalyDetector(redis: Redis, options: AnomalyDetectorOptions = {}) {
  const onFlag =
    options.onFlag ??
    ((userId: string, reason: AnomalyReason): void => {
      options.log?.warn({ userId, reason }, 'anomaly detected (flag callback 未接，僅記錄)');
    });

  return {
    /**
     * 每筆下注呼叫一次（spin / roulette bet 結算路徑外的非阻塞統計）。
     * 回傳本次命中的異常原因（空陣列 = 正常）。
     * Redis 失敗時靜默略過——偵測屬輔助功能，永不阻斷下注主流程。
     */
    async recordBet(userId: string, amount: bigint, payout: bigint): Promise<AnomalyReason[]> {
      const reasons: AnomalyReason[] = [];
      try {
        const now = Date.now();

        // ── 規則 1：下注頻率（固定 1 秒桶；超過閾值即標記） ──
        const bucket1s = Math.floor(now / (BET_RATE_WINDOW_SECONDS * 1_000));
        const fKey = freqKey(userId, bucket1s);
        const freqCount = await redis.incr(fKey);
        if (freqCount === 1) await redis.expire(fKey, BET_RATE_WINDOW_SECONDS * 2);
        if (freqCount > BET_RATE_MAX_PER_WINDOW) {
          reasons.push('BET_RATE');
        }

        // ── 規則 2：勝率（5 分鐘桶；連續 3 視窗 > 99%） ──
        const bucket5m = Math.floor(now / (WIN_RATE_BUCKET_SECONDS * 1_000));
        const tKey = totalKey(userId, bucket5m);
        const wKey = winKey(userId, bucket5m);
        // 記錄本次下注
        const [totalCount] = await Promise.all([
          redis.incr(tKey).then(async (n) => {
            if (n === 1) await redis.expire(tKey, WIN_RATE_BUCKET_SECONDS * (WIN_RATE_CONSEC_WINDOWS + 2));
            return n;
          }),
          payout > 0n
            ? redis.incr(wKey).then(async (n) => {
                if (n === 1) await redis.expire(wKey, WIN_RATE_BUCKET_SECONDS * (WIN_RATE_CONSEC_WINDOWS + 2));
                return n;
              })
            : Promise.resolve(0),
        ]);

        // 僅在累積足夠樣本後才檢查（避免低流量期誤報）
        if (totalCount >= WIN_RATE_MIN_BETS) {
          let consecutive = 0;
          for (let i = 0; i < WIN_RATE_CONSEC_WINDOWS; i++) {
            const b = bucket5m - i;
            const [wRaw, tRaw] = await Promise.all([
              redis.get(winKey(userId, b)),
              redis.get(totalKey(userId, b)),
            ]);
            const w = parseInt(wRaw ?? '0', 10);
            const t = parseInt(tRaw ?? '0', 10);
            if (t >= WIN_RATE_MIN_BETS && w / t > WIN_RATE_THRESHOLD) {
              consecutive++;
            } else {
              break;
            }
          }
          if (consecutive >= WIN_RATE_CONSEC_WINDOWS) {
            reasons.push('WIN_RATE');
          }
        }

        // ── 規則 3：單日淨贏 > 全服 P99 × 10 ──
        const dateKey = getTodayDateKey();
        const nKey = netwinKey(userId, dateKey);
        const netDelta = Number(payout) - Number(amount);
        const newNetWin = await redis.incrby(nKey, netDelta);
        // 首次寫入設 TTL（保留 2 天供次日 monitor-scan 掃描）
        if (newNetWin === netDelta) await redis.expire(nKey, 86400 * 2);

        if (newNetWin > 0) {
          const p99Raw = await redis.get(p99Key(dateKey));
          if (p99Raw !== null) {
            const p99 = parseInt(p99Raw, 10);
            if (p99 > 0 && newNetWin > p99 * NET_WIN_OUTLIER_MULTIPLIER) {
              reasons.push('NET_WIN_OUTLIER');
            }
          }
        }
      } catch (err) {
        options.log?.warn({ err: (err as Error).message }, 'anomaly: redis 不可用，本次略過統計');
        return [];
      }

      for (const reason of reasons) {
        onFlag(userId, reason);
      }
      return reasons;
    },

    /** 暴露給 monitor-scan job：讀取所有使用者的今日淨贏並計算 P99 */
    async updateNetWinP99(): Promise<void> {
      const dateKey = getTodayDateKey();
      const pattern = `anomaly:netwin:*:${dateKey}`;

      const values: number[] = [];
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          const raws = await redis.mget(...keys);
          for (const raw of raws) {
            if (raw === null) continue;
            const n = parseInt(raw, 10);
            if (!isNaN(n) && n > 0) values.push(n);
          }
        }
      } while (cursor !== '0');

      if (values.length === 0) return;

      values.sort((a, b) => a - b);
      const idx = Math.min(Math.floor(values.length * 0.99), values.length - 1);
      const p99 = values[idx];
      // values 非空（上方已 return）且 idx 已 clamp 至 [0, len-1]，p99 必為 number；
      // 此 guard 僅滿足 noUncheckedIndexedAccess 的型別收斂，執行期不會觸發。
      if (p99 === undefined) return;

      await redis.set(p99Key(dateKey), p99, 'EX', 86400 * 2);
      options.log?.warn(
        { dateKey, p99, sampleSize: values.length },
        'anomaly: NET_WIN P99 已更新',
      );
    },
  };
}

export type AnomalyDetector = ReturnType<typeof createAnomalyDetector>;
