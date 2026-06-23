<script setup lang="ts">
/**
 * HighLowView：猜高低主頁面。
 * 下注開局 → 看基準牌猜高/低 → 猜對可收手或續押（連勝上限 5）→ 猜錯或收手後回到下注畫面。
 */
import { computed, ref } from 'vue';
import { HIGH_LOW_MAX_BET, HIGH_LOW_MAX_STREAK, HIGH_LOW_MIN_BET } from '@casino/shared';

import { useHighLowStore } from '../stores/high-low';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import PlayingCard from '../components/common/PlayingCard.vue';

const store = useHighLowStore();
const betInput = ref<number>(HIGH_LOW_MIN_BET);

const canDeal = computed(
  () => !store.isDealing && store.round === null && betInput.value >= HIGH_LOW_MIN_BET && betInput.value <= HIGH_LOW_MAX_BET,
);
const canGuessHigh = computed(
  () => store.round !== null && store.round.state === 'GUESSING' && !store.isActing && store.round.baseCard.rank !== 14,
);
const canGuessLow = computed(
  () => store.round !== null && store.round.state === 'GUESSING' && !store.isActing && store.round.baseCard.rank !== 2,
);
const canAct = computed(() => store.round !== null && store.round.state === 'RESULT' && !store.isActing);

const outcomeLabel: Record<string, string> = {
  PUSH: '同點數，平手！換新基準牌再猜',
  WIN_CONTINUE: '猜對了！',
  WIN_MAX_STREAK: '達到連勝上限，強制收手！',
  LOSE: '猜錯了，彩池歸零',
  CASH_OUT: '收手入袋！',
};

async function handleDeal(): Promise<void> {
  await store.deal(betInput.value);
}
</script>

<template>
  <div class="high-low">
    <header class="header">
      <RouterLink to="/casino" class="back-btn" aria-label="返回大廳">← 大廳</RouterLink>
      <h1>猜高低</h1>
      <CoinDisplay />
    </header>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <section v-if="store.round !== null" class="round-info">
      <div>彩池 {{ store.round.pot }}</div>
      <div>連勝 {{ store.round.streak }}/{{ HIGH_LOW_MAX_STREAK }}</div>
    </section>

    <section class="card-area">
      <PlayingCard :card="store.round?.baseCard" size="md" />
      <PlayingCard v-if="store.lastOutcome?.revealedCard" :card="store.lastOutcome.revealedCard" size="md" />
    </section>

    <section v-if="store.round === null" class="controls">
      <label>
        注額
        <input v-model.number="betInput" type="number" :min="HIGH_LOW_MIN_BET" :max="HIGH_LOW_MAX_BET" step="10" />
      </label>
      <button :disabled="!canDeal" @click="handleDeal">
        {{ store.isDealing ? '發牌中…' : '下注發牌' }}
      </button>
    </section>

    <section v-else-if="store.round.state === 'GUESSING'" class="controls">
      <button :disabled="!canGuessHigh" @click="store.guess(true)">▲ 比較高</button>
      <button :disabled="!canGuessLow" @click="store.guess(false)">▼ 比較低</button>
    </section>

    <section v-else class="controls">
      <button :disabled="!canAct" @click="store.cashOut()">💰 收手入袋（{{ store.round.pot }}）</button>
      <button :disabled="!canAct" @click="store.continueRound()">▶ 繼續挑戰</button>
    </section>

    <p v-if="store.lastOutcome" class="outcome-text">
      {{ outcomeLabel[store.lastOutcome.outcome] }}
      <span v-if="store.lastOutcome.payout">獲得 {{ store.lastOutcome.payout }} 金幣</span>
    </p>
  </div>
</template>

<style scoped>
.high-low {
  max-width: 640px;
  margin: 0 auto;
  padding: 24px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.back-btn {
  color: #666;
  text-decoration: none;
  font-size: 0.9rem;
  transition: color 0.2s;
}
.back-btn:hover {
  color: #c80;
}
.error {
  color: #d33;
  margin: 12px 0;
}
.round-info {
  display: flex;
  justify-content: center;
  gap: 32px;
  margin: 12px 0;
  font-weight: bold;
}
.card-area {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  margin: 24px 0;
  min-height: 130px;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin: 24px 0;
}
.controls input {
  width: 80px;
}
.outcome-text {
  text-align: center;
  font-size: 18px;
  font-weight: bold;
  color: #c80;
}
</style>
