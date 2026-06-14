/**
 * scripts/loadtest/k6-roulette.js — M26 k6 輪盤（Roulette）WebSocket 壓力測試腳本
 *
 * 前置需求：
 *   - 安裝 k6（含 WebSocket 支援，k6 v0.42+）：
 *     macOS:   brew install k6
 *     Windows: choco install k6
 *   - 後端服務已啟動（docker-compose.arm64.yml 或本地開發環境）
 *   - 建議：暫時調高 Rate Limit，並確認輪盤服務已啟動（roulette leader 已選出）
 *
 * 執行方式：
 *   k6 run scripts/loadtest/k6-roulette.js
 *   k6 run --env K6_BASE_URL=http://192.168.1.100:3000 scripts/loadtest/k6-roulette.js
 *
 * 環境變數：
 *   K6_BASE_URL  後端 base URL（預設 http://localhost:3000）
 *
 * 測試設計：
 *   - 200 個 VU，每 VU 獨立 register + login（取得 JWT + HMAC 金鑰）
 *   - 透過 WebSocket 連接 Socket.IO（Engine.IO v4 協定，手動實作 framing）
 *   - 監聽 roulette:phase 事件：BETTING 階段自動下注（RED / BLACK / ODD / EVEN）
 *   - 自動處理 Engine.IO heartbeat ping/pong（防斷線）
 *   - 斷線後自動重連（每次 default function 重建 WS 連線）
 *   - HMAC-SHA256 簽章（sig / nonce / ts / seq 嵌入事件 payload）
 *
 * Socket.IO 協定說明（Engine.IO v4）：
 *   EIO 封包類型（首字元）：0=OPEN 1=CLOSE 2=PING 3=PONG 4=MESSAGE
 *   SIO 封包類型（EIO MESSAGE 後首字元）：0=CONNECT 1=DISCONNECT 2=EVENT 3=ACK
 *   連線流程：
 *     Client WS → Server
 *     Server → "0{sid, pingInterval, ...}"           (EIO OPEN)
 *     Client → "40{\"token\":\"<jwt>\"}"              (SIO CONNECT with auth)
 *     Server → "40{\"sid\":\"...\"}"                  (SIO CONNECT ack)
 *     Bidirectional: "42[\"event\", payload]"          (SIO EVENT)
 *     Server → "2" (EIO PING)  Client → "3" (EIO PONG)
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
// WebSocket URL：http → ws，https → wss
const WS_BASE = BASE_URL.replace(/^http/, 'ws');
// Socket.IO endpoint（Engine.IO v4，直接升級 WebSocket）
const SIO_URL = `${WS_BASE}/socket.io/?EIO=4&transport=websocket`;

// ─────────────────────────── k6 配置 ───────────────────────────

export const options = {
  vus: 200,
  duration: '5m',
  thresholds: {
    // WebSocket 連線成功率
    ws_sessions: ['rate>0.95'],
    // 下注 ack 成功率
    roulette_bet_success: ['rate>0.98'],
    // HTTP 錯誤率（register 等）
    http_req_failed: ['rate<0.01'],
    // WS 訊息往返延遲 P95
    ws_msgs_sent: ['count>0'],
  },
};

// ─────────────────────────── 自訂指標 ───────────────────────────

const betsPlaced = new Counter('roulette_bets_placed');       // 下注次數
const betSuccessRate = new Rate('roulette_bet_success');      // 下注成功率
const phasesReceived = new Counter('roulette_phases');        // 收到的 phase 事件數
const reconnectCount = new Counter('roulette_reconnects');    // 重連次數

// ─────────────────────────── 工具函式 ───────────────────────────

function uuidv4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function decodeHmacKey(hmacKeyB64url) {
  return encoding.b64decode(hmacKeyB64url, 'rawurl', 'b');
}

function computeHmac(keyBuffer, canonical) {
  return crypto.hmac('sha256', keyBuffer, canonical, 'hex');
}

/**
 * 建構 roulette:bet HMAC canonical 字串
 * canonical: ${userId}|ROULETTE|${totalAmount}|${nonce}|${ts}
 */
function buildRouletteCanonical(userId, totalAmount, nonce, ts) {
  return `${userId}|ROULETTE|${totalAmount}|${nonce}|${ts}`;
}

/**
 * 隨機選擇輪盤下注類型（偶數金注，便於 canonical totalAmount 計算）
 */
function randomBetType() {
  const EVEN_MONEY_BETS = ['RED', 'BLACK', 'ODD', 'EVEN'];
  return EVEN_MONEY_BETS[Math.floor(Math.random() * EVEN_MONEY_BETS.length)];
}

