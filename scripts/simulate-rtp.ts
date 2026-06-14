#!/usr/bin/env tsx
/**
 * scripts/simulate-rtp.ts — M26 RTP 蒙地卡羅模擬腳本
 *
 * 功能：
 *   以 CSPRNG（crypto.randomInt）模擬老虎機長時間運行的回報率（RTP）。
 *   純演算法——不依賴資料庫、外部 API 或後端服務。
 *   支援 worker_threads 並行加速（預設 CPU 邏輯核心數）。
 *
 * 使用方式：
 *   npm run rtp:simulate -- [options]
 *   # 或直接執行：
 *   tsx scripts/simulate-rtp.ts [options]
 *
 * Options:
 *   --spins   <n>              旋轉次數（預設 10,000,000）
 *   --bet     <n>              固定注額 Coin（預設 10）
 *   --build   <none|typical>  護符配置（預設 none）
 *                               none    — 無護符、無幸運符號，驗證基礎 RTP 落於 90–94%
 *                               typical — 四葉草護符（CLOVER 全軸 ×1.3），驗證整體平衡
 *   --output  <file>           輸出 JSON 報告（可選，例如 results.json）
 *   --workers <n>              Worker 執行緒數（預設 CPU 邏輯核心數；1 = 單執行緒）
 *
 * CI 攔截：
 *   --build none 模式下，若實際 RTP 不在 [90%, 94%] 區間，腳本返回 exit code 1。
 *
 * 數值來源：
 *   backend/src/config/constants.ts（SLOT_BASE_WEIGHTS / SLOT_PAYTABLE / WEIGHT_PRECISION）
 *   本腳本內聯一份對應的常數副本，避免 TS 模組解析問題。
 */

import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { argv, exit } from 'node:process';
import { randomInt } from 'node:crypto';

// ─────────────────────────── 常數（鏡像 backend/src/config/constants.ts） ───────────────────────────

/** 符號列舉（順序需與 toReelTable 遍歷一致，保持穩定） */
const SLOT_SYMBOLS = ['CHERRY', 'LEMON', 'BELL', 'BAR', 'CLOVER', 'LUCKY7', 'DIAMOND', 'WILD'] as const;
type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

/** 基礎每軸權重（三軸同值；總和 100） */
const BASE_WEIGHTS: Readonly<Record<SlotSymbol, number>> = {
  CHERRY: 57,
  LEMON: 8,
  BELL: 7,
  BAR: 6,
  CLOVER: 8,
  LUCKY7: 5,
  DIAMOND: 5,
  WILD: 4,
};

/** 賠率表（CHERRY 有二連；其餘僅三連） */
const PAYTABLE: Readonly<Record<SlotSymbol, { triple: number; double: number | null }>> = {
  CHERRY: { triple: 4, double: 1 },
  LEMON: { triple: 5, double: null },
  BELL: { triple: 8, double: null },
  BAR: { triple: 12, double: null },
  CLOVER: { triple: 16, double: null },
  LUCKY7: { triple: 40, double: null },
  DIAMOND: { triple: 60, double: null },
  WILD: { triple: 100, double: null },
};

/** 護符浮點乘數精度（×100 後取整，對齊 backend 的 WEIGHT_PRECISION） */
const WEIGHT_PRECISION = 100;

// ─────────────────────────── Build 配置 ───────────────────────────

interface BuildConfig {
  /** 護符權重乘數（WEIGHT 型護符，疊乘至基礎表） */
  weightMultipliers: Partial<Record<SlotSymbol, number>>;
  /** Wild 替代規則（需 RULE 護符解鎖；兩個 build 皆不啟用） */
  wildSubstitute: boolean;
}

type BuildName = 'none' | 'typical';

