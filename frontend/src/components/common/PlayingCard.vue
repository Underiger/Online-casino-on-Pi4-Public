<script setup lang="ts">
/**
 * PlayingCard（components/common）：
 * 撲克牌渲染元件，依 card.rank/suit 對應 /cards 下的 PNG 素材（PNG-cards-1.3）；
 * card 為 null/未提供時顯示牌背，用於遮蔽尚未公開的牌（如莊家暗牌）。
 */
import { computed } from 'vue';
import type { Card, Rank } from '@casino/shared';

const props = withDefaults(defineProps<{
  card?: Card | null;
  size?: 'sm' | 'md';
}>(), {
  card: null,
  size: 'md',
});

const RANK_WORD: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'jack', 12: 'queen', 13: 'king', 14: 'ace',
};
const SUIT_WORD: Record<Card['suit'], string> = {
  SPADE: 'spades',
  HEART: 'hearts',
  DIAMOND: 'diamonds',
  CLUB: 'clubs',
};
const RANK_LABEL: Record<Rank, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A',
};
const SUIT_SYMBOL: Record<Card['suit'], string> = {
  SPADE: '♠',
  HEART: '♥',
  DIAMOND: '♦',
  CLUB: '♣',
};

const imgSrc = computed(() => {
  const card = props.card;
  return card ? `/cards/${RANK_WORD[card.rank]}_of_${SUIT_WORD[card.suit]}.png` : null;
});
const altText = computed(() => {
  const card = props.card;
  return card ? `${RANK_LABEL[card.rank]}${SUIT_SYMBOL[card.suit]}` : '牌背';
});
</script>

<template>
  <div class="playing-card" :class="[size, { back: !card }]">
    <img v-if="imgSrc" :src="imgSrc" :alt="altText" draggable="false" />
  </div>
</template>

<style scoped>
.playing-card {
  flex-shrink: 0;
  border-radius: 8px;
  border: 2px solid #333;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.playing-card.sm {
  width: 70px;
  height: 100px;
}
.playing-card.md {
  width: 90px;
  height: 130px;
}
.playing-card img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  user-select: none;
}
.playing-card.back {
  background: repeating-linear-gradient(45deg, #2a4, #2a4 10px, #194 10px, #194 20px);
}
</style>
