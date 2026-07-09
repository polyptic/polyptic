<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import * as auth from "../auth";
import Toggle from "../components/Toggle.vue";
import { useConsoleStore } from "../stores/console";

// Settings (POL-45): a section rail on the left, one card per concern on the right — appearance,
// on-screen badges, the enrolment token, netboot, the live-image lifecycle, password, account.
const store = useConsoleStore();
const router = useRouter();

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "fleet", label: "Enrolment" },
  { id: "netboot", label: "Netboot" },
  { id: "image", label: "Image updates" },
  { id: "security", label: "Security" },
  { id: "account", label: "Account" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const scroller = ref<HTMLElement | null>(null);
const active = ref<SectionId>("appearance");

onMounted(() => {
  // Load the enrollment-token info (open vs gated) so the card can render the real value.
  void store.fetchEnrollment();
  // Load the netboot info (control-plane base + boot config URL + boot-medium download) for the Netboot card.
  void store.fetchNetboot();
  // Load the fleet-wide badge toggle so the card is correct even before the admin/state snapshot lands.
  void store.fetchDisplaySettings();
  // Load the image-updates state (schedule, urgency, last rebuild, published images) (POL-41).
  void store.fetchImageUpdates();
  scroller.value?.addEventListener("scroll", onScroll, { passive: true });
});

onBeforeUnmount(() => scroller.value?.removeEventListener("scroll", onScroll));

/** Scroll-spy: the last section whose top has passed the scroller's top (plus a small margin) wins. */
function onScroll(): void {
  const root = scroller.value;
  if (!root) return;
  const top = root.getBoundingClientRect().top + 80;
  let current: SectionId = "appearance";
  for (const s of SECTIONS) {
    const el = document.getElementById(`sec-${s.id}`);
    if (el && el.getBoundingClientRect().top <= top) current = s.id;
  }
  // At the bottom of the scroll range the last card may never cross the line — claim it anyway.
  if (root.scrollTop + root.clientHeight >= root.scrollHeight - 8) current = "account";
  active.value = current;
}

function goTo(id: SectionId): void {
  active.value = id;
  const root = scroller.value;
  const el = document.getElementById(`sec-${id}`);
  if (!root || !el) return;
  root.scrollTo({
    top: root.scrollTop + (el.getBoundingClientRect().top - root.getBoundingClientRect().top) - 24,
    behavior: "smooth",
  });
}

// ── Toast ──────────────────────────────────────────────────────────────────────
const toast = ref("");
let toastTimer: number | undefined;
function showToast(message: string): void {
  window.clearTimeout(toastTimer);
  toast.value = message;
  toastTimer = window.setTimeout(() => (toast.value = ""), 1900);
}

async function copy(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(message);
  } catch {
    // Clipboard is unavailable outside a secure context — Copy is a best-effort convenience.
    showToast("Copy failed — clipboard unavailable");
  }
}

// ── Appearance ─────────────────────────────────────────────────────────────────
function setTheme(theme: "light" | "dark"): void {
  if (store.theme !== theme) store.toggleTheme();
}

// ── On-screen badges (POL-6) ───────────────────────────────────────────────────
const badgesSaving = ref(false);

async function setBadges(show: boolean): Promise<void> {
  if (badgesSaving.value || store.showBadges === show) return;
  badgesSaving.value = true;
  try {
    await store.setShowBadges(show);
  } catch {
    /* the store already reverted the optimistic value; the switch reflects the true state */
  } finally {
    badgesSaving.value = false;
  }
}

// ── Enrolment token ────────────────────────────────────────────────────────────
const regenerating = ref(false);

async function regenerate(): Promise<void> {
  if (regenerating.value) return;
  if (!window.confirm("Regenerate the enrolment token? Machines still using the old token can no longer dial in.")) {
    return;
  }
  regenerating.value = true;
  await store.regenerateEnrollment();
  regenerating.value = false;
  showToast("New enrolment token generated");
}

// ── Netboot (POL-33) ───────────────────────────────────────────────────────────
const advOpen = ref(false);

