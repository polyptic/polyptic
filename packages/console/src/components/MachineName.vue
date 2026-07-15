<!--
  MachineName.vue — the machine card's name, editable in place (POL-117).

  Manual naming is how an operator tells identical netbooted boxes apart (they all report the
  hostname `localhost.localdomain`, which identifies nothing). Mirrors ScreenRow's inline rename:
  click the name, type, Enter/blur commits, Esc reverts; the draft re-syncs from the authoritative
  admin/state unless the operator is mid-edit. An UNNAMED machine renders an empty input whose
  placeholder says so honestly ("Unnamed box · <id tail>") — never the hostname pretending to be
  a name — and simply typing into it is the naming affordance.

  Works on any card — naming a still-PENDING box is the point, since boxes are indistinguishable
  exactly while several queue for approval.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MachineView } from "@polyptic/protocol";
import { useConsoleStore } from "../stores/console";
import { machineDisplayName, machineHasName } from "../machine-name";

const props = defineProps<{ machine: MachineView }>();

const store = useConsoleStore();

/** The editable text: the operator's name, or empty while unnamed (placeholder carries the truth). */
function editableName(): string {
  return machineHasName(props.machine) ? props.machine.label.trim() : "";
}

const draft = ref(editableName());
const focused = ref(false);

// Re-sync from inbound snapshots unless the operator is actively editing this field.
watch(
  () => props.machine.label,
  () => {
    if (!focused.value) draft.value = editableName();
  },
);

const placeholder = computed(() => machineDisplayName(props.machine));

const trimmed = computed(() => draft.value.trim());
const canRename = computed(() => {
  const n = trimmed.value;
  return n.length >= 1 && n.length <= 64 && n !== editableName();
});

function commit(): void {
  if (!canRename.value) return;
  void store.renameMachine(props.machine.id, trimmed.value);
}

function revert(): void {
  draft.value = editableName();
}
</script>

<template>
  <input
    v-model="draft"
    class="machine-rename"
    :class="{ unnamed: !machineHasName(machine) && !focused }"
    spellcheck="false"
    autocomplete="off"
    :placeholder="placeholder"
    :aria-label="`Rename ${placeholder}`"
    :title="machineHasName(machine) ? 'Rename this machine' : 'Name this machine so you can tell it apart'"
    @focus="focused = true"
    @blur="focused = false; commit()"
    @keyup.enter="commit(); ($event.target as HTMLInputElement).blur()"
    @keyup.esc="revert(); ($event.target as HTMLInputElement).blur()"
  />
</template>

<style scoped>
.machine-rename {
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 2px 7px;
  margin-left: -7px; /* the border-box padding, so the resting text aligns with the old static label */
  min-width: 0;
  width: 200px;
}
.machine-rename.unnamed {
  /* An unnamed box must read as a gap to fill, not a name — muted + italic, like the truth it is. */
  font-style: italic;
  font-weight: 500;
}
.machine-rename::placeholder {
  color: var(--muted);
}
.machine-rename:hover {
  border-color: var(--line2);
  background: var(--surface);
}
.machine-rename:focus {
  outline: none;
  border-color: var(--accent, var(--primary));
  background: var(--surface);
  font-style: normal;
}
</style>
