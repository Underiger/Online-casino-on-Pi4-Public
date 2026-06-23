/**
 * Telegram Bot API client 單元測試。
 *
 * mock 全域 fetch：驗證請求 URL/body 組裝正確，以及 ok:false 時依約 throw
 * （呼叫方 admin.service 依賴「失敗就拋」這個契約做 fail-open：Telegram 不可用時
 * 前端會 catch 到錯誤並 fallback 回手動輸入 TOTP，見 ReverifyDialog.vue）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  sendApprovalMessage,
  resolveMessage,
  answerCallbackQuery,
  getUpdates,
} from '../../src/integrations/telegram.js';

function mockFetchOnce(response: unknown, status = 200) {
  const fn = vi.fn(async () => ({ status, json: async () => response }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('integrations/telegram', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sendApprovalMessage：組出 sendMessage 請求 + 核准/拒絕雙按鈕 callback_data', async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: { message_id: 123 } });
    const res = await sendApprovalMessage('hello', 'req-1');

    expect(res).toEqual({ messageId: 123 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/sendMessage');
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe('hello');
    expect(body.reply_markup.inline_keyboard[0]).toEqual([
      { text: '✅ 核准', callback_data: 'tg2fa:approve:req-1' },
      { text: '❌ 拒絕', callback_data: 'tg2fa:deny:req-1' },
    ]);
  });

  it('resolveMessage：組出 editMessageText 請求並清空按鈕', async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: {} });
    await resolveMessage(123, 'done');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/editMessageText');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      message_id: 123,
      text: 'done',
      reply_markup: { inline_keyboard: [] },
    });
  });

  it('answerCallbackQuery：text 省略時請求 body 不帶該欄位', async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: true });
    await answerCallbackQuery('cbq1');

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ callback_query_id: 'cbq1' });
  });

  it('getUpdates：帶 offset + timeout=0（短輪詢，立即返回）', async () => {
    const fetchMock = mockFetchOnce({ ok: true, result: [{ update_id: 1 }] });
    const updates = await getUpdates(5);

    expect(updates).toEqual([{ update_id: 1 }]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ offset: 5, timeout: 0 });
  });

  it('Telegram 回 ok:false → throw 帶 description 的錯誤', async () => {
    mockFetchOnce({ ok: false, description: 'Unauthorized' });
    await expect(getUpdates(0)).rejects.toThrow(/Unauthorized/);
  });
});