// ── Image updates (POL-41 nightly refresh + POL-43 weekly full rebuild) ─────────
const imgSaving = ref(false);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const rebuilding = computed(() => store.imageUpdates?.lastBuild?.status === "running");

/** The chip beside the "Image updates" title: what the build pipeline is doing right now. */
const buildChip = computed<{ text: string; tone: "busy" | "ok" | "bad" | "idle" }>(() => {
  const info = store.imageUpdates;
  if (!info) return { text: "…", tone: "idle" };
  if (info.lastBuild?.status === "running") return { text: "Rebuilding…", tone: "busy" };
  if (info.lastBuild?.status === "failure") return { text: "Last build failed", tone: "bad" };
  if (info.images.length > 0) return { text: "Up to date", tone: "ok" };
  return { text: "No image published", tone: "idle" };
});

const lastBuildLabel = computed(() => {
  const b = store.imageUpdates?.lastBuild;
  if (!b) return "No rebuild has run from this server yet.";
  const kind = b.kind === "full" ? "Full rebuild" : "Refresh";
  const when = new Date(b.startedAt).toLocaleString();
  if (b.status === "running") return `${kind} running — started ${when}`;
  return `Last rebuild ${when} (${b.kind === "full" ? "full" : "refresh"}, ${b.status})`;
});

async function applyImageSettings(patch: {
  scheduleEnabled?: boolean;
  scheduleTime?: string;
  fullScheduleEnabled?: boolean;
  fullScheduleDay?: number;
  fullScheduleTime?: string;
  urgent?: boolean;
}): Promise<void> {
  if (imgSaving.value) return;
  imgSaving.value = true;
  try {
    store.imageUpdates = await auth.updateImageSettings(patch);
  } catch (err) {
    console.error("[console] image settings update failed", err);
    showToast("Could not save image settings");
  } finally {
    imgSaving.value = false;
  }
}

async function rebuildNow(kind: "refresh" | "full"): Promise<void> {
  if (imgSaving.value) return;
  imgSaving.value = true;
  try {
    store.imageUpdates = await auth.rebuildImageNow(kind);
    showToast(kind === "full" ? "Full rebuild queued" : "Refresh queued");
  } catch (err) {
    console.error("[console] rebuild trigger failed", err);
    showToast("Could not start the rebuild");
  } finally {
    imgSaving.value = false;
  }
}

function saveTime(value: string, field: "scheduleTime" | "fullScheduleTime"): void {
  const t = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return;
  void applyImageSettings(field === "scheduleTime" ? { scheduleTime: t } : { fullScheduleTime: t });
}

async function setUrgent(urgent: boolean): Promise<void> {
  await applyImageSettings({ urgent });
  if (store.imageUpdates?.urgent === urgent) {
    showToast(urgent ? "Marked urgent — stale boxes reboot within minutes" : "Urgent roll-out cleared");
  }
}

// ── Change password ────────────────────────────────────────────────────────────
const pw = reactive({ current: "", next: "", confirm: "" });
const pwError = ref<string | null>(null);
const pwSuccess = ref(false);
const pwSaving = ref(false);

async function onChangePassword(): Promise<void> {
  if (pwSaving.value) return;
  pwError.value = null;
  pwSuccess.value = false;
  if (!pw.current) {
    pwError.value = "Enter your current password.";
    return;
  }
  if (pw.next.length < 8) {
    pwError.value = "New password must be at least 8 characters.";
    return;
  }
  if (pw.next !== pw.confirm) {
    pwError.value = "New passwords do not match.";
    return;
  }
  pwSaving.value = true;
  try {
    await store.changePassword({ currentPassword: pw.current, newPassword: pw.next });
    pwSuccess.value = true;
    pw.current = "";
    pw.next = "";
    pw.confirm = "";
  } catch {
    // Generic message — never reveal which field was at fault beyond "current password wrong".
    pwError.value = "Could not change password. Check your current password and try again.";
  } finally {
    pwSaving.value = false;
  }
}

// ── Logout ─────────────────────────────────────────────────────────────────────
const loggingOut = ref(false);
async function onSignOut(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  await store.logout();
  await router.replace({ name: "signin" });
}
</script>

