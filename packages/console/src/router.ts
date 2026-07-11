import { createRouter, createWebHistory } from "vue-router";
import type { RouteLocationNormalized, RouteRecordRaw } from "vue-router";

import AppShell from "./components/AppShell.vue";
import { setUnauthorizedHandler } from "./api";
import { useConsoleStore } from "./stores/console";

// The Wall view is owned by console-wall; it is lazy-imported so the shell + stub routes build and
// run independently of it.
const routes: RouteRecordRaw[] = [
  {
    path: "/signin",
    name: "signin",
    component: () => import("./views/SignIn.vue"),
    meta: { public: true },
  },
  {
    path: "/",
    component: AppShell,
    children: [
      { path: "", redirect: { name: "wall" } },
      { path: "wall", name: "wall", component: () => import("./views/Wall.vue") },
      { path: "machines", name: "machines", component: () => import("./views/Machines.vue") },
      { path: "content", name: "content", component: () => import("./views/Content.vue") },
      { path: "playlists", name: "playlists", component: () => import("./views/Playlists.vue") },
      // POL-42 — the page Studio: compose framing elements into a `page` content source. No :id =
      // a new, unsaved page; with :id it edits that library source.
      { path: "studio/:id?", name: "studio", component: () => import("./views/Studio.vue") },
      { path: "scenes", name: "scenes", component: () => import("./views/Scenes.vue") },
      { path: "settings", name: "settings", component: () => import("./views/Settings.vue") },
    ],
  },
  { path: "/:pathMatch(.*)*", redirect: { name: "wall" } },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

/**
 * Real auth guard (Phase 3f — D29). Before any protected navigation we resolve the operator session
 * via GET /auth/me (cached in the store after the first probe, so navigations stay instant):
 *   - unauthenticated → bounce to /signin, preserving the intended path as ?redirect=…
 *   - already signed in and hitting /signin → send straight to the wall
 * The session itself is the server's httpOnly cookie; the store only mirrors the public AuthUser.
 */
router.beforeEach(async (to: RouteLocationNormalized) => {
  const store = useConsoleStore();
  const user = await store.ensureSession();

  if (to.name === "signin") {
    // A signed-in operator never needs the sign-in screen — honour an explicit redirect if present.
    if (user) {
      const redirect = typeof to.query.redirect === "string" ? to.query.redirect : { name: "wall" };
      return redirect;
    }
    return true;
  }

  if (to.meta.public) return true;

  if (!user) {
    return {
      name: "signin",
      query: to.fullPath !== "/" ? { redirect: to.fullPath } : undefined,
    };
  }
  return true;
});

// When any guarded API call comes back 401 mid-session (the server-side session expired or was
// revoked), drop the cached session and bounce to /signin — keeping the current path as ?redirect.
setUnauthorizedHandler(() => {
  const store = useConsoleStore();
  store.markSignedOut();
  const current = router.currentRoute.value;
  if (current.name !== "signin") {
    void router.replace({
      name: "signin",
      query: current.fullPath !== "/" ? { redirect: current.fullPath } : undefined,
    });
  }
});
