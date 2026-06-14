/**
 * scripts/loadtest/k6-mixed.js — M26 k6 混合場景壓力測試腳本
 *
 * 前置需求：
 *   - 安裝 k6（含 WebSocket 支援，k6 v0.42+）：
 *     macOS:   brew install k6
 *     Windows: choco install k6
 *   - 後端服務已啟動（docker-compose.arm64.yml 或本地開發環境）
 *   - 建議：暫時調高 Rate Limit 以避免 429 影響測試結果
 *
 * 執行方式：
 *   k6 run scripts/loadtest/k6-mixed.js
 *   k6 run --env K6_BASE_URL=http://192.168.1.100:3000 scripts/loadtest/k6-mixed.js
 *
 * 環境變數：
 *   K6_BASE_URL  後端 base URL（預設 http://localhost:3000）
 *
 * 測試設計：
 *   - 總計 200 VU（場景 A 100 VU + 場景 B 100 VU，各 50%）
 *   - 場景 A（slotScenario）：100 VU 執行老虎機旋轉（同 k6-spin.js 邏輯）
 *   - 場景 B（rouletteScenario）：100 VU 執行輪盤 WebSocket（同 k6-roulette.js 邏輯）
 *   - 兩場景並行運行，共同施壓後端
 *   - 閾值：整體錯誤率 < 1%、Spin P95 < 500ms、Roulette 下注成功率 > 98%
 */

import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Rate, Counter, Trend } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';

// ─────────────────────────── 環境設定 ───────────────────────────

const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';
const API = `${BASE_URL}/api`;
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
const SIO_URL = `${WS_BASE}/socket.io/?EIO=4&transport=websocket`;

// ─────────────────────────── k6 配置（scenarios） ───────────────────────────

export const options = {
  scenarios: {
    // 場景 A：老虎機（50% VU = 100 VU）
    slotScenario: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5m',
      exec: 'slotDefault',
    },
    // 場景 B：輪盤（50% VU = 100 VU）
    rouletteScenario: {
      executor: 'constant-vus',
      vus: 100,
      duration: '5m',
      exec: 'rouletteDefault',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    // Spin 相關
    spin_duration: ['p(95)<500'],
    spin_success_rate: ['rate>0.99'],
    // Roulette 相關
    roulette_bet_success: ['rate>0.98'],
  },
};

// ─────────────────────────── 自訂指標 ───────────────────────────

const spinSuccessRate = new Rate('spin_success_rate');
const spinDuration = new Trend('spin_duration', true);
const rouletteBetSuccess = new Rate('roulette_bet_success');
const rouletteBetsPlaced = new Counter('roulette_bets_placed');
const roulettePhasesReceived = new Counter('roulette_phases');
const rouletteReconnects = new Counter('roulette_reconnects');

// ─────────────────────────── 共用工具函式 ───────────────────────────

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function decodeHmacKey(b64url) {
  return encoding.b64decode(b64url, 'rawurl', 'b');
}

function computeHmac(keyBuffer, canonical) {
  return crypto.hmac('sha256', keyBuffer, canonical, 'hex');
}

function randomBetAmount() {
  return [10, 50, 100][Math.floor(Math.random() * 3)];
}

function randomBetType() {
  return ['RED', 'BLACK', 'ODD', 'EVEN'][Math.floor(Math.random() * 4)];
}

// ─────────────────────────── Socket.IO 協定工具 ───────────────────────────

function parseSioPacket(msg) {
  if (typeof msg !== 'string' || msg.length === 0) return { eioType: -1 };
  const eioType = parseInt(msg[0], 10);
  if (eioType !== 4) return { eioType };
  const sioType = msg.length >= 2 ? parseInt(msg[1], 10) : -1;
  let data = null;
  if (msg.length > 2) {
    try { data = JSON.parse(msg.slice(2)); } catch { data = msg.slice(2); }
  }
  return { eioType, sioType, data };
}

function sioEvent(event, payload) {
  return `42${JSON.stringify([event, payload])}`;
}

function sioConnect(token) {
  return `40${JSON.stringify({ token })}`;
}

// ─────────────────────────── 場景 A：老虎機 VU 狀態 ───────────────────────────

// 模組層級 per-VU 狀態（k6 每 VU 獨立模組實例）
let slotToken = null;
let slotUserId = null;
let slotKeyBuffer = null;
let slotSeq = 0;