const BUILDS: Record<BuildName, BuildConfig> = {
  /** 空 Build：無護符、無幸運符號 → 驗證基礎 RTP 落於 90–94% */
  none: {
    weightMultipliers: {},
    wildSubstitute: false,
  },
  /**
   * 典型 Build：四葉草護符（WEIGHT 型）
   *   effect: { symbol: 'CLOVER', reels: [1,2,3], multiplier: 1.3 }
   *   → CLOVER 全軸基礎權重 8 × 1.3 = 10.4，取整後各軸新增 240 累積權重單位
   *   用於驗證護符加成對整體 RTP 的影響（CLOVER 三連機率提升，同時稀釋 CHERRY 佔比）
   */
  typical: {
    weightMultipliers: { CLOVER: 1.3 },
    wildSubstitute: false,
  },
};

// ─────────────────────────── 轉軸查表（鏡像 loadout-compiler / sampler） ───────────────────────────

interface ReelTable {
  cum: number[];
  symbols: SlotSymbol[];
  total: number;
}

/** 浮點權重 → 整數 cum 累積表（完整鏡像 backend toReelTable 邏輯） */
function buildReelTable(config: BuildConfig): ReelTable {
  // 套用護符乘數至基礎表
  const weights: Record<SlotSymbol, number> = { ...BASE_WEIGHTS };
  for (const sym of SLOT_SYMBOLS) {
    const mult = config.weightMultipliers[sym];
    if (mult !== undefined) {
      weights[sym] = weights[sym]! * mult;
    }
  }

  const cum: number[] = [];
  const symbols: SlotSymbol[] = [];
  let running = 0;

  for (const sym of SLOT_SYMBOLS) {
    const w = weights[sym]!;
    if (w <= 0) continue;
    // Math.max(1, ...) 保底：護符不可能把符號「乘到消失」
    const scaled = Math.max(1, Math.round(w * WEIGHT_PRECISION));
    running += scaled;
    cum.push(running);
    symbols.push(sym);
  }

  if (running <= 0) {
    console.error('[simulate-rtp] 錯誤：轉軸表總權重必須為正（constants 配置錯誤）');
    exit(1);
  }

  return { cum, symbols, total: running };
}

/** 二分查找（鏡像 sampler.binarySearchCum） */
function binarySearchCum(cum: number[], point: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cum[mid] ?? Infinity) > point) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** 單軸抽樣（CSPRNG，鏡像 sampler.sampleReel） */
function sampleReel(table: ReelTable): SlotSymbol {
  const point = randomInt(table.total);
  const idx = binarySearchCum(table.cum, point);
  return table.symbols[idx]!;
}

// ─────────────────────────── 賠付評估（鏡像 payout.evaluateLine + settlePayout） ───────────────────────────

interface LineWin {
  kind: 'TRIPLE' | 'DOUBLE';
  symbol: SlotSymbol;
  multiplier: number;
}

/** 評估最佳連線（鏡像 payout.evaluateLine；此腳本不模擬保底/幸運符號） */
function evaluateLine(
  reels: [SlotSymbol, SlotSymbol, SlotSymbol],
  wildSubstitute: boolean,
): LineWin | null {
  const [a, b, c] = reels;
  const candidates: LineWin[] = [];

  // 自然三連（含 WILD×3 自我成線）
  if (a === b && b === c) {
    candidates.push({ kind: 'TRIPLE', symbol: a, multiplier: PAYTABLE[a].triple });
  }

  // Wild 替代三連（需 RULE 護符；兩個 build 皆不啟用）
  if (wildSubstitute) {
    const nonWild = reels.filter((s) => s !== 'WILD');
    const wildCount = reels.length - nonWild.length;
    const first = nonWild[0];
    if (wildCount > 0 && first !== undefined && nonWild.every((s) => s === first)) {
      candidates.push({
        kind: 'TRIPLE',
        symbol: first,
        multiplier: PAYTABLE[first].triple,
      });
    }
  }

  // CHERRY 二連（左起兩格；CHERRY 是唯一有 double 的符號）
  const matchA = a === 'CHERRY' || (wildSubstitute && a === 'WILD');
  const matchB = b === 'CHERRY' || (wildSubstitute && b === 'WILD');
  const hasRealCherry = a === 'CHERRY' || b === 'CHERRY'; // 防 Wild Wild 誤觸
  if (matchA && matchB && hasRealCherry && PAYTABLE.CHERRY.double !== null) {
    candidates.push({
      kind: 'DOUBLE',
      symbol: 'CHERRY',
      multiplier: PAYTABLE.CHERRY.double,
    });
  }

  if (candidates.length === 0) return null;

  // 取倍率最高；同倍率時偏好三連（排序穩定）
  candidates.sort((x, y) =>
    y.multiplier !== x.multiplier
      ? y.multiplier - x.multiplier
      : (y.kind === 'TRIPLE' ? 1 : 0) - (x.kind === 'TRIPLE' ? 1 : 0),
  );
  return candidates[0] ?? null;
}

