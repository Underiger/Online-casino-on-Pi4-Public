/**
 * 遊戲數值常數（01_GDD §3.2/§3.3、05_MILESTONES M10）。
 *
 * ★ 調參守則（05_MILESTONES §4 風險緩衝）：
 *   權重表 / 賠率表全部集中本檔，M26 RTP 模擬調參只動數值、不動程式邏輯。
 *   任何數值變動必須同步 bump WEIGHT_TABLE_VERSION——
 *   loadoutHash 含版本號，舊 CompiledLoadout 快取自然失效。
 *
 * 與 packages/shared/src/constants.ts 的關係：
 *   注額檔位、PITY/LUCKY 倍率等「前端也需要的展示值」在 shared 另有一份；
 *   backend 暫無法直接 import shared 的 .ts 入口（rootDir 限制，同 sockets/events.ts
 *   檔頭說明），本檔為權威數值來源，shared 側為展示鏡像。
 *
 * RTP 解析計算（三軸同表、無護符、無幸運符號）：
 *   p = w/100；RTP = Σ p³ × 三連倍率 + p(CHERRY)² × (1−p(CHERRY)) × 二連倍率
 *   以下權重代入 ≈ 0.7408(🍒三連) + 0.1397(🍒二連) + 0.0026 + 0.0027
 *               + 0.0026 + 0.0082 + 0.0050 + 0.0075 + 0.0064 ≈ **91.5%**
 *   落在 GDD 目標 92% ± 2 區間（M26 蒙地卡羅 1,000 萬次複核）。
 *   註：GDD §3.3.2 的權重表為「結構示例」（其數值解析 RTP 僅 ~30%，與 §2.4
 *   凍結的 92% 目標矛盾）；本檔以 RTP 目標為準回推數值。
 */

// ─────────────────────────── 符號 ───────────────────────────

/**
 * 轉軸符號（與 packages/shared SlotSymbol enum、GDD §3.2 順序一致）。
 * 以 const tuple 定義（backend 不依賴 shared 的 TS enum）。
 */
export const SLOT_SYMBOLS = [
  'CHERRY',
  'LEMON',
  'BELL',
  'BAR',
  'CLOVER',
  'LUCKY7',
  'DIAMOND',
  'WILD',
] as const;

export type SlotSymbol = (typeof SLOT_SYMBOLS)[number];

// ─────────────────────────── 注額 ───────────────────────────

/** 可選注額三檔（GDD §3.1） */
export const SLOT_BET_AMOUNTS = [10, 50, 100] as const;
export type SlotBetAmount = (typeof SLOT_BET_AMOUNTS)[number];

/** 轉軸數 */
export const SLOT_REEL_COUNT = 3;

// ─────────────────────────── 權重表 ───────────────────────────

/**
 * 權重表版本：任何權重 / 賠率數值變動必須 +1（loadoutHash 的一部分）。
 */
export const WEIGHT_TABLE_VERSION = 1;

/**
 * 每軸基礎權重（GDD §3.3.2：每軸一張靜態表；初版三軸同值，結構保留每軸獨立）。
 * 總和 100。CHERRY 高頻低賠主導 RTP（見檔頭解析計算）。
 */
const BASE_REEL_WEIGHTS: Readonly<Record<SlotSymbol, number>> = {
  CHERRY: 57,
  LEMON: 8,
  BELL: 7,
  BAR: 6,
  CLOVER: 8,
  LUCKY7: 5,
  DIAMOND: 5,
  WILD: 4,
};

/** 三軸權重表（index 0–2 = 第 1–3 軸） */
export const SLOT_BASE_WEIGHTS: ReadonlyArray<Readonly<Record<SlotSymbol, number>>> = [
  BASE_REEL_WEIGHTS,
  BASE_REEL_WEIGHTS,
  BASE_REEL_WEIGHTS,
];

/**
 * 浮點權重 → 整數權重的縮放精度（rngInt 只收整數上限）。
 * 護符乘數（×1.3 等）作用後以此精度取整：57 × 1.3 = 74.1 → 7410 / 精度 100。
 */
export const WEIGHT_PRECISION = 100;

// ─────────────────────────── 賠率表 ───────────────────────────

export interface PaytableRow {
  /** 三連倍率（× 注額） */
  triple: number;
  /** 二連倍率（左起兩格；null = 該符號無二連賠付） */
  double: number | null;
}

/** 賠率表（GDD §3.2 凍結；僅 CHERRY 有二連） */
export const SLOT_PAYTABLE: Readonly<Record<SlotSymbol, PaytableRow>> = {
  CHERRY: { triple: 4, double: 1 },
  LEMON: { triple: 5, double: null },
  BELL: { triple: 8, double: null },
  BAR: { triple: 12, double: null },
  CLOVER: { triple: 16, double: null },
  LUCKY7: { triple: 40, double: null },
  DIAMOND: { triple: 60, double: null },
  WILD: { triple: 100, double: null },
};

// ─────────────────────────── 加成 ───────────────────────────

/** 今日幸運符號：權重 ×1.5（編譯期，GDD §3.3.2 步驟 2） */
export const LUCKY_SYMBOL_WEIGHT_MULTIPLIER = 1.5;

/** 今日幸運符號：該符號形成連線時賠率 ×1.5（結算期，GDD §3.2/§5.1） */
export const LUCKY_SYMBOL_PAYOUT_MULTIPLIER = 1.5;

/** Diamond 三連附加 Jackpot 點數（GDD §3.2） */
export const JACKPOT_POINTS_DIAMOND_TRIPLE = 50;
