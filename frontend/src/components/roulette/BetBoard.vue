<template>
  <!-- Roulette bet board: numbers grid + outside bets -->
  <div class="bet-board" :class="{ disabled: !canBet }">

    <!-- ── Number grid section ─────────────────────────────────────────────── -->
    <div class="grid-section">

      <!-- 0 (spans all 3 rows visually) -->
      <button
        class="num-btn green zero-btn"
        :disabled="!canBet"
        :title="betLabel(RouletteBetType.STRAIGHT, 0)"
        @click="onNumberClick(0)"
      >
        <span class="num-label">0</span>
        <BetBadge :amount="betAmountByType.get('STRAIGHT:0') ?? 0" />
      </button>

      <!-- 1-36 in a 3×12 CSS grid (row: n%3, col: ceil(n/3)) -->
      <div class="num-grid">
        <button
          v-for="n in 36"
          :key="n"
          class="num-btn"
          :class="numBgClass(n)"
          :style="numGridPos(n)"
          :disabled="!canBet"
          :title="betLabel(RouletteBetType.STRAIGHT, n)"
          @click="onNumberClick(n)"
        >
          <span class="num-label">{{ n }}</span>
          <BetBadge :amount="betAmountByType.get(`STRAIGHT:${n}`) ?? 0" />
        </button>
      </div>

      <!-- Column 2:1 bets (right of each row) -->
      <div class="col-bets">
        <button
          v-for="col in [3, 2, 1]"
          :key="col"
          class="outside-btn col-btn"
          :disabled="!canBet"
          :title="betLabel(RouletteBetType.COLUMN, undefined, col)"
          @click="onColumnClick(col as 1 | 2 | 3)"
        >
          <span>2:1</span>
          <BetBadge :amount="betAmountByType.get(`COLUMN:${col}`) ?? 0" />
        </button>
      </div>
    </div>

    <!-- ── Dozen bets ──────────────────────────────────────────────────────── -->
    <div class="dozens-row">
      <button
        v-for="d in DOZENS"
        :key="d.dozen"
        class="outside-btn dozen-btn"
        :disabled="!canBet"
        :title="betLabel(RouletteBetType.DOZEN, undefined, undefined, d.dozen)"
        @click="onDozenClick(d.dozen)"
      >
        <span class="outside-label">{{ d.label }}</span>
        <BetBadge :amount="betAmountByType.get(`DOZEN:${d.dozen}`) ?? 0" />
      </button>
    </div>

    <!-- ── Even-money bets ────────────────────────────────────────────────── -->
    <div class="even-money-row">
      <button
        v-for="bet in EVEN_MONEY"
        :key="bet.type"
        class="outside-btn"
        :class="bet.cls"
        :disabled="!canBet"
        :title="betLabel(bet.type)"
        @click="onOutsideBetClick(bet.type)"
      >
        <span class="outside-label">{{ bet.label }}</span>
        <BetBadge :amount="betAmountByType.get(bet.type) ?? 0" />
      </button>
    </div>

    <!-- ── Toolbar ─────────────────────────────────────────────────────────── -->
    <div class="toolbar">
      <span class="chip-hint">
        籌碼 <strong>{{ chipAmount }}</strong> Coin
      </span>
      <button
        v-if="hasBets"
        class="cancel-btn"
        :disabled="!canBet"
        @click="emit('cancel-bets')"
      >
        清除全部
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouletteBetType } from '@casino/shared';
import type { PersonalBet } from '../../stores/roulette';

// ─── Inline sub-component: small bet amount badge ───────────────────────────

const BetBadge = {
  props: { amount: Number },
  template: `<span v-if="amount > 0" class="bet-badge">{{ amount }}</span>`,
};

// ─── Constants ────────────────────────────────────────────────────────────

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const DOZENS = [
  { dozen: 1 as const, label: '1-12' },
  { dozen: 2 as const, label: '13-24' },
  { dozen: 3 as const, label: '25-36' },
];

const EVEN_MONEY = [
  { type: 'LOW'   as RouletteBetType, label: '1-18',  cls: '' },
  { type: 'EVEN'  as RouletteBetType, label: '偶',    cls: '' },
  { type: 'RED'   as RouletteBetType, label: '紅',    cls: 'red-btn' },
  { type: 'BLACK' as RouletteBetType, label: '黑',    cls: 'black-btn' },
  { type: 'ODD'   as RouletteBetType, label: '奇',    cls: '' },
  { type: 'HIGH'  as RouletteBetType, label: '19-36', cls: '' },
];

// ─── Props & Emits ──────────────────────────────────────────────────────────

const props = defineProps<{
  chipAmount: number;
  /** Map from store's betAmountByType computed */
  betAmountByType: Map<string, number>;
  phase: string;
}>();

type EmittedBet = Omit<PersonalBet, '_id'>;

const emit = defineEmits<{
  'place-bet': [bet: EmittedBet];
  'cancel-bets': [];
}>();

// ─── Computed ────────────────────────────────────────────────────────────────

const canBet = computed(() => props.phase === 'BETTING');

