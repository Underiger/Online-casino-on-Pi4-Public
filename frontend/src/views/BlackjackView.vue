<script setup lang="ts">
/**
 * BlackjackView：二十一點主頁面。
 * 下注發牌 → 要牌/停牌/加倍 → 結算（莊家補牌與結算在同一次請求內跑完）。
 */
import { computed, ref } from 'vue';
import { BLACKJACK_MAX_BET, BLACKJACK_MIN_BET } from '@casino/shared';
import type { Card } from '@casino/shared';

import { useBlackjackStore } from '../stores/blackjack';
import CoinDisplay from '../components/common/CoinDisplay.vue';
import PlayingCard from '../components/common/PlayingCard.vue';

const store = useBlackjackStore();
const betInput = ref<number>(BLACKJACK_MIN_BET);

/** A 算 11、J/Q/K 算 10，逐張降軟硬（只供前端顯示用，正式判定一律以伺服器回應為準） */
function handValue(cards: Card[]): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 14) {
      total += 11;
      aces += 1;
    } else {
      total += Math.min(c.rank, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

const canDeal = computed(
  () => !store.isDealing && store.round === null && betInput.value >= BLACKJACK_MIN_BET && betInput.value <= BLACKJACK_MAX_BET,
);
const inProgress = computed(() => store.round !== null && !store.round.settled);
const canDouble = computed(
  () => inProgress.value && !store.isActing && store.round !== null && !store.round.settled && store.round.playerCards.length === 2 && !store.round.doubled,
);

const resultLabel: Record<string, string> = {
  BLACKJACK: 'Blackjack！賠率 3:2',
  WIN: '你贏了！',
  DEALER_BUST: '莊家爆牌，你贏了！',
  PUSH: '平手，退回注金',
  LOSE: '莊家獲勝',
  BUST: '爆牌！你輸了',
};

async function handleDeal(): Promise<void> {
  await store.deal(betInput.value);
}
</script>

<template>
  <div class="blackjack">
    <header class="header">
      <RouterLink to="/casino" class="back-btn" aria-label="返回大廳">← 大廳</RouterLink>
      <h1>Blackjack 二十一點</h1>
      <CoinDisplay />
    </header>

    <p v-if="store.error" class="error">{{ store.error }}</p>

    <template v-if="store.round !== null">
      <section class="hand dealer-hand">
        <div class="hand-label">
          莊家：{{ store.round.settled ? handValue(store.round.dealerCards) : '?' }}
        </div>
        <div class="cards">
          <PlayingCard
            v-for="(card, i) in store.round.settled ? store.round.dealerCards : [store.round.dealerUpCard]"
            :key="i"
            :card="card"
            size="sm"
          />
          <PlayingCard v-if="!store.round.settled" size="sm" />
        </div>
      </section>

      <section class="hand player-hand">
        <div class="hand-label">你的手牌：{{ handValue(store.round.playerCards) }}　注金 {{ store.round.betAmount }}</div>
        <div class="cards">
          <PlayingCard v-for="(card, i) in store.round.playerCards" :key="i" :card="card" size="sm" />
        </div>
      </section>
    </template>

    <section v-if="store.round === null" class="controls">
      <label>
        注額
        <input v-model.number="betInput" type="number" :min="BLACKJACK_MIN_BET" :max="BLACKJACK_MAX_BET" step="10" />
      </label>
      <button :disabled="!canDeal" @click="handleDeal">
        {{ store.isDealing ? '發牌中…' : '發牌' }}
      </button>
    </section>

    <section v-else-if="inProgress" class="controls">
      <button :disabled="store.isActing" @click="store.hit()">要牌</button>
      <button :disabled="store.isActing" @click="store.stand()">停牌</button>
      <button :disabled="!canDouble" @click="store.double()">加倍</button>
    </section>

    <section v-else class="controls">
      <p v-if="store.round?.settled" class="outcome-text">
        {{ resultLabel[store.round.resultKey] }}　派彩 {{ store.round.payout }}
      </p>
      <button @click="store.startNewRound()">再來一局</button>
    </section>
  </div>
</template>

<style scoped>
.blackjack {
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
.hand {
  margin: 16px 0;
  text-align: center;
}
.hand-label {
  font-weight: bold;
  margin-bottom: 8px;
}
.cards {
  display: flex;
  justify-content: center;
  gap: 8px;
  flex-wrap: wrap;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin: 24px 0;
  flex-wrap: wrap;
}
.controls input {
  width: 80px;
}
.outcome-text {
  width: 100%;
  text-align: center;
  font-size: 18px;
  font-weight: bold;
  color: #c80;
}
</style>
