/**
 * scripts/loadtest/k6-spin.js — M26 k6 老虎機（Slot）壓力測試腳本
 *
 * 前置需求：
 *   - 安裝 k6：https://k6.io/docs/get-started/installation/
 *     macOS:   brew install k6
 *     Windows: choco install k6  （或 winget install k6）
 *     Linux:   sudo gpg... (見官方文件)
 *   - 後端服務已啟動（docker-compose.arm64.yml 或本地開發環境）
 *   - 建議：暫時調高 Nginx Rate Limit（nginx/conf.d/ratelimit.conf）以免壓測被 429 擋下
 *     例如 api zone 調至 500 r/s，測試完畢後還原
 *
 * 執行方式：
 *   k6 run scripts/loadtest/k6-spin.js
 *   k6 run --env K6_BASE_URL=http://192.168.1.100:3000 scripts/loadtest/k6-spin.js
 *
 * 環境變數：
 *   K6_BASE_URL       後端 API base URL（預設 http://localhost:3000）
 *
 * 測試設計：
 *   - 200 個 VU，每 VU 第一次迭代自動 register + login，取得 JWT + HMAC 金鑰
 *   - 每次旋轉以 HMAC-SHA256 簽章（x-sig / x-nonce / x-ts / x-seq headers）
 *   - 注額隨機選擇 10 / 50 / 100 Coin
 *   - 每次旋轉後 sleep 0.5–2 秒（模擬真實用戶思考時間）
 *   - 驗證 HTTP 200 + 回應欄位合法性（newBalance >= 0）
 *   - 閾值：錯誤率 < 1%、P95 延遲 < 500ms、P99 < 1000ms
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

// ─────────────────────────── 環境設定 ───────────────────────────

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';
const API = `${BASE_URL}/api`;

// ─────────────────────────── k6 配置 ───────────────────────────

export const options = {
  vus: 200,
  duration: '5m',
  thresholds: {
    // 錯誤率需低於 1%
    http_req_failed: ['rate<0.01'],
    // P95 延遲 < 500ms、P99 < 1000ms
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    // 自訂指標：spin 成功率 > 99%
    spin_success_rate: ['rate>0.99'],
    // 自訂指標：spin P95 延遲
    spin_duration: ['p(95)<500'],
  },
};

// ─────────────────────────── 自訂指標 ───────────────────────────

const spinSuccessRate = new Rate('spin_success_rate');
const spinDuration = new Trend('spin_duration', true); // true = 以 ms 單位

// ─────────────────────────── 工具函式 ───────────────────────────

/**
 * 生成 UUID v4（用於 nonce；不需密碼學強度，Math.random 即可）
 */
function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * 計算 HMAC-SHA256 簽章
 * @param {ArrayBuffer} keyBuffer - base64url 解碼後的原始金鑰位元組
 * @param {string} canonical - 待簽字串
 * @returns {string} hex 簽章
 */
function computeHmac(keyBuffer, canonical) {
  return crypto.hmac('sha256', keyBuffer, canonical, 'hex');
}

/**
 * 建構 spin HMAC canonical 字串
 * canonical: ${userId}|SLOT|${betAmount}|${nonce}|${ts}
 */
function buildSpinCanonical(userId, betAmount, nonce, ts) {
  return `${userId}|SLOT|${betAmount}|${nonce}|${ts}`;
}

/**
 * 隨機注額（10 / 50 / 100）
 */
function randomBetAmount() {
  const bets = [10, 50, 100];
  return bets[Math.floor(Math.random() * bets.length)];
}

/**
 * 解析 base64url → ArrayBuffer（供 HMAC 使用）
 */
function decodeHmacKey(hmacKeyB64url) {
  return encoding.b64decode(hmacKeyB64url, 'rawurl', 'b');
}

// ─────────────────────────── VU 狀態（模組層級，每 VU 獨立） ───────────────────────────

let vuAccessToken = null;
let vuUserId = null;
let vuHmacKeyBuffer = null; // ArrayBuffer
let vuSeq = 0;