<template>
  <div class="settings">
    <!-- Section rail --------------------------------------------------------- -->
    <nav class="sec-nav">
      <div class="sec-nav-title">Settings</div>
      <button
        v-for="s in SECTIONS"
        :key="s.id"
        type="button"
        class="sec-link"
        :class="{ active: active === s.id }"
        @click="goTo(s.id)"
      >
        <span class="sec-dot" />{{ s.label }}
      </button>
    </nav>

    <!-- Cards ---------------------------------------------------------------- -->
    <div ref="scroller" class="scroll">
      <div class="inner">
        <h1 class="page-title">Settings</h1>
        <p class="page-sub">Console preferences, fleet enrolment, and the live-image lifecycle.</p>

        <!-- Appearance ------------------------------------------------------- -->
        <section id="sec-appearance" class="card row-card">
          <div>
            <h2 class="card-title">Appearance</h2>
            <p class="card-sub">Theme for the operator console.</p>
          </div>
          <div class="pill-group">
            <button
              type="button"
              class="pill"
              :class="{ active: store.theme === 'light' }"
              @click="setTheme('light')"
            >
              ☼&nbsp; Light
            </button>
            <button type="button" class="pill" :class="{ active: store.theme === 'dark' }" @click="setTheme('dark')">
              ☾&nbsp; Dark
            </button>
          </div>
        </section>

        <!-- On-screen badges ------------------------------------------------- -->
        <section class="card">
          <div class="card-head">
            <div class="min-w-0">
              <h2 class="card-title">On-screen badges</h2>
              <p class="card-sub wrap">
                The status badge shown in the corner of every screen. Off in production, on in development.
              </p>
            </div>
            <Toggle
              label="Show on-screen badges"
              :model-value="store.showBadges"
              :disabled="badgesSaving"
              @update:model-value="setBadges"
            />
          </div>
          <div class="badge-preview">
            <div class="badge-chip"><span class="badge-dot" />live · screen-3 · rev</div>
            <span class="hint">
              {{ store.showBadges ? "Shown on every connected screen." : "Hidden on every connected screen." }}
            </span>
          </div>
        </section>

        <!-- Enrolment token -------------------------------------------------- -->
        <section id="sec-fleet" class="card">
          <h2 class="card-title">Enrolment token</h2>
          <p class="card-sub gap">The shared secret new machines present when they dial in.</p>

          <div v-if="store.enrollment === null" class="hint">Loading…</div>

          <div v-else-if="store.enrollmentOpen" class="open-note">
            <span class="badge-ok">Open mode</span>
            <span>
              Any agent that connects is auto-registered — no token required. Set an enrolment secret on the
              server to gate access.
            </span>
          </div>

          <template v-else>
            <div class="field-row">
              <code class="mono-field">{{ store.enrollmentToken }}</code>
              <button
                type="button"
                class="btn-ghost-sm"
                @click="copy(store.enrollmentToken ?? '', 'Enrolment token copied')"
              >
                Copy
              </button>
              <button type="button" class="btn-ghost-sm" :disabled="regenerating" @click="regenerate">
                {{ regenerating ? "Regenerating…" : "Regenerate" }}
              </button>
            </div>
            <p class="hint gap-sm">Regenerating revokes access for machines that haven't dialled in yet.</p>
          </template>
        </section>

        <!-- Netboot (POL-33) -------------------------------------------------- -->
        <section id="sec-netboot" class="card">
          <div class="title-row">
            <h2 class="card-title">Netboot</h2>
            <span class="chip chip-ok"><span class="chip-dot" />Secure Boot · disk-free</span>
          </div>
          <p class="card-sub wrap gap">
            Boot a bare machine straight into Polyptic over the network — no OS install, no disk. Write the
            ready-made medium to a USB stick and it chains the boot config below.
          </p>

          <div v-if="store.netboot === null" class="hint">Loading…</div>

          <template v-else>
            <div class="url-fields">
              <div>
                <div class="field-label">Control-plane URL</div>
                <div class="field-row">
                  <div class="mono-field ellipsis">{{ store.netboot.baseUrl }}</div>
                  <button
                    type="button"
                    class="btn-ghost-sm"
                    @click="copy(store.netboot.baseUrl, 'Control-plane URL copied')"
                  >
                    Copy
                  </button>
                </div>
              </div>
              <div>
                <div class="field-label">Boot config URL</div>
                <div class="field-row">
                  <div class="mono-field ellipsis">{{ store.netboot.bootConfigUrl }}</div>
                  <button
                    type="button"
                    class="btn-ghost-sm"
                    @click="copy(store.netboot.bootConfigUrl, 'Boot config URL copied')"
                  >
                    Copy
                  </button>
                </div>
              </div>
            </div>

            <div class="field-label steps-label">Get a bare box onto the wall</div>
            <ol class="steps">
              <li class="step">
                <div class="step-gutter"><span class="step-num">1</span><span class="step-line" /></div>
                <div class="step-body">
                  Download the boot medium and write it to a USB stick —
                  <code class="code">dd if=polyptic-boot.img of=/dev/sdX bs=4M</code>. One stick boots amd64 and
                  arm64 alike.
                </div>
              </li>
              <li class="step">
                <div class="step-gutter"><span class="step-num">2</span><span class="step-line" /></div>
                <div class="step-body">
                  Boot the bare box from USB with Secure Boot left <b>ON</b>. The signed loader streams the live
                  image from the server into RAM, so the box needs <b>~4&nbsp;GB of RAM</b> — for anything less,
                  use the live ISO instead.
                </div>
              </li>
              <li class="step">
                <div class="step-gutter"><span class="step-num">3</span></div>
                <div class="step-body last">
                  The box appears in <b>Machines</b> —
                  <template v-if="store.netboot.mode === 'gated'">approve it there and it joins the wall.</template>
                  <template v-else>it is auto-approved (open mode) and joins the wall.</template>
                </div>
              </li>
            </ol>

            <div v-if="store.netboot.bootMediumUrl || store.netboot.liveIsos.length > 0" class="btn-row">
              <a v-if="store.netboot.bootMediumUrl" class="btn btn-primary" :href="store.netboot.bootMediumUrl" download>
                Download boot medium
              </a>
              <a
                v-for="iso in store.netboot.liveIsos"
                :key="iso.arch"
                class="btn-ghost-sm as-link"
                :href="iso.url"
                download
              >
                Download live ISO ({{ iso.arch }})
              </a>
            </div>

            <p v-if="store.netboot.liveIsos.length > 0" class="hint gap-sm">
              The live ISO needs no netboot at all — write it to a stick, boot, and the box enrols itself. It runs
              the OS off the stick rather than out of RAM, so <b>~2&nbsp;GB</b> is enough (netboot needs ~4&nbsp;GB).
              It bakes the current enrolment token, so treat the file as a credential: regenerate the token above and
              rebuild to revoke old copies. A box booted this way does not auto-update — reflash it after a rebuild.
            </p>

            <button type="button" class="disclosure" :class="{ open: advOpen }" @click="advOpen = !advOpen">
              <span class="caret">›</span>Build &amp; advanced options
            </button>

            <div v-if="advOpen" class="adv">
              <div v-if="!store.netboot.bootMediumUrl" class="adv-note">
                No prebuilt medium is bundled yet. Build one into <code class="code">BOOT_DIST_DIR</code> with
                <code class="code">deploy/build-boot-medium.sh</code>, or point DHCP option 67 / UEFI HTTP Boot at
                <code class="code">{{ store.netboot.baseUrl }}/dist/boot/shimx64.efi</code>. See
                <code class="code">docs/NETBOOT.md</code> for the recipe and the arm64 name.
              </div>
              <div class="adv-note">
                Choosing <b>offload</b> in the boot menu installs the loader on the box once; after that it self-boots
                over the network without the USB stick.
              </div>
              <div class="callout callout-warn">
                <span class="callout-icon">⚠</span>
                <span v-if="store.netboot.mode === 'gated'">
                  Fleet ownership <b>is</b> the enrolment token — the boot flow bakes it in, so multiple Polyptic
                  instances can share one network. Keep the netboot network operator-only, and regenerate the token
                  above to revoke.
                </span>
                <span v-else>
                  Open mode: any machine that netboots is auto-enrolled. Set an enrolment token to gate access and bind
                  boxes to this server by key.
                </span>
              </div>
            </div>
          </template>
        </section>

        <!-- Image updates (POL-41 / POL-43) ----------------------------------- -->
        <section id="sec-image" class="card">
          <div class="card-head tight">
            <h2 class="card-title">Image updates</h2>
            <span class="chip" :class="`chip-${buildChip.tone}`">
              <span v-if="buildChip.tone === 'busy'" class="spinner" />
              {{ buildChip.text }}
            </span>
          </div>
          <p class="card-sub wrap gap">
            Two cycles keep the live image current: a nightly in-place refresh for userspace fixes, and a weekly full
            rebuild from the base ISO for kernel fixes. Netbooted boxes re-pull on change.
          </p>

          <div v-if="store.imageUpdates === null" class="hint">Loading image-update state…</div>

          <template v-else>
            <div class="sched">
              <div class="sched-row">
                <Toggle
                  label="Nightly refresh"
                  :model-value="store.imageUpdates.scheduleEnabled"
                  :disabled="imgSaving"
                  @update:model-value="applyImageSettings({ scheduleEnabled: $event })"
                />
                <div class="min-w-0 sched-text">
                  <div class="sched-title">Nightly refresh</div>
                  <div class="sched-sub">Userspace bug &amp; security fixes, in place.</div>
                </div>
                <input
                  class="time-input"
                  type="time"
                  aria-label="Nightly refresh time"
                  :value="store.imageUpdates.scheduleTime"
                  :disabled="imgSaving"
                  @change="saveTime(($event.target as HTMLInputElement).value, 'scheduleTime')"
                />
              </div>
              <div class="sched-row">
                <Toggle
                  label="Weekly full rebuild"
                  :model-value="store.imageUpdates.fullScheduleEnabled"
                  :disabled="imgSaving"
                  @update:model-value="applyImageSettings({ fullScheduleEnabled: $event })"
                />
                <div class="min-w-0 sched-text">
                  <div class="sched-title">Full rebuild <span class="sched-title-note">(kernel)</span></div>
                  <div class="sched-sub">Weekly rebuild from the base ISO.</div>
                </div>
                <select
                  class="select-input"
                  aria-label="Full rebuild day"
                  :value="store.imageUpdates.fullScheduleDay"
                  :disabled="imgSaving"
                  @change="applyImageSettings({ fullScheduleDay: Number(($event.target as HTMLSelectElement).value) })"
                >
                  <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
                </select>
                <input
                  class="time-input"
                  type="time"
                  aria-label="Full rebuild time"
                  :value="store.imageUpdates.fullScheduleTime"
                  :disabled="imgSaving"
                  @change="saveTime(($event.target as HTMLInputElement).value, 'fullScheduleTime')"
                />
              </div>
            </div>

            <div class="status-strip">
              <div class="min-w-0">
                <div class="status-title">{{ lastBuildLabel }}</div>
                <div class="status-sub">Rollout in the nightly window (03:00–05:00 per box), splayed.</div>
              </div>
              <button
                v-if="!store.imageUpdates.urgent"
                type="button"
                class="btn-ghost-sm"
                :disabled="imgSaving"
                @click="setUrgent(true)"
              >
                Mark urgent
              </button>
              <button
                type="button"
                class="btn-ghost-sm"
                :disabled="imgSaving || !store.imageUpdates.rebuildConfigured || rebuilding"
                @click="rebuildNow('refresh')"
              >
                Refresh now
              </button>
              <button
                type="button"
                class="btn-ghost-sm"
                :disabled="imgSaving || !store.imageUpdates.fullRebuildConfigured || rebuilding"
                @click="rebuildNow('full')"
              >
                Full rebuild now
              </button>
            </div>

            <div v-if="store.imageUpdates.urgent" class="callout callout-warn gap-sm">
              <span class="callout-icon">⚠</span>
              <span>
                <b>Urgent roll-out is on</b> — any netbooted box running a different image reboots within minutes.
                Switch it off once the fleet has converged.
                <button type="button" class="link-btn" :disabled="imgSaving" @click="setUrgent(false)">
                  Clear urgent
                </button>
              </span>
            </div>

            <p v-if="store.imageUpdates.images.length > 0" class="hint gap-sm">
              Published image<span v-if="store.imageUpdates.images.length > 1">s</span>:
              <code v-for="img in store.imageUpdates.images" :key="img.arch" class="code">
                {{ img.arch }} · {{ img.imageId }}
              </code>
            </p>
            <p v-else class="hint gap-sm">
              No published image carries an id yet — rebuild once with the current
              <code class="code">deploy/build-live-image.sh</code> to start tracking updates.
            </p>

            <p v-if="!store.imageUpdates.rebuildConfigured" class="hint gap-sm">
              This server has no refresh hook (<code class="code">IMAGE_REBUILD_CMD</code>), so the nightly schedule
              and “Refresh now” cannot build from here — set it to e.g.
              <code class="code">deploy/rebuild-image-docker.sh arm64</code>.
            </p>
            <p v-if="!store.imageUpdates.fullRebuildConfigured" class="hint gap-sm">
              The nightly refresh holds the kernel, so kernel fixes need the weekly full rebuild — configure
              <code class="code">IMAGE_FULL_REBUILD_CMD</code> (e.g.
              <code class="code">deploy/full-rebuild-image-docker.sh arm64</code>) to enable it.
            </p>
          </template>
        </section>

        <!-- Change password --------------------------------------------------- -->
        <section id="sec-security" class="card">
          <h2 class="card-title">Change password</h2>
          <p class="card-sub gap">Use at least 8 characters.</p>

          <div class="pw-grid">
            <div class="pw-full">
              <label class="field-label" for="pw-current">Current password</label>
              <input
                id="pw-current"
                v-model="pw.current"
                class="input"
                type="password"
                autocomplete="current-password"
                :disabled="pwSaving"
                @keyup.enter="onChangePassword"
              />
            </div>
            <div>
              <label class="field-label" for="pw-next">New password</label>
              <input
                id="pw-next"
                v-model="pw.next"
                class="input"
                type="password"
                autocomplete="new-password"
                :disabled="pwSaving"
                @keyup.enter="onChangePassword"
              />
            </div>
            <div>
              <label class="field-label" for="pw-confirm">Confirm new password</label>
              <input
                id="pw-confirm"
                v-model="pw.confirm"
                class="input"
                type="password"
                autocomplete="new-password"
                :disabled="pwSaving"
                @keyup.enter="onChangePassword"
              />
            </div>
          </div>

          <div v-if="pwError" class="callout callout-bad"><span class="callout-icon">⚠</span>{{ pwError }}</div>
          <div v-if="pwSuccess" class="callout callout-ok"><span class="callout-icon">✓</span>Password changed.</div>

          <button type="button" class="btn btn-primary" :disabled="pwSaving" @click="onChangePassword">
            {{ pwSaving ? "Saving…" : "Change password" }}
          </button>
        </section>

        <!-- Account ----------------------------------------------------------- -->
        <section id="sec-account" class="card">
          <h2 class="card-title gap">Account</h2>
          <div class="account">
            <div class="avatar">{{ store.accountInitials }}</div>
            <div class="min-w-0 who">
              <div class="who-name">Operator</div>
              <div class="who-email">{{ store.currentEmail || "—" }}</div>
            </div>
            <button type="button" class="btn-ghost-sm" :disabled="loggingOut" @click="onSignOut">
              {{ loggingOut ? "Signing out…" : "Sign out" }}
            </button>
          </div>
        </section>
      </div>
    </div>

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.min-w-0 {
  min-width: 0;
}

