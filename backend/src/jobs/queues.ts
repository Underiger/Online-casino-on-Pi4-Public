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
 * cluster ×2 workers 各自註冊相同的 repeatable job spec，靠 BullMQ repeat key
 * 去重避免重複排程。但這只保證「不重複排程」，不保證「不會同時執行」——
 * 若某次迭代執行時間跨過下個 tick，仍可能被另一個 worker 進程同時領走並執行。
 * 對大多數任務（jackpot flush/tick、moderation）這個重疊是無害的（操作冪等）；
 * 但 Telegram getUpdates 對同一 bot token 不允許併發呼叫，故
 * jobs/telegram-2fa-poll.job.ts 額外用 cluster worker#1 限定，不能只靠這裡的
 * repeat key 去重。
 */
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/** Jackpot flush / tick 共用 queue 名稱 */
export const JACKPOT_FLUSH_QUEUE_NAME = 'jackpot-flush';

/** Moderation 延遲任務 queue 名稱（限時禁言到期自動解除等） */
export const MODERATION_QUEUE_NAME = 'moderation';

/** Telegram 2FA 推播短輪詢 queue 名稱 */
export const TELEGRAM_2FA_QUEUE_NAME = 'telegram-2fa-poll';

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

/** telegramPollQueue：repeatable 短輪詢（2s）任務掛載於此 */
export function createTelegramPollQueue(connection: Redis): Queue {
  return new Queue(TELEGRAM_2FA_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: 100,
    },
  });
}
