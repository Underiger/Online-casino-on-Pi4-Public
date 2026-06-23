/**
 * Telegram Bot API 純 HTTP client（admin 高危操作 2FA 推播用）。
 *
 * 零商業邏輯、零新依賴——Node 20 內建 fetch。呼叫方（admin.service.ts）負責
 * Redis 狀態機與稽核；本檔只管把資料送到/收自 Telegram，失敗一律 throw
 * （不在此層吞錯，與 security/totp.ts「純密碼學出口」的分層精神一致）。
 *
 * telegramEnabled：TELEGRAM_BOT_TOKEN / TELEGRAM_ADMIN_CHAT_ID 任一留空即視為
 * 功能關閉——admin.service 與 jobs/telegram-2fa-poll.job 皆以此常數短路，
 * 不影響未設定此功能的環境（dev/CI 預設皆空字串）。
 */
import { env } from '../config/env.js';

export const telegramEnabled = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_ADMIN_CHAT_ID);

const API_BASE = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
/** 單次請求逾時：避免網路無回應時把呼叫方（請求路徑 / poll job）卡死 */
const REQUEST_TIMEOUT_MS = 8_000;

export interface TelegramCallbackQuery {
  id: string;
  from: { id: number };
  message?: { message_id: number };
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramApiResult<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function callApi<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API_BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const json = (await res.json()) as TelegramApiResult<T>;
  if (!json.ok) {
    throw new Error(`Telegram API ${method} 失敗：${json.description ?? res.status}`);
  }
  return json.result as T;
}

/** 送出核准/拒絕雙按鈕訊息；callback_data 帶 requestId 供 callback 比對 */
export async function sendApprovalMessage(
  text: string,
  requestId: string,
): Promise<{ messageId: number }> {
  const result = await callApi<{ message_id: number }>('sendMessage', {
    chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 核准', callback_data: `tg2fa:approve:${requestId}` },
          { text: '❌ 拒絕', callback_data: `tg2fa:deny:${requestId}` },
        ],
      ],
    },
  });
  return { messageId: result.message_id };
}

/** 核准/拒絕後改寫原訊息文字並清空按鈕，避免過期按鈕被重複點擊 */
export async function resolveMessage(messageId: number, text: string): Promise<void> {
  await callApi('editMessageText', {
    chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
    message_id: messageId,
    text,
    reply_markup: { inline_keyboard: [] },
  });
}

/** 清掉手機端按鈕的 loading 轉圈，可選擇附帶短暫 toast 提示 */
export async function answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  await callApi('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...(text !== undefined ? { text } : {}),
  });
}

/** 短輪詢（timeout=0 立即返回）；offset 由呼叫方持久化（Redis），本函式不存狀態 */
export async function getUpdates(offset: number): Promise<TelegramUpdate[]> {
  return callApi<TelegramUpdate[]>('getUpdates', {
    offset,
    timeout: 0,
    allowed_updates: ['callback_query'],
  });
}