/* ── Section rail ──────────────────────────────────────────────────────────── */
.sec-nav {
  flex: 0 0 216px;
  width: 216px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  padding: 26px 14px;
  overflow-y: auto;
}
.sec-nav-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted2);
  padding: 0 8px 10px;
}
.sec-link {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  margin-bottom: 1px;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
}
.sec-link:hover {
  color: var(--fg2);
}
.sec-link.active {
  background: var(--muted-bg);
  color: var(--fg);
}
.sec-dot {
  flex: 0 0 5px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: transparent;
}
.sec-link.active .sec-dot {
  background: var(--accent-fg);
}

/* ── Page ──────────────────────────────────────────────────────────────────── */
.scroll {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  scroll-behavior: smooth;
}
.inner {
  max-width: 720px;
  margin: 0 auto;
  padding: 36px 40px 90px;
}
.page-title {
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 4px;
}
.page-sub {
  font-size: 13px;
  color: var(--muted);
  margin: 0 0 30px;
}

/* ── Cards ─────────────────────────────────────────────────────────────────── */
.card {
  border-radius: 14px;
  padding: 20px 22px;
  margin-bottom: 16px;
}
.card:last-child {
  margin-bottom: 0;
}
.row-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 22px;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}
.card-head.tight {
  align-items: center;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.card-title {
  font-size: 15px;
  font-weight: 600;
  margin: 0;
}
.card-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin: 4px 0 0;
}
.card-sub.wrap {
  max-width: 520px;
  line-height: 1.55;
}
.gap {
  margin-bottom: 16px;
}
.gap-sm {
  margin-top: 10px;
}
.hint {
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.55;
  margin: 0;
}