/**
 * 初始化 VU：register → 取得 JWT + HMAC 金鑰
 * 使用 __VU（VU 序號）+ 時間戳確保使用者名稱唯一
 */
function initVU() {
  if (vuAccessToken !== null) return; // 已初始化

  const username = `k6spin${__VU}_${Date.now()}`;
  const password = 'K6LoadTest@2026!';

  // POST /api/auth/register
  const regRes = http.post(
    `${API}/auth/register`,
    JSON.stringify({ username, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (regRes.status !== 201) {
    console.error(`VU ${__VU} 註冊失敗 ${regRes.status}: ${regRes.body}`);
    return;
  }

  const regData = JSON.parse(regRes.body);
  vuAccessToken = regData.accessToken;
  vuUserId = regData.user.id;
  vuHmacKeyBuffer = decodeHmacKey(regData.hmacKey);
  vuSeq = 0;
}

// ─────────────────────────── 主 VU 函式 ───────────────────────────

export default function () {
  // 第一次迭代：初始化 VU（register + login）
  initVU();

  if (vuAccessToken === null) {
    console.error(`VU ${__VU} 初始化失敗，跳過本次迭代`);
    sleep(1);
    return;
  }

  // 準備 HMAC 欄位
  const betAmount = randomBetAmount();
  const nonce = uuidv4();
  const ts = Date.now();
  const seq = ++vuSeq;
  const canonical = buildSpinCanonical(vuUserId, betAmount, nonce, ts);
  const sig = computeHmac(vuHmacKeyBuffer, canonical);

  // POST /api/slot/spin
  const startTime = Date.now();
  const spinRes = http.post(
    `${API}/slot/spin`,
    JSON.stringify({ betAmount }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${vuAccessToken}`,
        'x-sig': sig,
        'x-nonce': nonce,
        'x-ts': String(ts),
        'x-seq': String(seq),
      },
    },
  );
  const elapsed = Date.now() - startTime;
  spinDuration.add(elapsed);

  // 驗證回應
  const spinOk = check(spinRes, {
    'spin: HTTP 200': (r) => r.status === 200,
    'spin: 有 data 欄位': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.data !== undefined;
      } catch {
        return false;
      }
    },
    'spin: newBalance >= 0': (r) => {
      try {
        const body = JSON.parse(r.body);
        return BigInt(body.data.newBalance) >= 0n;
      } catch {
        return false;
      }
    },
    'spin: reels 為三元素陣列': (r) => {
      try {
        const body = JSON.parse(r.body);
        return Array.isArray(body.data.reels) && body.data.reels.length === 3;
      } catch {
        return false;
      }
    },
  });

  spinSuccessRate.add(spinOk);

  // 若 token 過期（401），嘗試重新登入
  if (spinRes.status === 401) {
    console.warn(`VU ${__VU} token 過期，嘗試重新登入`);
    vuAccessToken = null;
    vuHmacKeyBuffer = null;
    initVU();
  }

  // 思考時間：0.5–2 秒隨機（模擬真實用戶）
  sleep(0.5 + Math.random() * 1.5);
}

// ─────────────────────────── 測試結束摘要 ───────────────────────────

export function handleSummary(data) {
  return {
    stdout: `
=== Slot 壓力測試摘要 ===
請求總數：   ${data.metrics.http_reqs.values.count}
錯誤率：     ${(data.metrics.http_req_failed.values.rate * 100).toFixed(2)}%
Spin 成功率：${(data.metrics.spin_success_rate?.values.rate * 100 || 0).toFixed(2)}%
平均延遲：   ${(data.metrics.http_req_duration.values.avg).toFixed(1)} ms
P95 延遲：   ${(data.metrics.http_req_duration.values['p(95)']).toFixed(1)} ms
P99 延遲：   ${(data.metrics.http_req_duration.values['p(99)']).toFixed(1)} ms
峰值 RPS：   ${(data.metrics.http_reqs.values.rate).toFixed(1)} req/s
`,
  };
}
