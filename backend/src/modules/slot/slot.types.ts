/**
 * 老虎機核心型別（01_GDD §3.3.2 CompiledLoadout 結構、04_FOLDER_STRUCTURE §1）。
 *
 * CompiledLoadout 是「裝備/卸下護符時」一次編譯的產物（loadout-compiler.ts），
 * 旋轉熱路徑（sampler.ts / payout.ts）只查表、零機率計算。
 * 序列化後存 Redis `slot:loadout:{userId}`（TTL 24h，M11/M13 接線）。
 */
import type { SlotSymbol } from '../../config/constants.js';

export type { SlotSymbol } from '../../config/constants.js';

// ─────────────────────────── 轉軸表 ───────────────────────────

/**
 * 單軸抽樣表：cum 為「整數累積權重」嚴格遞增陣列，symbols 一一對應。
 * 抽樣：point = rngInt(cum 最末值)，二分查找最小 i 使 cum[i] > point → symbols[i]。
 */
export interface ReelTable {
  cum: number[];
  symbols: SlotSymbol[];
}

/** 三軸固定 tuple */
export type ReelTables = [ReelTable, ReelTable, ReelTable];

/** 旋轉結果：三軸各一符號 */
export type SlotReels = [SlotSymbol, SlotSymbol, SlotSymbol];

// ─────────────────────────── 條件變體（CONDITIONAL 護符） ───────────────────────────

/**
 * 條件型護符的預編譯變體表（GDD §3.3.2 步驟 6）：
 * 第三軸抽樣前檢查前兩軸，命中 trigger 時直接改用 table 抽樣——
 * 仍是查表，不在旋轉時改權重。
 */
export interface CompiledVariant {
  /** 觸發條件：前兩軸皆為此符號 */
  trigger: { reel12: SlotSymbol };
  /** 變體作用的轉軸（0-based；初版固定 2 = 第三軸） */
  reelIndex: number;
  /** 以「最終表」（基礎 × WEIGHT × 幸運符號）為底、再施加變體乘數的抽樣表 */
  table: ReelTable;
}

// ─────────────────────────── 規則（RULE / PITY / BONUS 護符） ───────────────────────────

/** BONUS 型護符：指定符號中獎時附加 Jackpot 點數 */
export interface CompiledBonus {
  onSymbol: SlotSymbol;
  jackpotPoints: number;
}

export interface CompiledRules {
  /** Wild 是否可替代其他符號參與連線（預設 false，需 RULE 護符解鎖；GDD §3.2） */
  wildSubstitute: boolean;
  /** 保底門檻（連續未中獎次數）；null = 未裝備 PITY 護符，保底不生效 */
  pityThreshold: number | null;
  /** 保底觸發時的中獎倍率乘數（= 1 + 護符 bonus）；pityThreshold 為 null 時固定 1 */
  pityMultiplier: number;
  /** BONUS 型護符效果（可多枚疊加） */
  bonuses: CompiledBonus[];
}

// ─────────────────────────── 編譯產物 ───────────────────────────

/** GDD §3.3.2 步驟 3 的編譯產物；JSON 可序列化（Redis 快取） */
export interface CompiledLoadout {
  /** sha256(userId | 排序後護符 codes | luckySymbol | 表版本) → hex */
  loadoutHash: string;
  reels: ReelTables;
  /** key = CONDITIONAL 護符 code */
  variants: Record<string, CompiledVariant>;
  rules: CompiledRules;
  /** = WEIGHT_TABLE_VERSION（數值調參後舊快取自然失效） */
  version: number;
}

// ─────────────────────────── 編譯輸入 ───────────────────────────

/**
 * 已裝備護符（編譯輸入）：M13 從 UserCharm JOIN Charm 取得。
 * effect 為 DB Json 欄位原樣傳入，由 compiler 依 type 以 zod 解析。
 */
export interface EquippedCharm {
  code: string;
  type: 'WEIGHT' | 'RULE' | 'CONDITIONAL' | 'PITY' | 'BONUS';
  effect: unknown;
}

// ─────────────────────────── 賠付 ───────────────────────────

/** 連線種類 */
export type LineKind = 'TRIPLE' | 'DOUBLE' | 'NONE';

export interface PayoutInput {
  reels: SlotReels;
  /** 注額（正整數；M11 由 SpinReq schema 保證三檔之一） */
  betAmount: number;
  rules: CompiledRules;
  /** 進場前的連續未中獎計數（Redis slot:pity:{userId}） */
  pityCounter: number;
  /** 今日幸運符號（null = 今日未設定） */
  luckySymbol: SlotSymbol | null;
}

export interface PayoutResult {
  /** 贏分（整數 Coin；0 = 未中獎） */
  winAmount: number;
  /** 連線種類 */
  lineKind: LineKind;
  /** 形成連線的有效符號（Wild 替代後的目標符號）；未中獎為 null */
  effectiveSymbol: SlotSymbol | null;
  /** 賠率表基礎倍率（不含幸運/保底加成）；未中獎為 0 */
  baseMultiplier: number;
  /** 本次連線是否用到 Wild 替代 */
  wildUsed: boolean;
  /** 幸運符號 ×1.5 是否生效 */
  luckyApplied: boolean;
  /** 保底加成是否生效（中獎且計數達門檻） */
  pityApplied: boolean;
  /** 旋轉後的保底計數（中獎 → 0；未中獎 → +1） */
  pityCounterAfter: number;
  /** 本次獲得的 Jackpot 點數（Diamond 三連 50 + BONUS 護符） */
  jackpotPointsEarned: number;
}