/* Appearance uses the shared .pill-group, but as real buttons. */
.pill {
  border: none;
  background: transparent;
  font-family: inherit;
}

/* ── Badges ────────────────────────────────────────────────────────────────── */
.badge-preview {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.badge-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
  background: #0d0d10;
  color: #e4e4e7;
  padding: 5px 9px;
  border-radius: 7px;
}
.badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
}

/* ── Fields, chips, buttons ────────────────────────────────────────────────── */
.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  display: block;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--muted);
  margin-bottom: 6px;
}
.mono-field {
  flex: 1;
  min-width: 0;
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12.5px;
  color: var(--fg2);
  background: var(--muted-bg);
  border: 1px solid var(--line);
  padding: 9px 12px;
  border-radius: 9px;
  overflow: hidden;
}
.ellipsis {
  white-space: nowrap;
  text-overflow: ellipsis;
}
.code {
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 11.5px;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  padding: 1px 6px;
  border-radius: 5px;
  white-space: nowrap;
}
.btn-ghost-sm {
  flex: 0 0 auto;
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
}
.btn-ghost-sm:hover:not(:disabled) {
  background: var(--muted-bg);
}
.btn-ghost-sm:disabled {
  opacity: 0.55;
  cursor: default;
}
.as-link {
  display: inline-flex;
  align-items: center;
  text-decoration: none;
}
.link-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-weight: 600;
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: underline;
}
.link-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  font-size: 11.5px;
  font-weight: 600;
  padding: 5px 11px;
  border-radius: 20px;
}
.chip-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentcolor;
}
.chip-ok {
  color: var(--ok);
  background: var(--ok-soft);
}
.chip-busy {
  color: var(--accent-fg);
  background: var(--accent-soft);
}
.chip-bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.chip-idle {
  color: var(--muted);
  background: var(--muted-bg);
  border: 1px solid var(--line);
}
.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.badge-ok {
  flex: 0 0 auto;
  background: var(--ok-soft);
  color: var(--ok);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.open-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}

