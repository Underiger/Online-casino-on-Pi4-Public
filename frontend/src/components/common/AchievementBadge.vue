<script setup lang="ts">
import type { AchievementItem } from '../../api/endpoints/achievement';

defineProps<{
  achievement: AchievementItem;
}>();

const ICONS: Record<string, string> = {
  FIRST_TRIPLE: '🎰',
  LUCKY7_TRIPLE: '7️⃣',
  JACKPOT_WINNER: '🏆',
  LOGIN_STREAK_7: '🔥',
  SPIN_1000: '💫',
  ROULETTE_100: '🎡',
  CHATTERBOX: '💬',
  CHARM_COLLECT_6: '✨',
  CHARM_COLLECT_12: '🌟',
  NET_WIN_10000: '💰',
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('zh-TW', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}
</script>

<template>
  <div
    class="badge"
    :class="{ unlocked: achievement.unlockedAt !== null, locked: achievement.unlockedAt === null }"
    :title="achievement.description"
    role="img"
    :aria-label="`${achievement.name} – ${achievement.unlockedAt !== null ? '已解鎖' : '未解鎖'}`"
  >
    <div class="badge-icon">{{ ICONS[achievement.code] ?? '🎖️' }}</div>
    <div v-if="achievement.unlockedAt !== null" class="checkmark">✓</div>
    <div class="badge-name">{{ achievement.name }}</div>
    <div class="badge-reward">+{{ achievement.rewardCoin }} Coin</div>
    <div v-if="achievement.unlockedAt !== null" class="badge-date">
      {{ formatDate(achievement.unlockedAt) }}
    </div>
    <div v-else class="badge-locked">🔒 未解鎖</div>
  </div>
</template>

<style scoped>
.badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.3rem;
  padding: 1rem 0.75rem;
  border-radius: 12px;
  border: 2px solid;
  text-align: center;
  position: relative;
  transition: transform 0.2s, box-shadow 0.2s;
  cursor: default;
  user-select: none;
  min-width: 110px;
}

.badge.unlocked {
  border-color: #ffd700;
  background: rgba(255, 215, 0, 0.08);
  box-shadow: 0 0 10px rgba(255, 215, 0, 0.2);
}

.badge.unlocked:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(255, 215, 0, 0.35);
}

.badge.locked {
  border-color: rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.03);
  filter: grayscale(60%);
  opacity: 0.7;
}

.badge-icon {
  font-size: 2rem;
  line-height: 1;
}

.checkmark {
  position: absolute;
  top: 0.4rem;
  right: 0.5rem;
  font-size: 0.75rem;
  color: #ffd700;
  font-weight: 700;
}

.badge-name {
  font-size: 0.8rem;
  font-weight: 600;
  color: #fff;
  max-width: 9rem;
  word-break: break-word;
}

.badge-reward {
  font-size: 0.7rem;
  color: #ffd700;
}

.badge-date {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.55);
}

.badge-locked {
  font-size: 0.65rem;
  color: rgba(255, 255, 255, 0.35);
}
</style>