// ─────────────────────────── 單執行緒模擬核心 ───────────────────────────

interface WorkerInput {
  spins: number;
  betAmount: number;
  buildName: BuildName;
}

interface WorkerResult {
  spins: number;
  totalBet: number;
  totalPayout: number;
  /** Σ (payout_i / bet)²：用於計算方差（Welford 替代方案） */
  sumPayoutRatioSq: number;
  tripleHits: Record<string, number>;
  doubleHits: Record<string, number>;
}

function runSimulation(input: WorkerInput): WorkerResult {
  const { spins, betAmount, buildName } = input;
  const config = BUILDS[buildName];
  const table = buildReelTable(config);
  const { wildSubstitute } = config;

  let totalPayout = 0;
  let sumPayoutRatioSq = 0;

  const tripleHits: Record<string, number> = {};
  const doubleHits: Record<string, number> = {};
  for (const sym of SLOT_SYMBOLS) {
    tripleHits[sym] = 0;
    doubleHits[sym] = 0;
  }

  for (let i = 0; i < spins; i++) {
    const reel1 = sampleReel(table);
    const reel2 = sampleReel(table);
    const reel3 = sampleReel(table);

    const win = evaluateLine([reel1, reel2, reel3], wildSubstitute);
    const payout = win !== null ? Math.floor(betAmount * win.multiplier) : 0;

    totalPayout += payout;
    const ratio = payout / betAmount;
    sumPayoutRatioSq += ratio * ratio;

    if (win !== null) {
      if (win.kind === 'TRIPLE') {
        tripleHits[win.symbol] = (tripleHits[win.symbol] ?? 0) + 1;
      } else {
        doubleHits[win.symbol] = (doubleHits[win.symbol] ?? 0) + 1;
      }
    }
  }

  return {
    spins,
    totalBet: spins * betAmount,
    totalPayout,
    sumPayoutRatioSq,
    tripleHits,
    doubleHits,
  };
}

// ─────────────────────────── 執行入口：Worker vs 主執行緒 ───────────────────────────

if (!isMainThread) {
  // Worker 執行緒：執行分段模擬後回傳結果給主執行緒，自然退出
  const input = workerData as WorkerInput;
  const result = runSimulation(input);
  parentPort!.postMessage(result);
} else {
  // 主執行緒：解析 CLI 參數、排程 Workers、彙總統計並輸出
  await main();
}