/* ── Netboot ───────────────────────────────────────────────────────────────── */
.url-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 22px;
}
.steps-label {
  margin-bottom: 14px;
}
.steps {
  list-style: none;
  margin: 0 0 20px;
  padding: 0;
}
.step {
  display: flex;
  gap: 14px;
}
.step-gutter {
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 0 0 auto;
}
.step-num {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12px;
  font-weight: 600;
}
.step-line {
  flex: 1;
  width: 2px;
  background: var(--line);
  margin: 4px 0;
}
.step-body {
  padding-bottom: 16px;
  font-size: 13px;
  color: var(--fg2);
  line-height: 1.55;
}
.step-body.last {
  padding-bottom: 0;
}
.step-body b {
  color: var(--fg);
  font-weight: 600;
}
.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.disclosure {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  margin-top: 18px;
  padding: 16px 0 0;
  border: none;
  border-top: 1px solid var(--line);
  background: none;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
}
.disclosure:hover {
  color: var(--fg);
}
.caret {
  display: inline-block;
  font-size: 15px;
  transition: transform 0.18s ease;
}
.disclosure.open .caret {
  transform: rotate(90deg);
}
.adv {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
  animation: fadein 0.2s ease;
}
.adv-note {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px 14px;
}
.adv-note b {
  color: var(--fg2);
  font-weight: 600;
}
.adv-note .code {
  background: var(--card);
}

