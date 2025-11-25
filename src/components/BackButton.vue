<script setup lang="ts">
defineProps<{
  label?: string
}>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <button class="back-btn" @click="$emit('click')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
      <path d="M19 12H5M12 19l-7-7 7-7"/>
    </svg>
    {{ label || 'Back' }}
  </button>
</template>
