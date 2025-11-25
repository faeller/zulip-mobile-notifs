<script setup lang="ts">
defineProps<{
  active?: boolean
  disabled?: boolean
  title: string
  subtitle: string
}>()

defineEmits<{
  click: []
}>()
</script>

<template>
  <button
    class="option-btn"
    :class="{ active }"
    :disabled="disabled"
    @click="$emit('click')"
  >
    <span class="option-icon">
      <slot name="icon" />
    </span>
    <span class="option-text">
      <strong>{{ title }}</strong>
      <small>{{ subtitle }}</small>
    </span>
  </button>
</template>
