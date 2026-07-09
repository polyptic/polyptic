<script setup lang="ts">
// A switch, per the console design language: 38×22 track, 18px knob, accent when on.
const props = defineProps<{ modelValue: boolean; disabled?: boolean; label: string }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

function toggle(): void {
  if (!props.disabled) emit("update:modelValue", !props.modelValue);
}
</script>

<template>
  <button
    type="button"
    class="sw"
    role="switch"
    :class="{ on: modelValue }"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    @click="toggle"
  >
    <span class="knob" />
  </button>
</template>

<style scoped>
.sw {
  position: relative;
  flex: 0 0 auto;
  width: 38px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 20px;
  background: var(--line2);
  cursor: pointer;
  transition: background 0.18s ease;
}
.sw.on {
  background: var(--accent);
}
.sw:disabled {
  opacity: 0.55;
  cursor: default;
}
.sw:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  transition: transform 0.18s ease;
}
.sw.on .knob {
  transform: translateX(16px);
}
</style>