// ─────────────────────────── Socket.IO 協定工具 ───────────────────────────

/**
 * 解析 Engine.IO / Socket.IO 封包
 * 回傳 { eioType, sioType?, data? }
 */
function parseSioPacket(msg) {
  if (typeof msg !== 'string' || msg.length === 0) {
    return { eioType: -1 };
  }
  const eioType = parseInt(msg[0], 10);
  if (eioType !== 4) {
    // 非 MESSAGE 封包（PING=2, PONG=3, OPEN=0, CLOSE=1）
    return { eioType };
  }
  // EIO MESSAGE → 解析 SIO 封包
  if (msg.length < 2) return { eioType };
  const sioType = parseInt(msg[1], 10);
  const payload = msg.slice(2);
  let data = null;
  if (payload.length > 0) {
    try {
      data = JSON.parse(payload);
    } catch {
      // 非 JSON（例如 SIO CONNECT ack 有時包含非標準格式）
      data = payload;
    }
  }
  return { eioType, sioType, data };
}

/**
 * 建構 Socket.IO EVENT 封包字串
 * 格式：42["event", payload]
 */
function sioEvent(event, payload) {
  return `42${JSON.stringify([event, payload])}`;
}

/**
 * Socket.IO CONNECT 封包（附帶 auth token）
 * 格式：40{"token":"<jwt>"}
 */
function sioConnect(token) {
  return `40${JSON.stringify({ token })}`;
}

// ─────────────────────────── VU 狀態（模組層級，每 VU 獨立） ───────────────────────────

let vuAccessToken = null;
let vuUserId = null;
let vuHmacKeyBuffer = null;
let vuSeq = 0;