const hasBets = computed(() => {
  for (const [, v] of props.betAmountByType) {
    if (v > 0) return true;
  }
  return false;
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function numBgClass(n: number): string {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

/**
 * Place number n in the correct cell of the 3×12 grid.
 * col = ceil(n/3), row: n%3===0 → 1, n%3===2 → 2, n%3===1 → 3
 */
function numGridPos(n: number): { gridColumn: string; gridRow: string } {
  const col = Math.ceil(n / 3);
  const rem = n % 3;
  const row = rem === 0 ? 1 : rem === 2 ? 2 : 3;
  return { gridColumn: String(col), gridRow: String(row) };
}

function betLabel(
  type: RouletteBetType,
  num?: number,
  col?: number,
  doz?: number,
): string {
  if (type === 'STRAIGHT') return `直注 ${num ?? 0}（×35）`;
  if (type === 'COLUMN')   return `第 ${col} 列（×2）`;
  if (type === 'DOZEN')    return `第 ${doz} 打（×2）`;
  if (type === 'RED')      return '紅色（×1）';
  if (type === 'BLACK')    return '黑色（×1）';
  if (type === 'ODD')      return '奇數（×1）';
  if (type === 'EVEN')     return '偶數（×1）';
  if (type === 'LOW')      return '小（1-18）（×1）';
  if (type === 'HIGH')     return '大（19-36）（×1）';
  return type;
}

// ─── Event handlers ──────────────────────────────────────────────────────────

function onNumberClick(n: number): void {
  if (!canBet.value) return;
  emit('place-bet', { type: RouletteBetType.STRAIGHT, amount: props.chipAmount, number: n });
}

function onColumnClick(col: 1 | 2 | 3): void {
  if (!canBet.value) return;
  emit('place-bet', { type: RouletteBetType.COLUMN, amount: props.chipAmount, column: col });
}

function onDozenClick(dozen: 1 | 2 | 3): void {
  if (!canBet.value) return;
  emit('place-bet', { type: RouletteBetType.DOZEN, amount: props.chipAmount, dozen });
}

function onOutsideBetClick(type: RouletteBetType): void {
  if (!canBet.value) return;
  emit('place-bet', { type, amount: props.chipAmount });
}
</script>

<style scoped>
/* ── Root ───────────────────────────────────────────────────────────────── */
.bet-board {
  user-select: none;
  font-size: 0.75rem;
}

.bet-board.disabled {
  opacity: 0.6;
  pointer-events: none;
}

/* ── Grid section (0 + 1-36 + column bets) ─────────────────────────────── */
.grid-section {
  display: flex;
  align-items: stretch;
  gap: 3px;
}

/* 0 button: spans 3 rows */
.zero-btn {
  width: 36px;
  flex-shrink: 0;
  writing-mode: vertical-rl;
  text-orientation: mixed;
}

/* 12-column × 3-row number grid */
.num-grid {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: repeat(3, 1fr);
  gap: 2px;
}

/* 3 column-bet buttons stacked on the right */
.col-bets {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 36px;
  flex-shrink: 0;
}

.col-btn {
  flex: 1;
  font-size: 0.65rem;
  font-weight: 700;
}

/* ── Number buttons ─────────────────────────────────────────────────────── */
.num-btn {
  position: relative;
  border: none;
  border-radius: 3px;
  padding: 0;
  cursor: pointer;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: filter 0.1s ease, transform 0.1s ease;
}

.num-btn:hover:not(:disabled) {
  filter: brightness(1.35);
  transform: scale(1.07);
  z-index: 2;
}

.num-btn:active:not(:disabled) {
  transform: scale(0.95);
}

.num-btn.red   { background: #b91c1c; }
.num-btn.black { background: #1c1917; }
.num-btn.green { background: #15803d; }

.num-label {
  color: #fff;
  font-weight: 700;
  font-size: 0.72rem;
  line-height: 1;
}

/* ── Outside bet rows ───────────────────────────────────────────────────── */
.dozens-row,
.even-money-row {
  display: flex;
  gap: 3px;
  margin-top: 3px;
}

.outside-btn {
  position: relative;
  flex: 1;
  height: 30px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: background 0.12s ease, transform 0.1s ease;
}

.outside-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.18);
  transform: scale(1.04);
}

.outside-btn:active:not(:disabled) {
  transform: scale(0.96);
}

.outside-label {
  font-size: 0.72rem;
  font-weight: 700;
  color: #e2e8f0;
}

.red-btn   { background: rgba(185, 28, 28, 0.5); border-color: #b91c1c; }
.red-btn:hover:not(:disabled) { background: rgba(185, 28, 28, 0.75); }

.black-btn { background: rgba(28, 25, 23, 0.7); border-color: #44403c; }
.black-btn:hover:not(:disabled) { background: rgba(28, 25, 23, 0.9); }

/* ── Bet badge ──────────────────────────────────────────────────────────── */
/* Note: :deep needed if using a sub-component; scoped styles work inline here */
:deep(.bet-badge) {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  background: #fbbf24;
  color: #1c1917;
  font-size: 0.6rem;
  font-weight: 800;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  line-height: 1;
}

/* ── Toolbar ────────────────────────────────────────────────────────────── */
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding: 0 2px;
}

.chip-hint {
  font-size: 0.75rem;
  color: #94a3b8;
}

.chip-hint strong {
  color: #fbbf24;
}

.cancel-btn {
  font-size: 0.72rem;
  padding: 4px 10px;
  border: 1px solid rgba(239, 68, 68, 0.5);
  border-radius: 4px;
  background: rgba(239, 68, 68, 0.15);
  color: #fca5a5;
  cursor: pointer;
  transition: background 0.12s ease;
}

.cancel-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.3);
}
</style>