/* ── Callouts ──────────────────────────────────────────────────────────────── */
.callout {
  display: flex;
  gap: 10px;
  font-size: 12px;
  line-height: 1.6;
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.callout.gap-sm {
  margin-bottom: 0;
}
.callout-icon {
  flex: 0 0 auto;
  font-size: 13px;
}
.callout-warn {
  color: var(--muted);
  background: var(--warn-soft);
}
.callout-warn .callout-icon {
  color: var(--warn);
}
.callout-warn b {
  color: var(--fg2);
  font-weight: 600;
}
.callout-bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.callout-ok {
  color: var(--ok);
  background: var(--ok-soft);
}

/* ── Image updates ─────────────────────────────────────────────────────────── */
.sched {
  border: 1px solid var(--line);
  border-radius: 11px;
  overflow: hidden;
}
.sched-row {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
}
.sched-row + .sched-row {
  border-top: 1px solid var(--line);
}
.sched-text {
  flex: 1;
}
.sched-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
}
.sched-title-note {
  font-weight: 400;
  color: var(--muted);
}
.sched-sub {
  font-size: 11.5px;
  color: var(--muted);
  margin-top: 1px;
}
.time-input,
.select-input {
  flex: 0 0 auto;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--fg);
  font-family: inherit;
  font-size: 12.5px;
}
.time-input {
  padding: 7px 9px;
  font-family: "Geist Mono", ui-monospace, monospace;
}
.time-input::-webkit-calendar-picker-indicator {
  filter: var(--pick-filter, none);
  opacity: 0.55;
  cursor: pointer;
}
.select-input {
  -webkit-appearance: none;
  appearance: none;
  padding: 7px 26px 7px 10px;
  cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%2371717a' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 9px center;
}
.time-input:disabled,
.select-input:disabled {
  opacity: 0.55;
}
.status-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 16px;
  padding: 12px 16px;
  background: var(--muted-bg);
  border-radius: 11px;
}
.status-strip > .min-w-0 {
  flex: 1;
}
.status-strip .btn-ghost-sm {
  padding: 7px 12px;
  border-radius: 8px;
  font-size: 12px;
}
.status-strip .btn-ghost-sm:hover:not(:disabled) {
  background: var(--card);
}
.status-title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
}
.status-sub {
  font-size: 11px;
  color: var(--muted2);
  margin-top: 2px;
}

/* ── Password ──────────────────────────────────────────────────────────────── */
.pw-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  margin-bottom: 16px;
}
.pw-full {
  grid-column: 1 / -1;
  max-width: 340px;
}
.pw-grid .input {
  padding: 10px 12px;
  font-size: 13.5px;
}

/* ── Account ───────────────────────────────────────────────────────────────── */
.account {
  display: flex;
  align-items: center;
  gap: 14px;
}
.avatar {
  flex: 0 0 auto;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 600;
  color: var(--accent-fg);
}
.who {
  flex: 1;
}
.who-name {
  font-size: 14px;
  font-weight: 600;
}
.who-email {
  font-size: 12.5px;
  color: var(--muted);
}

/* ── Toast ─────────────────────────────────────────────────────────────────── */
.toast {
  position: fixed;
  left: 50%;
  bottom: 26px;
  transform: translateX(-50%);
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 500;
  padding: 10px 16px;
  border-radius: 9px;
  box-shadow: var(--shadow-lg);
  z-index: 50;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
