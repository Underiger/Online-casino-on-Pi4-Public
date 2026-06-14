/**
 * M16 Roulette Pinia store — 05_MILESTONES M16 §Store。
 * 管理 phase/phase state / personalBets（樂觀更新 + rollback）/ lastResult / snapshot。
 * Socket 訂閱由 connectSocket() 安裝，disconnectSocket() 卸載（view onMounted/onUnmounted 呼叫）。
 */
import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import {
  SOCKET_EVENTS,
  ROULETTE_MAX_TOTAL_BET,
  ROULETTE_MAX_SINGLE_BET,
  RoulettePhase,
} from '@casino/shared';
import type {
  RouletteBetType,
  RoulettePhasePayload,
  RouletteResultPayload,
  RouletteBetAckPayload,
  RouletteBetsSnapshotPayload,
  HotBetStat,
  RouletteBetPayload,
  RouletteSingleBetPayload,
} from '@casino/shared';
import { signRequest } from '../api/sign';
import { getSocket } from '../socket/client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PersonalBet {
  /** internal tracking id for rollback */
  readonly _id: number;
  type: RouletteBetType;
  amount: number;
  number?: number;
  column?: 1 | 2 | 3;
  dozen?: 1 | 2 | 3;
}

// ─── Store ────────────────────────────────────────────────────────────────────

let _betIdCounter = 0;

