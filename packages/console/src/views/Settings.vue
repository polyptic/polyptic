<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import * as auth from "../auth";
import { useConsoleStore } from "../stores/console";

// The real Settings view (Phase 3f — D29): signed-in account, change password, logout, the
// enrollment-token card (open-mode note or gated token with Copy + Regenerate), and the theme toggle.
const store = useConsoleStore();
const router = useRouter();

onMounted(() => {
  // Load the enrollment-token info (open vs gated) so the card can render the real value.
  void store.fetchEnrollment();
  // Load the netboot info (control-plane base + boot config URL + boot-medium download) for the Netboot card.
  void store.fetchNetboot();
  // Load the fleet-wide badge toggle so the card is correct even before the admin/state snapshot lands.
  void store.fetchDisplaySettings();
  // Load the image-updates state (schedule, urgency, last rebuild, published images) (POL-41).
  void store.fetchImageUpdates();
});

function setTheme(theme: "light" | "dark"): void {
  if (store.theme !== theme) store.toggleTheme();
}

// ── On-screen badges (POL-6) ────────────────────────────────────────────────────
const badgesSaving = ref(false);

async function setBadges(show: boolean): Promise<void> {
  if (badgesSaving.value || store.showBadges === show) return;
  badgesSaving.value = true;
  try {
    await store.setShowBadges(show);
  } catch {
    /* the store already reverted the optimistic value; the pills reflect the true state */
  } finally {
    badgesSaving.value = false;
  }
}

// ── Logout ────────────────────────────────────────────────────────────────────
const loggingOut = ref(false);
async function onSignOut(): Promise<void> {
  if (loggingOut.value) return;
  loggingOut.value = true;
  await store.logout();
  await router.replace({ name: "signin" });
}

// ── Enrollment token ────────────────────────────────────────────────────────────
const copied = ref(false);
const regenerating = ref(false);

async function copyToken(): Promise<void> {
  const token = store.enrollmentToken;
  if (!token) return;
  try {
    await navigator.clipboard.writeText(token);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable (e.g. non-secure context) — Copy is a best-effort convenience */
  }
}

async function regenerate(): Promise<void> {
  if (regenerating.value) return;
  if (!window.confirm("Regenerate the enrolment token? Machines still using the old token can no longer dial in.")) {
    return;
  }
  regenerating.value = true;
  await store.regenerateEnrollment();
  regenerating.value = false;
}

// ── Netboot (POL-33) ──────────────────────────────────────────────────────────
// A per-field copy indicator (which URL was last copied), one helper for the base + boot config URLs.
const nbCopied = ref<string | null>(null);

async function copyNetboot(text: string, which: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    nbCopied.value = which;
    window.setTimeout(() => {
      if (nbCopied.value === which) nbCopied.value = null;
    }, 1600);
  } catch {
    /* clipboard unavailable (non-secure context), Copy is best-effort */
  }
}

// ── Image updates (POL-41 daily refresh + POL-43 weekly full rebuild) ───────────
const imgSaving = ref(false);
const imgTime = ref("");
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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
  } finally {
    imgSaving.value = false;
  }
}

async function rebuildNow(kind: "refresh" | "full" = "refresh"): Promise<void> {
  if (imgSaving.value) return;
  imgSaving.value = true;
  try {
    store.imageUpdates = await auth.rebuildImageNow(kind);
  } catch (err) {
    console.error("[console] rebuild trigger failed", err);
  } finally {
    imgSaving.value = false;
  }
}

function saveScheduleTime(): void {
  const t = imgTime.value.trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) void applyImageSettings({ scheduleTime: t });
}

function saveFullScheduleTime(value: string): void {
  const t = value.trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) void applyImageSettings({ fullScheduleTime: t });
}

// ── Change password ─────────────────────────────────────────────────────────────
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
</script>

