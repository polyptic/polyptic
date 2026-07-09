<script setup lang="ts">
import type { ImageBuild } from "@polyptic/protocol";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRouter } from "vue-router";

import * as auth from "../auth";
import Toggle from "../components/Toggle.vue";
import { useConsoleStore } from "../stores/console";
import { formatRelativeShort } from "../time";

// Settings (POL-45): one card per concern. "Onboard Screens" is the fleet's front door — the
// bootloader you write once to a USB stick, the builds it streams, and the ⋯ menu that rebuilds or
// force-deploys them. "Update schedule" owns when new images are cut; the rollout window explains
// when boxes take them.
const store = useConsoleStore();
const router = useRouter();

onMounted(() => {
  void store.fetchEnrollment();
  void store.fetchNetboot();
  void store.fetchDisplaySettings();
  void store.fetchImageUpdates();
  document.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));

function onKeydown(e: KeyboardEvent): void {
  if (e.key !== "Escape") return;
  if (usbModal.value) usbModal.value = false;
  else if (menuOpen.value) menuOpen.value = false;
  else if (rowMenu.value) rowMenu.value = null;
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

// ── Onboard Screens: the ⋯ build menu ──────────────────────────────────────────
const menuOpen = ref(false);
const imgSaving = ref(false);

const rebuilding = computed(() => store.imageUpdates?.lastBuild?.status === "running");

async function rebuildNow(kind: "refresh" | "full"): Promise<void> {
  menuOpen.value = false;
  if (imgSaving.value) return;
  imgSaving.value = true;
  try {
    store.imageUpdates = await auth.rebuildImageNow(kind);
    showToast(kind === "full" ? "Full rebuild queued" : "Build update queued");
  } catch (err) {
    console.error("[console] rebuild trigger failed", err);
    showToast("Could not start the rebuild");
  } finally {
    imgSaving.value = false;
  }
}

/** The urgent switch, framed as what it does: skip the nightly window and reboot the fleet now. */
async function setUrgent(urgent: boolean): Promise<void> {
  menuOpen.value = false;
  if (
    urgent &&
    !window.confirm(
      "Deploy the latest image to the whole fleet now? Every netbooted box on a different image reboots within minutes.",
    )
  ) {
    return;
  }
  await applyImageSettings({ urgent });
  if (store.imageUpdates?.urgent === urgent) {
    showToast(urgent ? "Deploying latest to fleet — boxes reboot within minutes" : "Immediate deployment stopped");
  }
}

// ── Onboard Screens: the bootloader + retained builds ──────────────────────────
const usbModal = ref(false);
const advOpen = ref(false);

/** The newest published image across arches — what a freshly written stick will stream on boot. */
const latestImage = computed(() => {
  const images = store.imageUpdates?.images ?? [];
  return [...images].sort((a, b) => b.builtAt.localeCompare(a.builtAt))[0] ?? null;
});

/** `20260709T110917Z-1bdb6281` → `20260709T110917Z · 1bdb6281`, the design's two-part id. */
function formatImageId(imageId: string): string {
  const cut = imageId.lastIndexOf("-");
  return cut > 0 ? `${imageId.slice(0, cut)} · ${imageId.slice(cut + 1)}` : imageId;
}

const nowMs = ref(Date.now());
const clock = window.setInterval(() => (nowMs.value = Date.now()), 30_000);
onBeforeUnmount(() => window.clearInterval(clock));

/** What the bootloader card says about the build pipeline right now. */
const buildStatus = computed<{ text: string; tone: "busy" | "bad" | "idle" } | null>(() => {
  const b = store.imageUpdates?.lastBuild;
  if (!b) return null;
  const when = new Date(b.startedAt).toLocaleString();
  if (b.status === "running") {
    return { text: `${b.kind === "full" ? "Full rebuild" : "Build update"} running — started ${when}`, tone: "busy" };
  }
  if (b.status === "failure") return { text: `Last build failed — ${when}`, tone: "bad" };
  return { text: `Built ${when}`, tone: "idle" };
});

function onDownloadBootloader(): void {
  // The design opens the how-to modal; the download itself is the point, so do both. The anchor's
  // own navigation starts the transfer — we only add the instructions the operator needs next.
  usbModal.value = true;
}

const activating = ref<string | null>(null);
/** Which build row has its overflow menu open, by `<arch>-<imageId>` (ids repeat across arches). */
const rowMenu = ref<string | null>(null);
const rowKey = (b: ImageBuild): string => `${b.arch}-${b.imageId}`;

async function activate(build: ImageBuild): Promise<void> {
  rowMenu.value = null;
  if (activating.value || build.active) return;
  if (
    !window.confirm(
      `Serve ${formatImageId(build.imageId)} (${build.arch}) to the fleet? Boxes on a different image will reboot into it.`,
    )
  ) {
    return;
  }
  activating.value = build.imageId;
  try {
    store.imageUpdates = await auth.activateImage(build.arch, build.imageId);
    showToast(`Now serving ${build.arch} · ${build.imageId.split("-").pop()}`);
  } catch (err) {
    console.error("[console] activate failed", err);
    showToast("Could not activate that build");
  } finally {
    activating.value = null;
  }
}

// ── Update schedule (POL-41 nightly refresh + POL-43 weekly full rebuild) ───────
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
    showToast("Could not save image settings");
  } finally {
    imgSaving.value = false;
  }
}

