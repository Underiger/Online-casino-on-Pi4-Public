<template>
  <div v-if="totalPages > 1" class="pagination">
    <button class="btn btn--ghost btn--sm" :disabled="page <= 1" @click="emit('change', page - 1)">
      ← 上一頁
    </button>
    <span class="pagination__info">{{ page }} / {{ totalPages }}（共 {{ total }} 筆）</span>
    <button
      class="btn btn--ghost btn--sm"
      :disabled="page >= totalPages"
      @click="emit('change', page + 1)"
    >
      下一頁 →
    </button>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  page: number;
  total: number;
  totalPages: number;
}>();

const emit = defineEmits<{
  change: [page: number];
}>();
</script>

<style scoped>
.pagination {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  justify-content: flex-end;
}
.pagination__info {
  color: #64748b;
  font-size: 13px;
}
</style>