<template>
  <div class="page">
    <div class="page-inner">
      <h1 class="page-title">Settings</h1>

      <!-- Appearance ------------------------------------------------------------ -->
      <div class="card panel">
        <div class="panel-title">Appearance</div>
        <div class="panel-sub">Theme for the console.</div>
        <div class="pill-group">
          <div class="pill" :class="{ active: store.theme === 'light' }" @click="setTheme('light')">
            ☼ Light
          </div>
          <div class="pill" :class="{ active: store.theme === 'dark' }" @click="setTheme('dark')">
            ☾ Dark
          </div>
        </div>
      </div>

      <!-- On-screen badges ------------------------------------------------------ -->
      <div class="card panel">
        <div class="panel-title">On-screen badges</div>
        <div class="panel-sub">
          The status badge (<code class="inline-code">live · screen-N · rev</code>) shown in the corner of
          every screen. Off by default in production, on in development.
        </div>
        <div class="pill-group">
          <div
            class="pill"
            :class="{ active: store.showBadges }"
            :aria-disabled="badgesSaving"
            @click="setBadges(true)"
          >
            ● Shown
          </div>
          <div
            class="pill"
            :class="{ active: !store.showBadges }"
            :aria-disabled="badgesSaving"
            @click="setBadges(false)"
          >
            ○ Hidden
          </div>
        </div>
        <div class="badges-hint">Applies live to every connected screen.</div>
      </div>

      <!-- Enrolment token ------------------------------------------------------- -->
      <div class="card panel">
        <div class="panel-title">Enrolment token</div>
        <div class="panel-sub">The shared secret new machines present when they dial in.</div>

        <template v-if="store.enrollment === null">
          <div class="token-empty">Loading…</div>
        </template>

        <template v-else-if="store.enrollmentOpen">
          <div class="open-note">
            <span class="open-badge">Open mode</span>
            <span>Any agent that connects is auto-registered — no token required. Set an enrolment
              secret on the server to gate access.</span>
          </div>
        </template>

        <template v-else>
          <div class="token-row">
            <code class="token">{{ store.enrollmentToken }}</code>
            <button class="btn-ghost-sm" @click="copyToken">{{ copied ? "Copied ✓" : "Copy" }}</button>
            <button class="btn-ghost-sm" :disabled="regenerating" @click="regenerate">
              {{ regenerating ? "Regenerating…" : "Regenerate" }}
            </button>
          </div>
          <div class="token-hint">New machines must present this token to dial in.</div>
        </template>
      </div>

      <!-- Netboot (POL-33) ------------------------------------------------------ -->
      <div class="card panel">
        <div class="panel-title">Netboot</div>
        <div class="panel-sub">
          Boot a bare machine straight into Polyptic over the network with Secure Boot ON, no OS install,
          no disk. Write the ready-made boot medium to a USB stick; it chains the boot config URL below.
        </div>

        <template v-if="store.netboot === null">
          <div class="token-empty">Loading…</div>
        </template>

        <template v-else>
          <label class="field-label">Control-plane URL</label>
          <div class="token-row">
            <code class="token">{{ store.netboot.baseUrl }}</code>
            <button class="btn-ghost-sm" @click="copyNetboot(store.netboot.baseUrl, 'base')">
              {{ nbCopied === "base" ? "Copied ✓" : "Copy" }}
            </button>
          </div>

          <label class="field-label nb-gap">Boot config URL</label>
          <div class="token-row">
            <code class="token">{{ store.netboot.bootConfigUrl }}</code>
            <button class="btn-ghost-sm" @click="copyNetboot(store.netboot.bootConfigUrl, 'config')">
              {{ nbCopied === "config" ? "Copied ✓" : "Copy" }}
            </button>
          </div>

          <div class="nb-steps">
            <div class="nb-step">
              <span class="nb-num">1</span> Download the boot medium and write it to a USB stick
              (<code class="inline-code">dd if=polyptic-boot.img of=/dev/sdX bs=4M</code>); one stick boots
              amd64 and arm64 alike.
            </div>
            <div class="nb-step">
              <span class="nb-num">2</span> Plug it into the bare box and boot from USB, leaving Secure
              Boot ON. The signed loader streams the live image from this server into RAM.
            </div>
            <div class="nb-step">
              <span class="nb-num">3</span> The box appears in Machines,
              <template v-if="store.netboot.mode === 'gated'">approve it there.</template>
              <template v-else>it is auto-approved (open mode).</template>
            </div>
          </div>

          <div class="token-hint">
            Choosing "offload" in the boot menu installs the loader on the box once; after that it
            self-boots over the network without the USB stick.
          </div>

          <a
            v-if="store.netboot.bootMediumUrl"
            class="btn btn-primary save nb-download"
            :href="store.netboot.bootMediumUrl"
            download
            >Download boot medium</a
          >
          <div v-else class="token-hint nb-gap">
            No prebuilt boot medium bundled yet, build one into
            <code class="inline-code">BOOT_DIST_DIR</code> with
            <code class="inline-code">deploy/build-boot-medium.sh</code>, or point DHCP option 67 / UEFI
            HTTP Boot at <code class="inline-code">{{ store.netboot.baseUrl }}/dist/boot/shimx64.efi</code>
            (see <code class="inline-code">docs/NETBOOT.md</code> for the recipe and the arm64 name).
          </div>

          <template v-if="store.netboot.liveIsos.length > 0">
            <div class="token-hint nb-gap">
              Prefer no netboot? Download the self-contained live ISO instead: write it to a USB stick
              (or attach it to a UEFI VM) and the box boots straight into Polyptic and enrols — nothing
              installed, nothing on the disk. It bakes the current enrolment token, so treat the file
              like a credential; regenerate the token above and rebuild to revoke old copies.
            </div>
            <a
              v-for="iso in store.netboot.liveIsos"
              :key="iso.arch"
              class="btn btn-primary save nb-download"
              :href="iso.url"
              download
              >Download live ISO ({{ iso.arch }})</a
            >
          </template>

          <div v-if="store.netboot.mode === 'gated'" class="nb-note">
            Ownership of the fleet is the enrolment token, which the boot flow above bakes in, so multiple
            Polyptic instances can share a network without collision. Keep the netboot network
            operator-only, and regenerate the token (card above) to revoke.
          </div>
          <div v-else class="nb-note">
            Open mode: any machine that netboots is auto-enrolled. Set an enrolment token to gate access and
            bind boxes to this server by key.
          </div>
        </template>
      </div>

      <!-- Image updates (POL-41) ------------------------------------------------ -->
      <div class="card panel">
        <div class="panel-title">Image updates</div>
        <div class="panel-sub">
          Two update cycles keep the live image current: a nightly in-place refresh (userspace
          bug/security fixes) and a weekly full rebuild from the base ISO (kernel fixes included).
          Netbooted boxes compare image ids with this server every 5 minutes and reboot to re-pull —
          overnight by default, within minutes when marked urgent.
        </div>

        <template v-if="store.imageUpdates === null">
          <div class="token-hint">Loading image-update state…</div>
        </template>
        <template v-else>
          <div class="token-hint" v-if="store.imageUpdates.images.length > 0">
            Published image<span v-if="store.imageUpdates.images.length > 1">s</span>:
            <code class="inline-code" v-for="img in store.imageUpdates.images" :key="img.arch">
              {{ img.arch }} · {{ img.imageId }}
            </code>
          </div>
          <div class="token-hint" v-else>
            No published image carries an id yet — rebuild once with the current
            <code class="inline-code">deploy/build-live-image.sh</code> to start tracking updates.
          </div>

          <div class="pill-group">
            <div
              class="pill"
              :class="{ active: store.imageUpdates.scheduleEnabled }"
              :aria-disabled="imgSaving"
              @click="applyImageSettings({ scheduleEnabled: true })"
            >
              ● Nightly refresh at
            </div>
            <input
              class="nb-time"
              type="time"
              :value="store.imageUpdates.scheduleTime"
              :disabled="imgSaving"
              @change="imgTime = ($event.target as HTMLInputElement).value; saveScheduleTime()"
            />
            <div
              class="pill"
              :class="{ active: !store.imageUpdates.scheduleEnabled }"
              :aria-disabled="imgSaving"
              @click="applyImageSettings({ scheduleEnabled: false })"
            >
              ○ Off
            </div>
          </div>
          <div class="token-hint" v-if="!store.imageUpdates.rebuildConfigured">
            This server has no refresh hook (<code class="inline-code">IMAGE_REBUILD_CMD</code>), so the
            schedule and “Refresh now” cannot build from here — set it to e.g.
            <code class="inline-code">deploy/rebuild-image-docker.sh arm64</code>.
          </div>

          <!-- Weekly FULL rebuild (POL-43): the cycle that rolls kernel CVEs. -->
          <div class="pill-group">
            <div
              class="pill"
              :class="{ active: store.imageUpdates.fullScheduleEnabled }"
              :aria-disabled="imgSaving"
              @click="applyImageSettings({ fullScheduleEnabled: true })"
            >
              ● Full rebuild (kernel) every
            </div>
            <select
              class="nb-time"
              :value="store.imageUpdates.fullScheduleDay"
              :disabled="imgSaving"
              @change="applyImageSettings({ fullScheduleDay: Number(($event.target as HTMLSelectElement).value) })"
            >
              <option v-for="(d, i) in WEEKDAYS" :key="d" :value="i">{{ d }}</option>
            </select>
            <input
              class="nb-time"
              type="time"
              :value="store.imageUpdates.fullScheduleTime"
              :disabled="imgSaving"
              @change="saveFullScheduleTime(($event.target as HTMLInputElement).value)"
            />
            <div
              class="pill"
              :class="{ active: !store.imageUpdates.fullScheduleEnabled }"
              :aria-disabled="imgSaving"
              @click="applyImageSettings({ fullScheduleEnabled: false })"
            >
              ○ Off
            </div>
          </div>
          <div class="token-hint" v-if="!store.imageUpdates.fullRebuildConfigured">
            The nightly refresh holds the kernel, so kernel fixes need this weekly full rebuild —
            configure <code class="inline-code">IMAGE_FULL_REBUILD_CMD</code> (e.g.
            <code class="inline-code">deploy/full-rebuild-image-docker.sh arm64</code>) to enable it.
          </div>

          <div class="nb-btn-row">
            <button
              class="btn btn-primary save nb-download"
              :disabled="imgSaving || !store.imageUpdates.rebuildConfigured || store.imageUpdates.lastBuild?.status === 'running'"
              @click="rebuildNow('refresh')"
            >
              {{ store.imageUpdates.lastBuild?.status === "running" ? "Rebuilding…" : "Refresh now" }}
            </button>
            <button
              class="btn save nb-download"
              :disabled="imgSaving || !store.imageUpdates.fullRebuildConfigured || store.imageUpdates.lastBuild?.status === 'running'"
              @click="rebuildNow('full')"
            >
              Full rebuild now
            </button>
          </div>
          <div class="token-hint" v-if="store.imageUpdates.lastBuild">
            Last rebuild: {{ store.imageUpdates.lastBuild.status
            }}<span v-if="store.imageUpdates.lastBuild.kind"> ({{ store.imageUpdates.lastBuild.kind === "full" ? "full rebuild" : "refresh" }})</span>
            ({{ new Date(store.imageUpdates.lastBuild.startedAt).toLocaleString() }})
          </div>

          <div class="nb-note" v-if="store.imageUpdates.urgent">
            <strong>Urgent roll-out is ON:</strong> any netbooted box running a different image reboots
            within minutes. Switch it off once the fleet has converged.
            <button class="btn-ghost-sm" :disabled="imgSaving" @click="applyImageSettings({ urgent: false })">
              Clear urgent
            </button>
          </div>
          <div class="nb-note" v-else>
            New images roll out in the nightly window (03:00–05:00 on each box). For a critical fix,
            <button class="btn-ghost-sm" :disabled="imgSaving" @click="applyImageSettings({ urgent: true })">
              mark urgent
            </button>
            — stale boxes reboot within minutes (splayed).
          </div>
        </template>
      </div>

      <!-- Change password ------------------------------------------------------- -->
      <div class="card panel">
        <div class="panel-title">Change password</div>
        <div class="panel-sub">Use at least 8 characters.</div>

        <label class="field-label">Current password</label>
        <input
          v-model="pw.current"
          class="input field"
          type="password"
          autocomplete="current-password"
          :disabled="pwSaving"
          @keyup.enter="onChangePassword"
        />

        <label class="field-label">New password</label>
        <input
          v-model="pw.next"
          class="input field"
          type="password"
          autocomplete="new-password"
          :disabled="pwSaving"
          @keyup.enter="onChangePassword"
        />

        <label class="field-label">Confirm new password</label>
        <input
          v-model="pw.confirm"
          class="input field"
          type="password"
          autocomplete="new-password"
          :disabled="pwSaving"
          @keyup.enter="onChangePassword"
        />

        <div v-if="pwError" class="error">⚠ {{ pwError }}</div>
        <div v-if="pwSuccess" class="success">✓ Password changed.</div>

        <button class="btn btn-primary save" :disabled="pwSaving" @click="onChangePassword">
          {{ pwSaving ? "Saving…" : "Change password" }}
        </button>
      </div>

      <!-- Account --------------------------------------------------------------- -->
      <div class="card panel">
        <div class="panel-title">Account</div>
        <div class="account">
          <div class="avatar">{{ store.accountInitials }}</div>
          <div class="who">
            <div class="who-name">Operator</div>
            <div class="who-email">{{ store.currentEmail || "—" }}</div>
          </div>
          <button class="btn btn-ghost" :disabled="loggingOut" @click="onSignOut">
            {{ loggingOut ? "Signing out…" : "Sign out" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.page-inner {
  max-width: 680px;
  margin: 0 auto;
  padding: 30px 32px 60px;
}
.page-title {
  font-size: 21px;
  font-weight: 600;
  letter-spacing: -0.02em;
  margin: 0 0 24px;
}
.panel {
  padding: 18px 20px;
  margin-bottom: 16px;
}
.panel-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 3px;
}
.panel-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-bottom: 14px;
}
.token-empty {
  font-size: 12.5px;
  color: var(--muted2);
}
.open-note {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.open-badge {
  flex: 0 0 auto;
  background: var(--ok-soft, var(--accent-soft));
  color: var(--ok, var(--accent-fg));
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  padding: 3px 9px;
  border-radius: 20px;
  white-space: nowrap;
}
.token-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.token {
  flex: 1;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.04em;
  background: var(--muted-bg);
  padding: 10px 13px;
  border-radius: 9px;
  overflow-x: auto;
  white-space: nowrap;
}
.token-hint {
  font-size: 11.5px;
  color: var(--muted2);
  margin-top: 8px;
}
.badges-hint {
  font-size: 11.5px;
  color: var(--muted2);
  margin-top: 10px;
}
/* ── Image updates card (POL-41) ── */
.nb-time {
  border: 1px solid var(--border, #d0d4dc);
  background: var(--bg, transparent);
  color: inherit;
  border-radius: 8px;
  padding: 4px 10px;
  font: inherit;
}
.nb-btn-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

/* ── Netboot card (POL-33) ── */
.nb-gap {
  margin-top: 14px;
}
.nb-steps {
  margin-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.nb-step {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.nb-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-right: 7px;
  border-radius: 50%;
  background: var(--muted-bg);
  font-size: 11px;
  font-weight: 600;
  color: var(--fg2);
}
.nb-download {
  display: inline-block;
  margin-top: 16px;
  text-decoration: none;
}
.nb-note {
  margin-top: 14px;
  font-size: 11.5px;
  color: var(--muted2);
  line-height: 1.5;
}
.inline-code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  background: var(--muted-bg);
  padding: 1px 5px;
  border-radius: 5px;
}
.btn-ghost-sm {
  padding: 9px 14px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  white-space: nowrap;
  font-family: inherit;
}
.btn-ghost-sm:hover:not(:disabled) {
  background: var(--muted-bg);
}
.btn-ghost-sm:disabled {
  opacity: 0.6;
  cursor: default;
}
.field-label {
  display: block;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg2);
  margin-bottom: 6px;
}
.field {
  margin-bottom: 14px;
}
.error {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--bad);
  background: var(--bad-soft);
  border-radius: 8px;
  padding: 9px 11px;
  margin-bottom: 14px;
}
.success {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--ok, var(--accent-fg));
  background: var(--ok-soft, var(--accent-soft));
  border-radius: 8px;
  padding: 9px 11px;
  margin-bottom: 14px;
}
.save {
  padding: 10px 16px;
  font-size: 13px;
}
.account {
  display: flex;
  align-items: center;
  gap: 12px;
}
.avatar {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.who {
  flex: 1;
}
.who-name {
  font-size: 13.5px;
  font-weight: 600;
}
.who-email {
  font-size: 12px;
  color: var(--muted);
}
</style>