function initVU() {
  if (vuAccessToken !== null) return;

  const username = `k6rlt${__VU}_${Date.now()}`;
  const password = 'K6LoadTest@2026!';

  const regRes = http.post(
    `${API}/auth/register`,
    JSON.stringify({ username, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );

  const regOk = check(regRes, { 'register: HTTP 201': (r) => r.status === 201 });
  if (!regOk) {
    console.error(`VU ${__VU} 輪盤 register 失敗 ${regRes.status}: ${regRes.body}`);
    return;
  }

  const regData = JSON.parse(regRes.body);
  vuAccessToken = regData.accessToken;
  vuUserId = regData.user.id;
  vuHmacKeyBuffer = decodeHmacKey(regData.hmacKey);
  vuSeq = 0;
}

// ─────────────────────────── WebSocket 連線（含 Socket.IO 握手） ───────────────────────────

/**
 * 建立 Socket.IO WebSocket 連線，持續運行直到 timeout 觸發關閉。
 * 斷線後由 default function 重新呼叫此函式（自動重連語義）。
 */
function connectRoulette(accessToken, userId, hmacKeyBuffer, seqRef) {
  // 設定 WS timeout（至多存活 55 秒，避免 VU 永久阻塞）
  const SESSION_TIMEOUT_MS = 55_000;

  let connected = false;          // SIO CONNECT ack 收到
  let currentRoundId = null;      // 當前回合 ID
  let currentPhase = null;        // 當前 phase
  let betSentThisPhase = false;   // 本 BETTING 階段已下注
  let pingTimer = null;           // 主動 PING 計時器 handle
  let closeReason = 'normal';

  const res = ws.connect(
    SIO_URL,
    { headers: { 'Authorization': `Bearer ${accessToken}` } },
    (socket) => {
      // ── 連線建立 ──
      socket.on('open', () => {
        // 送出 SIO CONNECT（帶 JWT auth）
        socket.send(sioConnect(accessToken));

        // 每 20 秒主動發 PING，保持連線
        pingTimer = socket.setInterval(() => {
          socket.send('2'); // EIO PING
        }, 20_000);

        // 全域 timeout：SESSION_TIMEOUT_MS 後關閉此 WS session
        socket.setTimeout(() => {
          closeReason = 'timeout';
          socket.close();
        }, SESSION_TIMEOUT_MS);
      });

      // ── 訊息處理 ──
      socket.on('message', (msg) => {
        const pkt = parseSioPacket(msg);

        // EIO PING → 立即回 PONG（防 server 逾時斷線）
        if (pkt.eioType === 2) {
          socket.send('3');
          return;
        }

        // SIO CONNECT ack（40...）
        if (pkt.eioType === 4 && pkt.sioType === 0) {
          connected = true;
          return;
        }

        // SIO EVENT（42...）
        if (pkt.eioType === 4 && pkt.sioType === 2 && Array.isArray(pkt.data)) {
          const [event, payload] = pkt.data;
          handleSioEvent(socket, event, payload, accessToken, userId, hmacKeyBuffer, seqRef);
        }
      });

      // ── 錯誤處理 ──
      socket.on('error', (e) => {
        console.warn(`VU ${__VU} WS 錯誤：${e.error}`);
        closeReason = 'error';
        socket.close();
      });

      // ── 連線關閉 ──
      socket.on('close', () => {
        if (pingTimer !== null) {
          socket.clearInterval(pingTimer);
        }
        // ws.connect 回傳，外層 default function 將重新呼叫（重連）
      });
    },
  );

  return res;

  // ── SIO 事件分發 ──
  function handleSioEvent(socket, event, payload, token, userId, keyBuffer, seqRef) {
    switch (event) {
      case 'roulette:phase': {
        phasesReceived.add(1);
        currentPhase = payload.phase;

        // 新回合開始時重設下注旗標
        if (payload.roundId !== currentRoundId) {
          currentRoundId = payload.roundId;
          betSentThisPhase = false;
        }

        // BETTING 階段：發送一注
        if (currentPhase === 'BETTING' && !betSentThisPhase && currentRoundId !== null) {
          betSentThisPhase = true;
          placeBet(socket, userId, keyBuffer, seqRef, currentRoundId);
        }
        break;
      }

      case 'roulette:bet_ack': {
        // bet_ack payload: { accepted: boolean, error?: string, totalBet?, remaining? }
        const accepted = payload && payload.accepted === true;
        betSuccessRate.add(accepted);
        if (!accepted && payload && payload.error) {
          // 常見：下注超出上限、階段已關閉（不視為嚴重錯誤）
        }
        break;
      }

      case 'roulette:result': {
        // 結算事件，重設下注旗標等待下一回合
        betSentThisPhase = false;
        break;
      }

      default:
        // jackpot:tick, chat:message 等廣播事件，不處理
        break;
    }
  }
}

/**
 * 發送 roulette:bet（含 HMAC 簽章）
 */
function placeBet(socket, userId, keyBuffer, seqRef, roundId) {
  const betType = randomBetType();
  const betAmount = 50; // 固定注額（偶數金注）
  const nonce = uuidv4();
  const ts = Date.now();
  const seq = ++seqRef.value;
  const canonical = buildRouletteCanonical(userId, betAmount, nonce, ts);
  const sig = computeHmac(keyBuffer, canonical);

  const betPayload = {
    roundId,
    bets: [{ type: betType, amount: betAmount }],
    sig,
    nonce,
    ts,
    seq,
  };

  socket.send(sioEvent('roulette:bet', betPayload));
  betsPlaced.add(1);
}

// ─────────────────────────── 主 VU 函式 ───────────────────────────

export default function () {
  // 初始化 VU（register + login）
  initVU();

  if (vuAccessToken === null) {
    console.error(`VU ${__VU} 輪盤 VU 初始化失敗，跳過`);
    sleep(2);
    return;
  }

  // seq 透過 ref 物件在 closures 間共享（JS 原始值不能以參考傳遞）
  const seqRef = { value: vuSeq };

  // 建立 WebSocket 連線（阻塞直到連線關閉）
  connectRoulette(vuAccessToken, vuUserId, vuHmacKeyBuffer, seqRef);

  // 更新 VU seq
  vuSeq = seqRef.value;

  // 斷線後短暫等待再重連（自動重連語義）
  reconnectCount.add(1);
  sleep(0.5 + Math.random());
}

// ─────────────────────────── 測試結束摘要 ───────────────────────────

export function handleSummary(data) {
  const metrics = data.metrics;
  const bets = metrics.roulette_bets_placed?.values.count ?? 0;
  const phases = metrics.roulette_phases?.values.count ?? 0;
  const betSucc = (metrics.roulette_bet_success?.values.rate ?? 0) * 100;
  const reconn = metrics.roulette_reconnects?.values.count ?? 0;

  return {
    stdout: `
=== 輪盤 WebSocket 壓力測試摘要 ===
Phase 事件收到：   ${phases}
下注次數：         ${bets}
下注成功率：       ${betSucc.toFixed(2)}%
WS 重連次數：      ${reconn}
HTTP 錯誤率：      ${((metrics.http_req_failed?.values.rate ?? 0) * 100).toFixed(2)}%
`,
  };
}