function initSlotVU() {
  if (slotToken !== null) return;

  const username = `k6mix_s${__VU}_${Date.now()}`;
  const regRes = http.post(
    `${API}/auth/register`,
    JSON.stringify({ username, password: 'K6Mixed@2026!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (regRes.status !== 201) {
    console.error(`Slot VU ${__VU} 初始化失敗 ${regRes.status}`);
    return;
  }

  const d = JSON.parse(regRes.body);
  slotToken = d.accessToken;
  slotUserId = d.user.id;
  slotKeyBuffer = decodeHmacKey(d.hmacKey);
  slotSeq = 0;
}

/** 場景 A 主函式（老虎機旋轉） */
export function slotDefault() {
  initSlotVU();

  if (slotToken === null) {
    sleep(1);
    return;
  }

  const betAmount = randomBetAmount();
  const nonce = uuidv4();
  const ts = Date.now();
  const seq = ++slotSeq;
  const canonical = `${slotUserId}|SLOT|${betAmount}|${nonce}|${ts}`;
  const sig = computeHmac(slotKeyBuffer, canonical);

  const t0 = Date.now();
  const res = http.post(
    `${API}/slot/spin`,
    JSON.stringify({ betAmount }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${slotToken}`,
        'x-sig': sig,
        'x-nonce': nonce,
        'x-ts': String(ts),
        'x-seq': String(seq),
      },
    },
  );
  spinDuration.add(Date.now() - t0);

  const ok = check(res, {
    'mixed/slot: HTTP 200': (r) => r.status === 200,
    'mixed/slot: 有 data': (r) => {
      try { return JSON.parse(r.body).data !== undefined; } catch { return false; }
    },
    'mixed/slot: balance >= 0': (r) => {
      try { return BigInt(JSON.parse(r.body).data.newBalance) >= 0n; } catch { return false; }
    },
  });
  spinSuccessRate.add(ok);

  if (res.status === 401) {
    slotToken = null;
    slotKeyBuffer = null;
    initSlotVU();
  }

  sleep(0.5 + Math.random() * 1.5);
}

// ─────────────────────────── 場景 B：輪盤 VU 狀態 ───────────────────────────

let rltToken = null;
let rltUserId = null;
let rltKeyBuffer = null;
let rltSeq = 0;

function initRltVU() {
  if (rltToken !== null) return;

  const username = `k6mix_r${__VU}_${Date.now()}`;
  const regRes = http.post(
    `${API}/auth/register`,
    JSON.stringify({ username, password: 'K6Mixed@2026!' }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  if (regRes.status !== 201) {
    console.error(`Roulette VU ${__VU} 初始化失敗 ${regRes.status}`);
    return;
  }

  const d = JSON.parse(regRes.body);
  rltToken = d.accessToken;
  rltUserId = d.user.id;
  rltKeyBuffer = decodeHmacKey(d.hmacKey);
  rltSeq = 0;
}

/** 場景 B 主函式（輪盤 WebSocket） */
export function rouletteDefault() {
  initRltVU();

  if (rltToken === null) {
    sleep(2);
    return;
  }

  const seqRef = { value: rltSeq };

  ws.connect(SIO_URL, { headers: { Authorization: `Bearer ${rltToken}` } }, (socket) => {
    let currentRoundId = null;
    let betSentThisPhase = false;

    socket.on('open', () => {
      socket.send(sioConnect(rltToken));

      socket.setInterval(() => { socket.send('2'); }, 20_000); // heartbeat
      socket.setTimeout(() => { socket.close(); }, 55_000);    // session limit
    });

    socket.on('message', (msg) => {
      const pkt = parseSioPacket(msg);

      if (pkt.eioType === 2) { socket.send('3'); return; }

      if (pkt.eioType === 4 && pkt.sioType === 2 && Array.isArray(pkt.data)) {
        const [event, payload] = pkt.data;

        if (event === 'roulette:phase') {
          roulettePhasesReceived.add(1);
          if (payload.roundId !== currentRoundId) {
            currentRoundId = payload.roundId;
            betSentThisPhase = false;
          }

          if (payload.phase === 'BETTING' && !betSentThisPhase && currentRoundId) {
            betSentThisPhase = true;

            const betAmount = 50;
            const nonce = uuidv4();
            const ts = Date.now();
            const seq = ++seqRef.value;
            const canonical = `${rltUserId}|ROULETTE|${betAmount}|${nonce}|${ts}`;
            const sig = computeHmac(rltKeyBuffer, canonical);

            socket.send(sioEvent('roulette:bet', {
              roundId: currentRoundId,
              bets: [{ type: randomBetType(), amount: betAmount }],
              sig, nonce, ts, seq,
            }));
            rouletteBetsPlaced.add(1);
          }
        }

        if (event === 'roulette:bet_ack') {
          rouletteBetSuccess.add(payload && payload.accepted === true);
        }
      }
    });

    socket.on('error', () => { socket.close(); });
  });

  rltSeq = seqRef.value;
  rouletteReconnects.add(1);
  sleep(0.5 + Math.random());
}

// ─────────────────────────── 測試結束摘要 ───────────────────────────

export function handleSummary(data) {
  const m = data.metrics;

  return {
    stdout: `
=== 混合場景壓力測試摘要（Slot 100VU + Roulette 100VU）===
HTTP 錯誤率：          ${((m.http_req_failed?.values.rate ?? 0) * 100).toFixed(2)}%

[老虎機]
  Spin 成功率：        ${((m.spin_success_rate?.values.rate ?? 0) * 100).toFixed(2)}%
  Spin 平均延遲：      ${(m.http_req_duration?.values.avg ?? 0).toFixed(1)} ms
  Spin P95 延遲：      ${(m.spin_duration?.values['p(95)'] ?? 0).toFixed(1)} ms

[輪盤]
  Phase 事件收到：     ${m.roulette_phases?.values.count ?? 0}
  下注次數：           ${m.roulette_bets_placed?.values.count ?? 0}
  下注成功率：         ${((m.roulette_bet_success?.values.rate ?? 0) * 100).toFixed(2)}%
  WS 重連次數：        ${m.roulette_reconnects?.values.count ?? 0}
`,
  };
}
