<!--
  MuralPeople (POL-191) — who may drive THIS mural.

  A grant binds a person (by email) or a directory GROUP to one of the three roles, on this mural
  only. It RAISES what that subject may do here and never lowers it, so the list reads as "extra
  power on this wall", not as the complete set of people who can see it — a fleet admin is an admin
  here whether or not they appear below, and the note under the list says so rather than implying an
  exclusivity the server does not enforce.

  Group grants are the reason this is worth having on a brokered deployment: the directory already
  holds the membership list, so an admin names a group once instead of maintaining a copy here.
-->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { MuralGrant, OperatorRole } from "@polyptic/protocol";

import { deleteMuralGrant, fetchMuralGrants, putMuralGrant, ApiError } from "../../api";

const props = defineProps<{ muralId: string; muralName: string }>();
const emit = defineEmits<{ close: [] }>();

const grants = ref<MuralGrant[]>([]);
const loading = ref(true);
const busy = ref(false);
const errorMessage = ref<string | null>(null);

// The add-someone row. `kind` decides how `subject` is read: an email address, or a group name.
const kind = ref<"user" | "group">("user");
const subject = ref("");
const role = ref<OperatorRole>("operator");

const placeholder = computed(() =>
  kind.value === "user" ? "someone@example.org" : "a group from your directory",
);

const ROLE_NOTES: Record<OperatorRole, string> = {
  viewer: "Can apply saved scenes on this mural.",
  operator: "Can place screens and set content on this mural.",
  admin: "Can do all of that, and hand out access to this mural.",
};

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = null;
  try {
    grants.value = await fetchMuralGrants(props.muralId);
  } catch (err) {
    errorMessage.value = messageFor(err, "Could not read who has access to this mural.");
  } finally {
    loading.value = false;
  }
}

watch(() => props.muralId, load, { immediate: true });

/** A 403 here means the caller is not an admin ON THIS MURAL — say that, rather than "forbidden". */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return "You need admin on this mural to change who can use it.";
  }
  if (err instanceof ApiError && err.status === 404) {
    return "No account here matches that address. They need to have signed in at least once.";
  }
  return fallback;
}

async function add(): Promise<void> {
  const value = subject.value.trim();
  if (!value || busy.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    grants.value = await putMuralGrant(props.muralId, {
      subjectKind: kind.value,
      subjectId: value,
      role: role.value,
    });
    subject.value = "";
  } catch (err) {
    errorMessage.value = messageFor(err, "Could not give access to this mural.");
  } finally {
    busy.value = false;
  }
}

async function relevel(grant: MuralGrant, next: OperatorRole): Promise<void> {
  if (busy.value || next === grant.role) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    grants.value = await putMuralGrant(props.muralId, {
      subjectKind: grant.subjectKind,
      subjectId: grant.subjectId,
      role: next,
    });
  } catch (err) {
    errorMessage.value = messageFor(err, "Could not change that level.");
  } finally {
    busy.value = false;
  }
}

async function revoke(grant: MuralGrant): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  errorMessage.value = null;
  try {
    grants.value = await deleteMuralGrant(props.muralId, grant.subjectKind, grant.subjectId);
  } catch (err) {
    errorMessage.value = messageFor(err, "Could not remove that access.");
  } finally {
    busy.value = false;
  }
}

/** What to show for a subject: the account's email, or the group name. Falls back to the raw id for
 *  a user whose account has since been deleted — better a visible orphan than a blank row. */
function labelFor(grant: MuralGrant): string {
  return grant.subjectLabel ?? grant.subjectId;
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="sheet card">
      <div class="head">
        <div>
          <div class="title">Access to {{ muralName }}</div>
          <div class="sub">Who can use this mural, on top of what their account already allows.</div>
        </div>
        <button class="close" @click="emit('close')">✕</button>
      </div>

      <div v-if="errorMessage" class="error">⚠ {{ errorMessage }}</div>

      <div v-if="loading" class="empty">Reading access…</div>
      <div v-else-if="grants.length === 0" class="empty">
        Nobody has been given access to this mural yet.
      </div>
      <ul v-else class="list">
        <li v-for="grant in grants" :key="`${grant.subjectKind}:${grant.subjectId}`" class="row">
          <span class="badge" :class="grant.subjectKind">{{
            grant.subjectKind === "group" ? "Group" : "Person"
          }}</span>
          <span class="subject">{{ labelFor(grant) }}</span>
          <select
            class="input level"
            :value="grant.role"
            :disabled="busy"
            @change="relevel(grant, ($event.target as HTMLSelectElement).value as OperatorRole)"
          >
            <option value="viewer">Viewer</option>
            <option value="operator">Operator</option>
            <option value="admin">Admin</option>
          </select>
          <button class="revoke" :disabled="busy" @click="revoke(grant)">Remove</button>
        </li>
      </ul>

      <div class="add">
        <div class="add-row">
          <select v-model="kind" class="input kind" :disabled="busy">
            <option value="user">Person</option>
            <option value="group">Group</option>
          </select>
          <input
            v-model="subject"
            class="input grow"
            :placeholder="placeholder"
            :disabled="busy"
            @keyup.enter="add"
          />
          <select v-model="role" class="input level" :disabled="busy">
            <option value="viewer">Viewer</option>
            <option value="operator">Operator</option>
            <option value="admin">Admin</option>
          </select>
          <button class="btn btn-primary" :disabled="busy || !subject.trim()" @click="add">Add</button>
        </div>
        <div class="hint">{{ ROLE_NOTES[role] }}</div>
      </div>

      <div class="foot">
        Fleet admins can already use every mural. A group is matched against the groups your identity
        provider reports at sign-in.
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
}
.sheet {
  width: 560px;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 64px);
  overflow: auto;
  padding: 20px;
  border-radius: 14px;
  box-shadow: var(--shadow-lg);
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 16px;
}
.title {
  font-size: 15px;
  font-weight: 600;
}
.sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 3px;
}
.close {
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 13px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
.close:hover {
  background: var(--muted-bg);
}
.error {
  font-size: 12.5px;
  color: var(--bad);
  background: var(--bad-soft);
  border-radius: 8px;
  padding: 9px 11px;
  margin-bottom: 14px;
}
.empty {
  font-size: 12.5px;
  color: var(--muted);
  padding: 14px 0;
}
.list {
  list-style: none;
  margin: 0 0 16px;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: center;
  gap: 9px;
}
.badge {
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--muted-bg);
  color: var(--muted);
}
.badge.group {
  background: var(--accent-soft, var(--muted-bg));
  color: var(--accent-fg, var(--fg2));
}
.subject {
  flex: 1;
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.level {
  flex: 0 0 auto;
  width: 108px;
}
.kind {
  flex: 0 0 auto;
  width: 96px;
}
.grow {
  flex: 1;
  min-width: 0;
}
.revoke {
  flex: 0 0 auto;
  border: none;
  background: transparent;
  color: var(--muted);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  padding: 5px 7px;
  border-radius: 6px;
}
.revoke:hover:not(:disabled) {
  background: var(--bad-soft);
  color: var(--bad);
}
.add {
  border-top: 1px solid var(--line);
  padding-top: 14px;
}
.add-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.hint {
  font-size: 11.5px;
  color: var(--muted2);
  margin-top: 8px;
}
.foot {
  font-size: 11.5px;
  color: var(--muted2);
  margin-top: 14px;
  line-height: 1.5;
}
</style>
