<script setup lang="ts">
defineProps<{
  label: string
  hint?: string
}>()
</script>

<template>
  <div class="field">
    <label>{{ label }}</label>
    <slot />
    <small v-if="hint">{{ hint }}</small>
  </div>
</template>