function saveTime(value: string, field: "scheduleTime" | "fullScheduleTime"): void {
  const t = value.trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return;
  void applyImageSettings(field === "scheduleTime" ? { scheduleTime: t } : { fullScheduleTime: t });
}

function goToOnboard(): void {
  document.getElementById("sec-netboot")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  <div class="page">
    <div class="inner">
      <h1 class="page-title">Settings</h1>
      <p class="page-sub">Console preferences, fleet enrolment, and the live-image lifecycle.</p>

      <!-- Appearance ---------------------------------------------------------- -->
      <section class="card row-card">
        <div>
          <h2 class="card-title">Appearance</h2>
          <p class="card-sub">Theme for the operator console.</p>
        </div>
        <div class="pill-group">
          <button type="button" class="pill" :class="{ active: store.theme === 'light' }" @click="setTheme('light')">
            ☼&nbsp; Light
          </button>
          <button type="button" class="pill" :class="{ active: store.theme === 'dark' }" @click="setTheme('dark')">
            ☾&nbsp; Dark
          </button>
        </div>
      </section>

      <!-- Onboard Screens (POL-33 netboot + POL-45 builds) --------------------- -->
      <section id="sec-netboot" class="card pad-lg">
        <div class="title-row">
          <h2 class="card-title">Onboard Screens</h2>
          <div class="spacer" />
          <div class="menu-wrap">
            <button
              type="button"
              class="menu-btn"
              :class="{ open: menuOpen }"
              aria-label="Build actions"
              :aria-expanded="menuOpen"
              @click="menuOpen = !menuOpen"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
              </svg>
            </button>
            <template v-if="menuOpen">
              <div class="menu-scrim" @click="menuOpen = false" />
              <div class="menu">
                <button
                  type="button"
                  class="menu-item"
                  :disabled="imgSaving || rebuilding || !store.imageUpdates?.rebuildConfigured"
                  @click="rebuildNow('refresh')"
                >
                  <svg
                    width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" /><polyline points="21 3 21 8 16 8" />
                  </svg>
                  <span class="menu-text">
                    <span class="menu-title">Build update</span>
                    <span class="menu-sub">In-place, userspace only.</span>
                  </span>
                </button>
                <button
                  type="button"
                  class="menu-item"
                  :disabled="imgSaving || rebuilding || !store.imageUpdates?.fullRebuildConfigured"
                  @click="rebuildNow('full')"
                >
                  <svg
                    width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                  >
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
                  </svg>
                  <span class="menu-text">
                    <span class="menu-title">Full rebuild</span>
                    <span class="menu-sub">From the base ISO, kernel included.</span>
                  </span>
                </button>
                <div class="menu-sep" />
                <button
                  type="button"
                  class="menu-item danger"
                  :disabled="imgSaving"
                  @click="setUrgent(!store.imageUpdates?.urgent)"
                >
                  <svg
                    width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" class="menu-icon warn"
                  >
                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
                  </svg>
                  <span class="menu-text">
                    <template v-if="store.imageUpdates?.urgent">
                      <span class="menu-title">Stop immediate deployment</span>
                      <span class="menu-sub">Let stale boxes wait for their nightly window.</span>
                    </template>
                    <template v-else>
                      <span class="menu-title">Deploy latest to fleet immediately</span>
                      <span class="menu-sub">Skip the nightly window — boxes reboot now.</span>
                    </template>
                  </span>
                </button>
              </div>
            </template>
          </div>
        </div>
        <p class="card-sub wrap gap">
          Enrol a machine straight into Polyptic over the network (no OS install, no disk). Write the bootloader to a
          USB stick and it streams the current image into RAM — so the box needs <b>~4&nbsp;GB of RAM</b>. For less,
          download a build's live ISO below: it runs off the stick and needs <b>~2&nbsp;GB</b>. The control-plane URL
          and enrolment token are baked into the image.
        </p>

        <!-- Network boot loader ---------------------------------------------- -->
        <div class="sub-card">
          <div class="sub-head">
            <span class="icon-tile">
              <svg
                width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--fg2)" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="22" x2="2" y1="12" y2="12" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                <line x1="6" x2="6.01" y1="16" y2="16" />
              </svg>
            </span>
            <div class="min-w-0 sub-text">
              <div class="sub-title">Network boot loader</div>
              <div class="sub-sub">Write once to USB. Screens boot from it and pull the latest image automatically.</div>
            </div>
            <span class="chip chip-accent">
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
              </svg>
              auto-updates
            </span>
          </div>

          <div class="dl-row">
            <div class="latest">
              <span class="latest-label">Latest</span>
              <span v-if="latestImage" class="latest-id">{{ formatImageId(latestImage.imageId) }}</span>
              <span v-else class="latest-id none">No image published yet</span>
            </div>
            <a
              v-if="store.netboot?.bootMediumUrl"
              class="btn btn-primary dl-btn"
              :href="store.netboot.bootMediumUrl"
              download
              @click="onDownloadBootloader"
            >
              <svg
                width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
                <line x1="12" x2="12" y1="15" y2="3" />
              </svg>
              Download bootloader
            </a>
            <button v-else type="button" class="btn btn-primary dl-btn" disabled>Bootloader not built</button>
          </div>

          <div v-if="buildStatus" class="build-status" :class="buildStatus.tone">
            <span v-if="buildStatus.tone === 'busy'" class="spinner" />
            {{ buildStatus.text }}
          </div>
          <p v-if="!store.netboot?.bootMediumUrl && store.netboot" class="hint gap-sm">
            No prebuilt bootloader is bundled. Build one into <code class="code">BOOT_DIST_DIR</code> with
            <code class="code">deploy/build-boot-medium.sh</code>.
          </p>
        </div>

        <!-- Recent builds ------------------------------------------------------ -->
        <div class="field-label">Recent builds</div>
        <div v-if="(store.imageUpdates?.builds.length ?? 0) > 0" class="builds">
          <div v-for="b in store.imageUpdates!.builds" :key="`${b.arch}-${b.imageId}`" class="build-row" :class="{ active: b.active }">
            <span class="arch">{{ b.arch }}</span>
            <span class="build-id">{{ formatImageId(b.imageId) }}</span>
            <span class="build-when">{{ formatRelativeShort(b.builtAt, nowMs) }}</span>
            <span class="tag" :class="b.active ? 'tag-ok' : 'tag-muted'">{{ b.active ? "Active" : "Superseded" }}</span>

            <!-- The active build has nothing to activate, so its single action stays a plain icon.
                 Every other row folds Download + Activate into an overflow menu. -->
            <template v-if="b.active">
              <a
                v-if="b.liveIsoUrl"
                class="row-btn"
                :href="b.liveIsoUrl"
                download
                :title="`Download the bootable live ISO for ${b.imageId}`"
              >
                <svg
                  width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"
                  stroke-linecap="round" stroke-linejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
                  <line x1="12" x2="12" y1="15" y2="3" />
                </svg>
              </a>
              <span v-else class="row-btn empty" title="This build has no standalone live ISO" />
            </template>

            <div v-else class="menu-wrap">
              <button
                type="button"
                class="row-btn"
                :class="{ open: rowMenu === rowKey(b) }"
                :aria-label="`Actions for build ${b.imageId}`"
                :aria-expanded="rowMenu === rowKey(b)"
                :disabled="activating !== null"
                @click="rowMenu = rowMenu === rowKey(b) ? null : rowKey(b)"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
                </svg>
              </button>
              <template v-if="rowMenu === rowKey(b)">
                <div class="menu-scrim" @click="rowMenu = null" />
                <div class="menu menu-row">
                  <a
                    v-if="b.liveIsoUrl"
                    class="menu-item"
                    :href="b.liveIsoUrl"
                    download
                    @click="rowMenu = null"
                  >
                    <svg
                      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                      stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                    >
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" />
                      <line x1="12" x2="12" y1="15" y2="3" />
                    </svg>
                    <span class="menu-text"><span class="menu-title">Download live ISO</span></span>
                  </a>
                  <button type="button" class="menu-item" :disabled="activating !== null" @click="activate(b)">
                    <svg
                      width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
                      stroke-linecap="round" stroke-linejoin="round" class="menu-icon"
                    >
                      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" />
                      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
                    </svg>
                    <span class="menu-text">
                      <span class="menu-title">{{ activating === b.imageId ? "Activating…" : "Activate" }}</span>
                      <span class="menu-sub">Serve this build to the fleet.</span>
                    </span>
                  </button>
                </div>
              </template>
            </div>
          </div>
        </div>
        <p v-else class="hint">
          No builds retained yet — the depot fills as images are built. Run a build from the ⋯ menu, or with
          <code class="code">deploy/build-live-image.sh</code>.
        </p>
        <p v-if="store.imageUpdates" class="hint gap-sm">
          Keeping the newest {{ store.imageUpdates.retainBuilds }} build<span v-if="store.imageUpdates.retainBuilds > 1">s</span>
          per architecture. Activating an older build rolls the fleet back to it. The download is that build's
          standalone live ISO, which bakes the current enrolment token — treat the file as a credential.
        </p>

        <!-- Boot without a USB stick (secondary) -------------------------------- -->
        <button type="button" class="disclosure" :class="{ open: advOpen }" @click="advOpen = !advOpen">
          <span class="caret">›</span>Boot without a USB stick
        </button>
        <div v-if="advOpen && store.netboot" class="adv">
          <div>
            <div class="adv-label"><b>Boot URI</b></div>
            <div class="field-row">
              <div class="mono-field muted ellipsis">{{ store.netboot.baseUrl }}/dist/boot/shimx64.efi</div>
              <button
                type="button"
                class="btn-ghost-sm"
                @click="copy(`${store.netboot.baseUrl}/dist/boot/shimx64.efi`, 'Boot URI copied')"
              >
                Copy
              </button>
            </div>
            <p class="adv-note">Type this into the box's UEFI setup as the HTTP Boot URI (arm64: shimaa64.efi).</p>
          </div>
          <div>
            <div class="adv-label"><b>Control-plane URL</b></div>
            <div class="field-row">
              <div class="mono-field muted ellipsis">{{ store.netboot.baseUrl }}</div>
              <button type="button" class="btn-ghost-sm" @click="copy(store.netboot.baseUrl, 'Control-plane URL copied')">
                Copy
              </button>
            </div>
            <p class="adv-note">The base the bootloader dials. Also what a DHCP option-67 rule hands out.</p>
          </div>
        </div>
      </section>

      <!-- On-screen badges ----------------------------------------------------- -->
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

      <!-- Enrolment token ------------------------------------------------------ -->
      <section class="card">
        <h2 class="card-title">Enrolment token</h2>
        <p class="card-sub gap">The shared secret new machines present when they dial in.</p>

        <div v-if="store.enrollment === null" class="hint">Loading…</div>

        <div v-else-if="store.enrollmentOpen" class="open-note">
          <span class="badge-ok">Open mode</span>
          <span>
            Any agent that connects is auto-registered — no token required. Set an enrolment secret on the server to
            gate access.
          </span>
        </div>

        <template v-else>
          <div class="field-row">
            <code class="mono-field">{{ store.enrollmentToken }}</code>
            <button type="button" class="btn-ghost-sm" @click="copy(store.enrollmentToken ?? '', 'Enrolment token copied')">
              Copy
            </button>
            <button type="button" class="btn-ghost-sm" :disabled="regenerating" @click="regenerate">
              {{ regenerating ? "Regenerating…" : "Regenerate" }}
            </button>
          </div>
          <p class="hint gap-sm">Regenerating revokes access for machines that haven't dialled in yet.</p>
        </template>
      </section>

      <!-- Update schedule ------------------------------------------------------ -->
      <section id="sec-image" class="card pad-lg">
        <h2 class="card-title">Update schedule</h2>
        <p class="card-sub wrap gap">
          When the live image is refreshed. A nightly in-place refresh picks up userspace fixes; a weekly full rebuild
          from the base ISO picks up kernel fixes. Netbooted boxes re-pull whenever the published image changes.
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

          <div class="rollout" :class="{ urgent: store.imageUpdates.urgent }">
            <svg
              v-if="!store.imageUpdates.urgent"
              width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
              stroke-linecap="round" stroke-linejoin="round" class="rollout-icon"
            >
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            <span v-else class="rollout-icon warn">⚡</span>
            <span v-if="store.imageUpdates.urgent">
              <b>Deploying to the fleet immediately.</b> Every netbooted box on a different image reboots within
              minutes, splayed. Stop it from the ⋯ menu in
              <button type="button" class="link-btn" @click="goToOnboard">Onboard Screens</button>.
            </span>
            <span v-else>
              Boxes roll over to a new image during their local nightly window (03:00–05:00), splayed to avoid a
              fleet-wide reboot. To push a release out faster, use <b>Deploy latest to fleet immediately</b> in
              <button type="button" class="link-btn" @click="goToOnboard">Onboard Screens</button>.
            </span>
          </div>

          <p v-if="!store.imageUpdates.rebuildConfigured" class="hint gap-sm">
            This server has no refresh hook (<code class="code">IMAGE_REBUILD_CMD</code>), so the nightly schedule and
            “Build update” cannot build from here — set it to e.g.
            <code class="code">deploy/rebuild-image-docker.sh arm64</code>.
          </p>
          <p v-if="!store.imageUpdates.fullRebuildConfigured" class="hint gap-sm">
            The nightly refresh holds the kernel, so kernel fixes need the weekly full rebuild — configure
            <code class="code">IMAGE_FULL_REBUILD_CMD</code> to enable it.
          </p>
        </template>
      </section>

      <!-- Change password ------------------------------------------------------ -->
      <section id="sec-security" class="card">
        <h2 class="card-title">Change password</h2>
        <p class="card-sub gap">Use at least 8 characters.</p>

        <div class="pw-grid">
          <div class="pw-full">
            <label class="field-label" for="pw-current">Current password</label>
            <input
              id="pw-current" v-model="pw.current" class="input" type="password" autocomplete="current-password"
              :disabled="pwSaving" @keyup.enter="onChangePassword"
            />
          </div>
          <div>
            <label class="field-label" for="pw-next">New password</label>
            <input
              id="pw-next" v-model="pw.next" class="input" type="password" autocomplete="new-password"
              :disabled="pwSaving" @keyup.enter="onChangePassword"
            />
          </div>
          <div>
            <label class="field-label" for="pw-confirm">Confirm new password</label>
            <input
              id="pw-confirm" v-model="pw.confirm" class="input" type="password" autocomplete="new-password"
              :disabled="pwSaving" @keyup.enter="onChangePassword"
            />
          </div>
        </div>

        <div v-if="pwError" class="callout callout-bad"><span class="callout-icon">⚠</span>{{ pwError }}</div>
        <div v-if="pwSuccess" class="callout callout-ok"><span class="callout-icon">✓</span>Password changed.</div>

        <button type="button" class="btn btn-primary" :disabled="pwSaving" @click="onChangePassword">
          {{ pwSaving ? "Saving…" : "Change password" }}
        </button>
      </section>

      <!-- Account --------------------------------------------------------------- -->
      <section class="card">
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

    <!-- Make a bootable USB ---------------------------------------------------- -->
    <Transition name="fade">
      <div v-if="usbModal" class="scrim" @click="usbModal = false">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="usb-title" @click.stop>
          <div class="modal-head">
            <span class="icon-tile lg">
              <svg
                width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--fg2)" stroke-width="1.7"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="22" x2="2" y1="12" y2="12" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
                <line x1="6" x2="6.01" y1="16" y2="16" />
              </svg>
            </span>
            <div class="min-w-0 modal-titles">
              <div id="usb-title" class="modal-title">Make a bootable USB</div>
              <div class="modal-sub">
                The bootloader fetches the latest Polyptic image every reboot. Keep the USB inserted for live boot or
                install it to disk.
              </div>
            </div>
            <button type="button" class="icon-btn" aria-label="Close" @click="usbModal = false">
              <svg
                width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          <ol class="modal-steps">
            <li class="step">
              <div class="step-gutter"><span class="step-num">1</span><span class="step-line" /></div>
              <div class="step-body">
                <div class="step-title">Insert a USB stick</div>
                <div class="step-text">4 GB or larger. <b>Everything on it will be erased.</b></div>
              </div>
            </li>
            <li class="step">
              <div class="step-gutter"><span class="step-num">2</span><span class="step-line" /></div>
              <div class="step-body">
                <div class="step-title">Flash the bootloader onto it</div>
                <div class="step-text">
                  Open <b>Balena Etcher</b> (free, all platforms), pick
                  <code class="code">polyptic-boot.img</code> and your USB drive, then Flash.
                </div>
                <div class="step-aside">
                  On Windows <b>Rufus</b> works too — select the image and your drive, leave the defaults, and Start.
                </div>
              </div>
            </li>
            <li class="step">
              <div class="step-gutter"><span class="step-num">3</span></div>
              <div class="step-body">
                <div class="step-title">Boot the screen from USB</div>
                <div class="step-text">
                  Leave Secure Boot <b>ON</b>. It streams the latest image and appears in <b>Machines</b> to approve.
                </div>
              </div>
            </li>
          </ol>

          <div class="modal-foot">
            <button type="button" class="btn btn-primary" @click="usbModal = false">Done</button>
          </div>
        </div>
      </div>
    </Transition>

    <Transition name="toast">
      <div v-if="toast" class="toast">{{ toast }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scroll-behavior: smooth;
}
.inner {
  max-width: 720px;
  margin: 0 auto;
  padding: 36px 40px 90px;
}
.min-w-0 {
  min-width: 0;
}
.spacer {
  flex: 1;
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
.card:last-of-type {
  margin-bottom: 0;
}
/* The two dense cards the design pads a touch taller than the rest. */
.card.pad-lg {
  padding: 22px;
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
.pill {
  border: none;
  background: transparent;
  font-family: inherit;
}

/* ── ⋯ build menu ──────────────────────────────────────────────────────────── */
.menu-wrap {
  position: relative;
  flex: 0 0 auto;
}
.menu-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 9px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  cursor: pointer;
}
.menu-btn:hover,
.menu-btn.open {
  background: var(--muted-bg);
  color: var(--fg);
}
.menu-scrim {
  position: fixed;
  inset: 0;
  z-index: 30;
}
.menu {
  position: absolute;
  top: 38px;
  right: 0;
  z-index: 31;
  min-width: 246px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 11px;
  box-shadow: var(--shadow-lg);
  padding: 6px;
  animation: fadein 0.14s ease;
}
.menu-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  border-radius: 8px;
  background: none;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}
