<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useConsoleStore } from "../stores/console";
import { ApiError, serverHealth } from "../api";
import { fetchAuthProviders, oidcSignInUrl } from "../auth";
import Logo from "../components/Logo.vue";

// Real local-account sign-in (Phase 3f — D29). Credentials POST to /auth/login over the credentialed
// transport; on success the server sets the httpOnly session cookie and we route on.
const store = useConsoleStore();
const router = useRouter();
const route = useRoute();

// Prefill the dev-default seed account so the local demo signs in with one click. In a real
// deployment the operator types their own credentials (and the seeded account's password is rotated
// — the boot banner nags about exactly that). See securityNotes.
const email = ref("operator@polyptic.local");
const password = ref("polyptic-admin"); // matches the seeded dev admin (auth-local DEV_ADMIN_PASSWORD)
const errorMessage = ref<string | null>(null);
const loading = ref(false);

const themeIcon = computed(() => (store.theme === "light" ? "☾ Dark" : "☼ Light"));

// The REAL deployed version (was a hardcoded "v3.0" leftover from the Console-v2 design adoption).
// /healthz is ungated so this works pre-auth; dev builds ("0.0.0") show no number at all.
const version = ref<string | null>(null);

// POL-191 — single sign-on, when the deployment brokers one. The label comes from the server so a
// site can put its own name on the button ("AMRC SSO") rather than a generic one.
const ssoLabel = ref<string | null>(null);
// Where to land after signing in. The same value drives both paths — the local form routes to it, and
// the brokered round-trip carries it to the IdP and back (the server refuses anything off-origin).
const redirectTo = computed(() =>
  typeof route.query.redirect === "string" ? route.query.redirect : "/wall",
);
const ssoUrl = computed(() => oidcSignInUrl(redirectTo.value));

onMounted(() => {
  void serverHealth()
    .then((h) => {
      const v = h.version?.replace(/^v/, "");
      if (v && v !== "0.0.0") version.value = v;
    })
    .catch(() => {});

  // A deployment with no IdP configured simply gets no button — this is not an error state, so a
  // failure here is swallowed and the local form stands alone.
  void fetchAuthProviders()
    .then((providers) => {
      if (providers.oidc) ssoLabel.value = providers.oidc.label;
    })
    .catch(() => {});

  // A brokered sign-in that failed comes back as a redirect carrying its reason — the server has
  // already decided what is safe to say, so it is shown verbatim.
  if (typeof route.query.error === "string" && route.query.error.length > 0) {
    errorMessage.value = route.query.error;
  }
});

/** Begin the brokered round-trip. A full page navigation, not a fetch: only the address bar can
 *  follow a redirect chain to the identity provider and back. */
function onSsoSignIn(): void {
  window.location.assign(ssoUrl.value);
}

async function onSignIn(): Promise<void> {
  if (loading.value) return;
  if (!email.value.trim() || !password.value.trim()) {
    errorMessage.value = "Enter an email and password to continue.";
    return;
  }
  loading.value = true;
  errorMessage.value = null;
  try {
    await store.login({ email: email.value.trim(), password: password.value });
    await router.replace(redirectTo.value);
  } catch (err) {
    if (err instanceof ApiError && err.status === 429) {
      // Lockout after too many failed attempts (server-side rate limit). Surface the cooldown.
      errorMessage.value =
        "Too many attempts. This account is temporarily locked. Wait a moment and try again.";
    } else if (err instanceof ApiError && err.status === 401) {
      errorMessage.value = "Incorrect email or password.";
    } else {
      // Network / server error — keep it generic (never leak whether the email exists).
      errorMessage.value = "Could not sign in. Check the control plane is reachable and try again.";
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="signin">
    <div class="card sheet">
      <div class="brand">
        <Logo :size="40" :rounded="11" />
        <span class="brand-name">Polyptic</span>
      </div>

      <div class="heading">Sign in to the console</div>
      <div class="sub">Operator access to your display fleet.</div>

      <!-- POL-191 — the brokered path goes FIRST: where an organisation has an IdP, it is the way in
           for everyone except the break-glass local admin underneath. -->
      <template v-if="ssoLabel">
        <button class="btn sso" :disabled="loading" @click="onSsoSignIn">
          Sign in with {{ ssoLabel }}
        </button>
        <div class="divider"><span>or sign in with a local account</span></div>
      </template>

      <label class="field-label">Email</label>
      <input
        v-model="email"
        class="input field"
        type="email"
        autocomplete="username"
        :disabled="loading"
        @keyup.enter="onSignIn"
      />

      <label class="field-label">Password</label>
      <input
        v-model="password"
        class="input field"
        type="password"
        autocomplete="current-password"
        :disabled="loading"
        @keyup.enter="onSignIn"
      />

      <div v-if="errorMessage" class="error">⚠ {{ errorMessage }}</div>

      <button class="btn btn-primary submit" :disabled="loading" @click="onSignIn">
        <span v-if="loading" class="spinner"></span>
        {{ loading ? "Signing in…" : "Sign in" }}
      </button>

      <div class="foot">
        <span class="version">Self-hosted{{ version ? ` · v${version}` : "" }}</span>
        <span class="theme" @click="store.toggleTheme()">{{ themeIcon }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.signin {
  height: 100vh;
  min-height: 640px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}
.sheet {
  width: 380px;
  padding: 30px 28px;
  border-radius: 16px;
  box-shadow: var(--shadow-lg);
  animation: fadein 0.3s ease;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
}
.brand-mark {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary-fg);
  font-size: 16px;
  font-weight: 700;
}
.brand-name {
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
}
.heading {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 4px;
}
.sub {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 22px;
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
.sso {
  width: 100%;
  padding: 11px;
  font-size: 13.5px;
  font-weight: 600;
  margin-bottom: 4px;
}
.divider {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 16px 0 18px;
  font-size: 11.5px;
  color: var(--muted2);
}
.divider::before,
.divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
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
.submit {
  width: 100%;
  padding: 11px;
  font-size: 13.5px;
  margin-bottom: 8px;
}
.submit:disabled {
  cursor: default;
}
.spinner {
  width: 13px;
  height: 13px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
}
.version {
  font-size: 11.5px;
  color: var(--muted2);
}
.theme {
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
}
</style>