export const useRouletteStore = defineStore('roulette', () => {
  // ── phase ──────────────────────────────────────────────────────────────────
  const currentPhase = ref<RoulettePhase>(RoulettePhase.COOLDOWN);
  const phaseEndsAt = ref<string | null>(null);
  const roundId = ref<string>('');
  const participantCount = ref(0);

  // ── bets ───────────────────────────────────────────────────────────────────
  const personalBets = ref<PersonalBet[]>([]);
  /** server-authoritative total bet this round (updated on bet_ack) */
  const totalBet = ref(0);
  /** server-authoritative remaining quota this round */
  const remaining = ref(ROULETTE_MAX_TOTAL_BET);
  const isBettingInFlight = ref(false);

  // ── result ─────────────────────────────────────────────────────────────────
  const lastResult = ref<RouletteResultPayload | null>(null);
  const hotBets = ref<HotBetStat[]>([]);
  const betsSnapshot = ref<RouletteBetsSnapshotPayload | null>(null);

  // ── error ──────────────────────────────────────────────────────────────────
  const lastError = ref<string | null>(null);

  // ─── Getters ──────────────────────────────────────────────────────────────

  const isBettingPhase = computed(() => currentPhase.value === 'BETTING');

  /**
   * Map<betKey, totalAmount> — overlay amounts on BetBoard cells.
   * Keys: STRAIGHT:n | COLUMN:c | DOZEN:d | RED | BLACK | ODD | EVEN | HIGH | LOW
   */
  const betAmountByType = computed((): Map<string, number> => {
    const map = new Map<string, number>();
    for (const b of personalBets.value) {
      let key: string;
      if (b.type === 'STRAIGHT') key = `STRAIGHT:${b.number ?? 0}`;
      else if (b.type === 'COLUMN') key = `COLUMN:${b.column ?? 1}`;
      else if (b.type === 'DOZEN') key = `DOZEN:${b.dozen ?? 1}`;
      else key = b.type;
      map.set(key, (map.get(key) ?? 0) + b.amount);
    }
    return map;
  });

  // ─── Handlers (called by connectSocket listeners) ────────────────────────

  function handlePhase(payload: RoulettePhasePayload): void {
    const isNewRound = payload.roundId !== roundId.value;

    currentPhase.value = payload.phase;
    phaseEndsAt.value = payload.phaseEndsAt;
    participantCount.value = payload.participantCount;
    roundId.value = payload.roundId;

    // Reset per-round state when a fresh BETTING starts
    if (payload.phase === 'BETTING' && isNewRound) {
      personalBets.value = [];
      totalBet.value = 0;
      remaining.value = ROULETTE_MAX_TOTAL_BET;
      lastResult.value = null;
      hotBets.value = [];
      betsSnapshot.value = null;
      lastError.value = null;
    }
  }

  function handleResult(payload: RouletteResultPayload): void {
    lastResult.value = payload;
    hotBets.value = payload.hotBets;

    // Server-authoritative balance update
    if (payload.newBalance !== null) {
      void import('./wallet').then(({ useWalletStore }) => {
        useWalletStore().setBalance(payload.newBalance as string);
      });
    }
  }

  function handleBetAck(payload: RouletteBetAckPayload): void {
    // Only update from server-authoritative data on success.
    // Failure already handled by the ack callback rollback inside placeBet().
    if (payload.accepted) {
      totalBet.value = payload.totalBet;
      remaining.value = payload.remaining;
    }
  }

  function handleBetsSnapshot(payload: RouletteBetsSnapshotPayload): void {
    betsSnapshot.value = payload;
    hotBets.value = payload.hotBets;
  }

  // ─── Socket subscription ────────────────────────────────────────────────

  let _connected = false;

  function connectSocket(): void {
    if (_connected) return;
    _connected = true;

    const socket = getSocket();

    socket.on(SOCKET_EVENTS.ROULETTE_PHASE, handlePhase);
    socket.on(SOCKET_EVENTS.ROULETTE_RESULT, handleResult);
    socket.on(SOCKET_EVENTS.ROULETTE_BET_ACK, handleBetAck);
    socket.on(SOCKET_EVENTS.ROULETTE_BETS_SNAPSHOT, handleBetsSnapshot);
  }

  function disconnectSocket(): void {
    if (!_connected) return;
    _connected = false;

    const socket = getSocket();

    socket.off(SOCKET_EVENTS.ROULETTE_PHASE, handlePhase);
    socket.off(SOCKET_EVENTS.ROULETTE_RESULT, handleResult);
    socket.off(SOCKET_EVENTS.ROULETTE_BET_ACK, handleBetAck);
    socket.off(SOCKET_EVENTS.ROULETTE_BETS_SNAPSHOT, handleBetsSnapshot);
  }

  // ─── Actions ────────────────────────────────────────────────────────────

  /** Sync initial state via REST（進頁面先叫一次） */
  async function fetchInitialState(): Promise<void> {
    try {
      const { apiGetRouletteState } = await import('../api/endpoints/roulette');
      const state = await apiGetRouletteState();
      // Only apply if we don't already have a live state from Socket
      if (roundId.value === '') {
        currentPhase.value = state.phase;
        phaseEndsAt.value = state.phaseEndsAt;
        roundId.value = state.roundId;
        participantCount.value = state.participantCount;
      }
    } catch {
      // No active round or server unreachable — ignore; Socket will push the next phase
    }
  }

  /**
   * 樂觀下注 → HMAC 簽名 → emit roulette:bet → ack callback rollback on error。
   * Returns error code string or null on success.
   */
  async function placeBet(bet: Omit<PersonalBet, '_id'>): Promise<string | null> {
    if (currentPhase.value !== 'BETTING') return 'ROULETTE_PHASE_CLOSED';
    if (isBettingInFlight.value) return 'BET_IN_FLIGHT';
    if (bet.amount > ROULETTE_MAX_SINGLE_BET) return 'BET_LIMIT_EXCEEDED';
    if (bet.amount > remaining.value) return 'BET_LIMIT_EXCEEDED';

    // Get auth
    const { useAuthStore } = await import('./auth');
    const auth = useAuthStore();
    if (auth.hmacKey === null || auth.user === null) return 'HMAC_KEY_MISSING';

    // Sign
    const signed = await signRequest({
      hmacKey: auth.hmacKey,
      userId: auth.user.id,
      gameType: 'ROULETTE',
      betAmount: bet.amount,
      seq: auth.nextSeq(),
    });

    // Snapshot pre-add state for rollback
    const preLength = personalBets.value.length;
    const preTotalBet = totalBet.value;
    const preRemaining = remaining.value;

    // Optimistic update
    const betId = _betIdCounter++;
    const optimisticBet: PersonalBet = { ...bet, _id: betId };
    personalBets.value = [...personalBets.value, optimisticBet];
    totalBet.value += bet.amount;
    remaining.value -= bet.amount;
    isBettingInFlight.value = true;

    const betItem: RouletteSingleBetPayload = buildBetItem(bet);
    const payload: RouletteBetPayload = {
      roundId: roundId.value,
      bets: [betItem],
      sig: signed.sig,
      nonce: signed.nonce,
      ts: signed.ts,
      seq: signed.seq,
    };

    return new Promise<string | null>((resolve) => {
      const socket = getSocket();

      socket.timeout(6000).emit(SOCKET_EVENTS.ROULETTE_BET, payload, (timeoutErr: Error | null, serverErr: string | null) => {
        isBettingInFlight.value = false;

        // Socket.IO timeout error or server returned an error code
        const err: string | null = timeoutErr !== null ? 'TIMEOUT' : serverErr;

        if (err !== null) {
          // Rollback optimistic update
          personalBets.value = personalBets.value.slice(0, preLength);
          totalBet.value = preTotalBet;
          remaining.value = preRemaining;
          lastError.value = err;
          resolve(err);
        } else {
          // Success — roulette:bet_ack will arrive and update server-authoritative totals
          lastError.value = null;
          resolve(null);
        }
      });
    });
  }

  /**
   * 取消本回合全部下注（僅 BETTING 階段可用）。
   * Returns error code or null on success.
   */
  async function cancelBets(): Promise<string | null> {
    if (currentPhase.value !== 'BETTING') return 'ROULETTE_PHASE_CLOSED';
    if (personalBets.value.length === 0) return null;

    const snapshot = [...personalBets.value];
    const snapshotTotal = totalBet.value;

    // Optimistic clear
    personalBets.value = [];
    totalBet.value = 0;
    remaining.value = ROULETTE_MAX_TOTAL_BET;

    return new Promise<string | null>((resolve) => {
      const socket = getSocket();

      socket.timeout(6000).emit(
        SOCKET_EVENTS.ROULETTE_CANCEL,
        { roundId: roundId.value },
        (timeoutErr: Error | null, serverErr: string | null) => {
          const err: string | null = timeoutErr !== null ? 'TIMEOUT' : serverErr;

          if (err !== null) {
            // Rollback optimistic clear
            personalBets.value = snapshot;
            totalBet.value = snapshotTotal;
            remaining.value = ROULETTE_MAX_TOTAL_BET - snapshotTotal;
            lastError.value = err;
            resolve(err);
          } else {
            lastError.value = null;
            resolve(null);
          }
        },
      );
    });
  }

  function clearError(): void {
    lastError.value = null;
  }

  // ─── Expose ───────────────────────────────────────────────────────────────

  return {
    // state
    currentPhase,
    phaseEndsAt,
    roundId,
    participantCount,
    personalBets,
    totalBet,
    remaining,
    isBettingInFlight,
    lastResult,
    hotBets,
    betsSnapshot,
    lastError,
    // getters
    isBettingPhase,
    betAmountByType,
    // socket
    connectSocket,
    disconnectSocket,
    // actions
    fetchInitialState,
    placeBet,
    cancelBets,
    clearError,
  };
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildBetItem(bet: Omit<PersonalBet, '_id'>): RouletteSingleBetPayload {
  const base = { type: bet.type as RouletteBetType, amount: bet.amount };
  if (bet.type === 'STRAIGHT') return { ...base, number: bet.number ?? 0 };
  if (bet.type === 'COLUMN') return { ...base, column: bet.column ?? 1 };
  if (bet.type === 'DOZEN') return { ...base, dozen: bet.dozen ?? 1 };
  return base;
}