.menu-item:hover:not(:disabled) {
  background: var(--muted-bg);
}
.menu-item.danger:hover:not(:disabled) {
  background: var(--warn-soft);
}
.menu-item:disabled {
  opacity: 0.45;
  cursor: default;
}
.menu-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--muted);
}
.menu-icon.warn {
  color: var(--warn);
}
.menu-text {
  flex: 1;
  min-width: 0;
}
.menu-title {
  display: block;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--fg);
}
.menu-sub {
  display: block;
  font-size: 11px;
  color: var(--muted2);
  margin-top: 1px;
}
.menu-sep {
  height: 1px;
  background: var(--line);
  margin: 5px 6px;
}

/* ── Network boot loader sub-card ──────────────────────────────────────────── */
.sub-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  background: var(--surface);
  padding: 18px 20px;
  margin-bottom: 16px;
}
.sub-head {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  margin-bottom: 16px;
}
.icon-tile {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
  border-radius: 10px;
  background: var(--muted-bg);
}
.icon-tile.lg {
  width: 40px;
  height: 40px;
  border-radius: 11px;
}
.sub-text {
  flex: 1;
}
.sub-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
}
.sub-sub {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.45;
}
.dl-row {
  display: flex;
  align-items: stretch;
  gap: 10px;
}
.latest {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  padding: 11px 14px;
  background: var(--muted-bg);
  border-radius: 10px;
}
.latest-label {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted2);
}
.latest-id {
  flex: 1;
  min-width: 0;
  font-family: "Geist Mono", ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 12px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.latest-id.none {
  color: var(--muted2);
}
.dl-btn {
  flex: 0 0 auto;
  gap: 8px;
  padding: 10px 16px;
  font-size: 12.5px;
  text-decoration: none;
  white-space: nowrap;
}
.dl-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.build-status {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 11.5px;
  color: var(--muted2);
}
.build-status.busy {
  color: var(--accent-fg);
}
.build-status.bad {
  color: var(--bad);
}
.spinner {
  width: 11px;
  height: 11px;
  border: 2px solid currentcolor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

/* ── Recent builds ─────────────────────────────────────────────────────────── */
.builds {
  border: 1px solid var(--line);
  border-radius: 11px;
  /* NOT overflow:hidden — a row's overflow menu has to escape this box. The rows round their own
     outer corners instead, so the active row's tint still stops at the border radius. */
}
.build-row {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 14px;
}
.build-row + .build-row {
  border-top: 1px solid var(--line);
}
.build-row:first-child {
  border-radius: 10px 10px 0 0;
}
.build-row:last-child {
  border-radius: 0 0 10px 10px;
}
.build-row:only-child {
  border-radius: 10px;
}
.build-row.active {
  background: var(--accent-soft);
}
.arch {
  flex: 0 0 auto;
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 10.5px;
  font-weight: 600;
  background: var(--muted-bg);
  border: 1px solid var(--line);
  padding: 1px 7px;
  border-radius: 5px;
  color: var(--muted);
}
.build-id {
  flex: 1;
  min-width: 0;
  font-family: "Geist Mono", ui-monospace, monospace;
  font-size: 12px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.build-when {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--muted2);
}
.tag {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 20px;
}
.tag-ok {
  color: var(--ok);
  background: var(--ok-soft);
}
.tag-muted {
  color: var(--muted);
  background: var(--muted-bg);
}
.row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.row-btn:hover:not(:disabled) {
  background: var(--muted-bg);
  color: var(--fg);
}
.row-btn.open {
  background: var(--muted-bg);
  color: var(--fg);
}
.build-row.active .row-btn:hover {
  /* --muted-bg over the row's accent tint is muddy; the card behind it reads cleaner. */
  background: var(--card);
}
.row-btn.empty {
  cursor: default;
}
.row-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
/* A row's menu is narrower than the card's, and hangs just under its trigger. */
.menu.menu-row {
  top: 32px;
  min-width: 208px;
}
.menu-row .menu-item {
  align-items: center;
  text-decoration: none;
}
.menu-row .menu-title {
  font-size: 12.5px;
}

/* ── Disclosure: boot without a USB stick ──────────────────────────────────── */
.disclosure {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  margin-top: 20px;
  padding: 16px 0 0;
  border: none;
  border-top: 1px solid var(--line);
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}
.disclosure:hover {
  color: var(--fg2);
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
  gap: 14px;
  margin-top: 14px;
  animation: fadein 0.2s ease;
}
.adv-label {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.adv-note {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  margin: 6px 0 0;
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
  margin-bottom: 10px;
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
.mono-field.muted {
  font-size: 12px;
  color: var(--muted);
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
.link-btn {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent-fg);
  cursor: pointer;
  text-decoration: underline;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
  font-size: 10.5px;
  font-weight: 600;
  padding: 4px 9px;
  border-radius: 20px;
}
.chip-accent {
  color: var(--accent-fg);
  background: var(--accent-soft);
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
  font-family: "Geist Mono", ui-monospace, monospace;
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

/* ── Update schedule ───────────────────────────────────────────────────────── */
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
.rollout {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 16px;
  padding: 12px 16px;
  border-radius: 11px;
  background: var(--muted-bg);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
}
.rollout.urgent {
  background: var(--warn-soft);
}
.rollout b {
  color: var(--fg2);
  font-weight: 600;
}
.rollout-icon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--muted2);
}
.rollout-icon.warn {
  color: var(--warn);
  font-size: 13px;
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
.callout-icon {
  flex: 0 0 auto;
  font-size: 13px;
}
.callout-bad {
  color: var(--bad);
  background: var(--bad-soft);
}
.callout-ok {
  color: var(--ok);
  background: var(--ok-soft);
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
.pw-grid .field-label {
  color: var(--fg2);
  margin-bottom: 6px;
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

/* ── USB modal ─────────────────────────────────────────────────────────────── */
.scrim {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(9, 9, 11, 0.5);
  backdrop-filter: blur(3px);
}
.modal {
  width: 100%;
  max-width: 540px;
  max-height: calc(100vh - 48px);
  overflow-y: auto;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
}
.modal-head {
  display: flex;
  align-items: flex-start;
  gap: 13px;
  padding: 22px 24px 0;
}
.modal-titles {
  flex: 1;
}
.modal-title {
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.modal-sub {
  font-size: 12.5px;
  color: var(--muted);
  margin-top: 2px;
  line-height: 1.5;
}
.icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: none;
  color: var(--muted);
  cursor: pointer;
}
.icon-btn:hover {
  background: var(--muted-bg);
  color: var(--fg);
}
.modal-steps {
  list-style: none;
  margin: 0;
  padding: 20px 24px 4px;
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
  flex: 1;
  min-width: 0;
  padding-bottom: 18px;
}
.step:last-child .step-body {
  padding-bottom: 0;
}
.step-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 2px;
}
.step-text {
  font-size: 12.5px;
  color: var(--muted);
  line-height: 1.5;
}
.step-text b,
.step-aside b {
  color: var(--fg2);
  font-weight: 600;
}
.step-aside {
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--muted-bg);
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
  padding: 16px 24px 22px;
  border-top: 1px solid var(--line);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.16s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
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
  z-index: 70;
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
