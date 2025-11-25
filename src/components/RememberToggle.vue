<script setup lang="ts">
const model = defineModel<boolean>({ default: true })
</script>

<template>
  <label class="checkbox-field">
    <input type="checkbox" v-model="model">
    <span>Remember details</span>
  </label>
</template>
