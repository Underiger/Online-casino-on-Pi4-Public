/**
 * BullMQ queue 定義（02_TDD §6.3、04_FOLDER_STRUCTURE §1 jobs/queues.ts）。
 *
 * 連線策略：BullMQ 不可重用 app.redis——
 *   1. Worker 需要阻塞式命令（BRPOPLPUSH 系），會獨佔連線；
 *   2. BullMQ 要求 maxRetriesPerRequest: null（命令永不因重試上限被丟棄），
 *      與 redis plugin 的一般命令連線（maxRetriesPerRequest: 2）語義衝突。
 * 故 Queue / Worker 各建獨立 ioredis 連線，由 jobs 註冊方負責 onClose 收尾。
 *
 * 同進程跑 BullMQ 為刻意取捨（02_TDD §8：省 ~150MB，200 人規模可承受）；
 * cluster ×2 workers 各自註冊相同的 repeatable job spec（BullMQ 以 repeat key
 * 去重，同一時刻只有一個 worker 取得該次執行）——天然單執行、無需選主。
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** Jackpot flush / tick 共用 queue 名稱 */
export const JACKPOT_FLUSH_QUEUE_NAME = 'jackpot-flush';

/** Moderation 延遲任務 queue 名稱（限時禁言到期自動解除等） */
export const MODERATION_QUEUE_NAME = 'moderation';

/** BullMQ 專用 ioredis 連線（Queue 與 Worker 各建一條） */
export function createJobConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    // BullMQ 硬性要求：阻塞命令不可因重試上限被丟棄
    maxRetriesPerRequest: null,
    // 與 plugins/redis.ts 同款退避：生產無限重連、開發 20 次後放棄
    retryStrategy: (times) => {
      if (env.NODE_ENV !== 'production' && times > 20) return null;
      return Math.min(times * 200, 2_000);
    },
  });
}

/** jackpotFlushQueue：repeatable flush(10s) 與 tick(5s) 任務掛載於此 */
export function createJackpotFlushQueue(connection: Redis): Queue {
  return new Queue(JACKPOT_FLUSH_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // repeatable 任務每次迭代都是新 job——完成即清、失敗留少量供排錯
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });
}

/** moderationQueue：限時禁言到期自動解除等一次性延遲（delay）任務掛載於此 */
export function createModerationQueue(connection: Redis): Queue {
  return new Queue(MODERATION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // 一次性延遲任務：完成即清、失敗留少量供排錯
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });
}
