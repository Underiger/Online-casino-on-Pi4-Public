<script setup lang="ts">
/**
 * DragonGateView：射龍門主頁面。
 * 開門（不動錢）→ 看門寬與倍率決定要不要下注 → 下注後一次性結算。
 */
import { computed, ref } from 'vue';
import { DRAGON_GATE_MAX_BET, DRAGON_GATE_MIN_BET } from '@casino/shared';

import { useDragonGateStore } from '../stores/dragon-gate';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import PlayingCard from '../components/common/PlayingCard.vue';

const store = useDragonGateStore();

const betInput = ref<number>(DRAGON_GATE_MIN_BET);

const canOpen = computed(() => !store.isOpening && !store.isBetting && store.currentRound === null);
const canBet = computed(
  () =>
    !store.isBetting &&
    store.currentRound !== null &&
    betInput.value >= DRAGON_GATE_MIN_BET &&
    betInput.value <= DRAGON_GATE_MAX_BET,
);

const outcomeLabel: Record<string, string> = {
  WIN: '中獎！',
  DOOR_HIT: '踩柱！賠雙倍',
  LOSE: '門外，輸了',
};
const outcomeClass: Record<string, string> = {
  WIN: 'outcome-win',
  DOOR_HIT: 'outcome-door-hit',
  LOSE: 'outcome-lose',
};

async function handleOpen(): Promise<void> {
  await store.openDoors();
}

async function handleBet(): Promise<void> {
  await store.bet(betInput.value);
}
</script>

<template>
  <div class="dragon-gate">
    <header class="header">
      <RouterLink to="/casino" class="back-btn" aria-label="返回大廳">← 大廳</RouterLink>
      <h1>射龍門</h1>
      <CoinDisplay />
    </header>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <section class="doors" v-if="store.currentRound !== null">
      <PlayingCard :card="store.currentRound.doors[0]" size="md" />
      <div class="gap-info">
        <div>門寬 {{ store.currentRound.gap }}</div>
        <div class="multiplier">賠率 ×{{ store.currentRound.multiplier }}</div>
      </div>
      <PlayingCard :card="store.currentRound.doors[1]" size="md" />
    </section>
    <section v-else class="doors placeholder">
      <PlayingCard size="md" />
      <div class="gap-info">按「開門」開始</div>
      <PlayingCard size="md" />
    </section>

    <section class="controls">
      <label>
        注額
        <input
          v-model.number="betInput"
          type="number"
          :min="DRAGON_GATE_MIN_BET"
          :max="DRAGON_GATE_MAX_BET"
          step="10"
        />
      </label>
      <button v-if="canOpen || store.currentRound === null" :disabled="!canOpen" @click="handleOpen">
        {{ store.isOpening ? '開門中…' : '開門' }}
      </button>
      <button v-else :disabled="!canBet" @click="handleBet">
        {{ store.isBetting ? '結算中…' : `下注 ${betInput}` }}
      </button>
    </section>

    <section v-if="store.lastResult" class="result" :class="outcomeClass[store.lastResult.outcome]">
      <PlayingCard class="third-card" :card="store.lastResult.thirdCard" size="sm" />
      <div class="outcome-text">{{ outcomeLabel[store.lastResult.outcome] }}</div>
      <div v-if="store.lastResult.outcome === 'WIN'">獲得 {{ store.lastResult.payout }} 金幣</div>
      <div v-else-if="store.lastResult.outcome === 'DOOR_HIT'">
        損失 {{ store.lastResult.betAmount * 2 }} 金幣
      </div>
      <div v-else>損失 {{ store.lastResult.betAmount }} 金幣</div>
    </section>
  </div>
</template>

<style scoped>
.dragon-gate {
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
.doors {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 24px;
  margin: 32px 0;
}
.gap-info {
  text-align: center;
  min-width: 100px;
}
.multiplier {
  font-weight: bold;
  color: #c80;
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
.result {
  text-align: center;
  padding: 16px;
  border-radius: 8px;
  margin-top: 16px;
}
.result .third-card {
  margin: 0 auto 8px;
}
.outcome-text {
  font-size: 20px;
  font-weight: bold;
}
.outcome-win {
  background: #e6ffe6;
}
.outcome-door-hit {
  background: #ffe6e6;
}
.outcome-lose {
  background: #f0f0f0;
}
</style>
