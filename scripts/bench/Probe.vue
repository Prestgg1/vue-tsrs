<script setup lang="ts">
const expectedString: string = 42
const items = [{ label: expectedString }]
</script>

<template>
  <span v-for="item in items" :key="item.label">{{ item.missing }}</span>
</template>
