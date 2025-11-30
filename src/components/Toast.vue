<script setup lang="ts">
defineProps<{
  message: string
}>()
</script>

<template>
  <transition name="toast">
    <div v-if="message" class="toast">{{ message }}</div>
  </transition>
</template>

<style scoped>
.toast {
  position: fixed;
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  padding: 12px 24px;
  border-radius: 24px;
  font-size: 14px;
  background: #323232;
  color: #fff;
  z-index: 1000;
  max-width: 80%;
  text-align: center;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px);
}
</style>