async function main(): Promise<void> {
  // ── CLI 參數解析 ──
  const args = argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      opts[args[i].slice(2)] = args[i + 1]!;
      i++;
    }
  }

  const totalSpins = parseInt(opts['spins'] ?? '10000000', 10);
  const betAmount = parseInt(opts['bet'] ?? '10', 10);
  const buildName = (opts['build'] ?? 'none') as BuildName;
  const outputPath = opts['output'] ?? null;
  const numWorkers = Math.max(1, parseInt(opts['workers'] ?? String(cpus().length), 10));

  // 輸入驗證
  if (!Number.isInteger(totalSpins) || totalSpins <= 0) {
    console.error('錯誤：--spins 必須為正整數');
    exit(1);
  }
  if (!Number.isInteger(betAmount) || betAmount <= 0) {
    console.error('錯誤：--bet 必須為正整數');
    exit(1);
  }
  if (buildName !== 'none' && buildName !== 'typical') {
    console.error('錯誤：--build 必須為 none 或 typical');
    exit(1);
  }
  if (!(buildName in BUILDS)) {
    console.error(`錯誤：未知 build "${buildName}"`);
    exit(1);
  }

  // Build 配置說明
  const buildDesc: Record<BuildName, string> = {
    none: '無護符（基礎 RTP 驗證）',
    typical: '四葉草護符（CLOVER ×1.3，整體平衡驗證）',
  };

  console.log(`\n🎰 RTP 蒙地卡羅模擬 — ${buildDesc[buildName]}`);
  console.log(
    `   旋轉次數：${totalSpins.toLocaleString()}｜注額：${betAmount} Coin｜執行緒：${numWorkers}`,
  );
  console.log('   模擬中，請稍候...\n');

  const startTime = Date.now();

  // ── 並行模擬：每個 Worker 分擔 spins/numWorkers 次旋轉 ──
  const spinsPerWorker = Math.floor(totalSpins / numWorkers);
  const remainder = totalSpins - spinsPerWorker * numWorkers;

  const workerPromises: Promise<WorkerResult>[] = [];

  for (let i = 0; i < numWorkers; i++) {
    const workerSpins = i === numWorkers - 1 ? spinsPerWorker + remainder : spinsPerWorker;
    const input: WorkerInput = { spins: workerSpins, betAmount, buildName };

    const p = new Promise<WorkerResult>((resolve, reject) => {
      // 指定當前模組路徑作為 Worker，繼承 tsx loader（execArgv 含 tsx 的 --import 旗標）
      const worker = new Worker(new URL(import.meta.url), {
        workerData: input,
        execArgv: [...process.execArgv],
      });
      worker.on('message', (result: WorkerResult) => resolve(result));
      worker.on('error', (err) => reject(err));
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker ${i} 以非零代碼退出：${code}`));
      });
    });

    workerPromises.push(p);
  }

  let results: WorkerResult[];
  try {
    results = await Promise.all(workerPromises);
  } catch (err) {
    // Worker 失敗時退回單執行緒（例如 tsx execArgv 傳遞失效的環境）
    console.warn(`⚠  Worker 執行緒啟動失敗（${(err as Error).message}），改用單執行緒...`);
    results = [runSimulation({ spins: totalSpins, betAmount, buildName })];
  }

  const elapsedMs = Date.now() - startTime;

  // ── 彙總各 Worker 結果 ──
  let totalBet = 0;
  let totalPayout = 0;
  let sumPayoutRatioSq = 0;
  const tripleHits: Record<string, number> = {};
  const doubleHits: Record<string, number> = {};

  for (const sym of SLOT_SYMBOLS) {
    tripleHits[sym] = 0;
    doubleHits[sym] = 0;
  }

  for (const r of results) {
    totalBet += r.totalBet;
    totalPayout += r.totalPayout;
    sumPayoutRatioSq += r.sumPayoutRatioSq;
    for (const sym of SLOT_SYMBOLS) {
      tripleHits[sym] = (tripleHits[sym] ?? 0) + (r.tripleHits[sym] ?? 0);
      doubleHits[sym] = (doubleHits[sym] ?? 0) + (r.doubleHits[sym] ?? 0);
    }
  }

  // ── 統計計算 ──
  const N = totalSpins;
  const rtp = totalPayout / totalBet; // 實際 RTP（0–1）

  // 每次旋轉的 payout ratio x_i = payout_i / bet
  // Var(x) = E[x²] - E[x]² = (sumPayoutRatioSq / N) - rtp²
  const variance = Math.max(0, sumPayoutRatioSq / N - rtp * rtp);
  const stdDev = Math.sqrt(variance);

  // 標準誤差（RTP 估計值的 SE）= SD(x) / sqrt(N)
  const standardError = N > 1 ? stdDev / Math.sqrt(N) : 0;
  const ci95Half = 1.96 * standardError;

  // 每符號命中率
  interface SymbolStat {
    tripleHits: number;
    tripleFrequency: number;
    doubleHits: number;
    doubleFrequency: number;
  }
  const symbolStats: Record<string, SymbolStat> = {};
  for (const sym of SLOT_SYMBOLS) {
    symbolStats[sym] = {
      tripleHits: tripleHits[sym] ?? 0,
      tripleFrequency: (tripleHits[sym] ?? 0) / N,
      doubleHits: doubleHits[sym] ?? 0,
      doubleFrequency: (doubleHits[sym] ?? 0) / N,
    };
  }

  // ── 終端輸出 ──
  const pct = (v: number): string => `${(v * 100).toFixed(4)}%`;
  const fmt = (n: number): string => n.toLocaleString();

  console.log(`${'═'.repeat(60)}`);
  console.log(`  RTP 模擬結果（Build: ${buildName}）`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  總模擬次數：  ${fmt(N)}`);
  console.log(`  總投注額：    ${fmt(totalBet)} Coin`);
  console.log(`  總賠付額：    ${fmt(totalPayout)} Coin`);
  console.log(`  實際 RTP：    ${pct(rtp)}  （${(rtp * 100).toFixed(4)}%）`);
  console.log(`  標準差（個別旋轉）：${stdDev.toFixed(6)}`);
  console.log(`  標準誤差：    ${(standardError * 100).toFixed(6)}%`);
  console.log(
    `  95% 信賴區間：[${pct(rtp - ci95Half)}, ${pct(rtp + ci95Half)}]`,
  );
  console.log(`  耗時：        ${elapsedMs.toLocaleString()} ms`);
  console.log(`${'─'.repeat(60)}`);
  console.log('  符號三連連線統計：');
  for (const sym of SLOT_SYMBOLS) {
    const stat = symbolStats[sym]!;
    if (stat.tripleHits > 0) {
      console.log(
        `    ${sym.padEnd(8)}  ${fmt(stat.tripleHits).padStart(12)} 次  (${pct(stat.tripleFrequency)})`,
      );
    }
  }
  console.log('  CHERRY 二連統計：');
  console.log(
    `    CHERRY   ${fmt(symbolStats['CHERRY']!.doubleHits).padStart(12)} 次  (${pct(symbolStats['CHERRY']!.doubleFrequency)})`,
  );
  console.log(`${'═'.repeat(60)}`);

  // ── CI 攔截（--build none 時 RTP 必須落於 90–94%） ──
  const RTP_LOWER = 0.90;
  const RTP_UPPER = 0.94;
  let exitCode = 0;

  if (buildName === 'none') {
    if (rtp < RTP_LOWER || rtp > RTP_UPPER) {
      console.error(
        `\n❌ CI 攔截：build=none 的 RTP ${pct(rtp)} 超出目標區間 [${pct(RTP_LOWER)}, ${pct(RTP_UPPER)}]`,
      );
      console.error('   請檢查 backend/src/config/constants.ts 的權重/賠率設定。');
      exitCode = 1;
    } else {
      console.log(
        `\n✅ CI 通過：RTP ${pct(rtp)} 落於 [${pct(RTP_LOWER)}, ${pct(RTP_UPPER)}]`,
      );
    }
  }

  // ── JSON 輸出（可選） ──
  if (outputPath !== null) {
    const report = {
      meta: {
        generatedAt: new Date().toISOString(),
        elapsedMs,
        spins: N,
        betAmount,
        build: buildName,
        workers: numWorkers,
      },
      rtp,
      rtpPercent: parseFloat((rtp * 100).toFixed(6)),
      totalBet,
      totalPayout,
      stdDev,
      standardError,
      ci95: {
        lower: rtp - ci95Half,
        upper: rtp + ci95Half,
        lowerPercent: parseFloat(((rtp - ci95Half) * 100).toFixed(6)),
        upperPercent: parseFloat(((rtp + ci95Half) * 100).toFixed(6)),
      },
      ciGate:
        buildName === 'none'
          ? { target: [RTP_LOWER, RTP_UPPER], passed: rtp >= RTP_LOWER && rtp <= RTP_UPPER }
          : null,
      symbolStats,
    };

    try {
      writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`\n📄 JSON 報告已寫入：${outputPath}`);
    } catch (err) {
      console.error(`\n⚠  JSON 輸出失敗：${(err as Error).message}`);
    }
  }

  exit(exitCode);
}
