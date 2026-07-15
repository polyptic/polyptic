<!--
  Studio.vue — the page STUDIO (POL-42): compose framing elements (embeds, tickers, feeds, clocks,
  weather, …) into a `page` content source on a drag-and-drop canvas.

  Layout mirrors the design mockup (Polyptych Console v2): header (back · name · aspect · undo/redo ·
  save), a left rail with the element LIBRARY + LAYERS, the CANVAS in the middle, and the INSPECTOR
  on the right (page props when nothing is selected; the selected element's props otherwise).

  THE CANVAS IS THE RENDERER: every element is drawn by @polyptic/elements' PageElementView — the
  same component the player mounts on the wall — inside studio-owned wrappers that add selection,
  drag, resize handles and alignment guides. Positions are % of the page; the canvas declares
  container-type:size, so the preview scales exactly like a panel does.

  Editor surface (v1, per the pitch — deliberately nothing more): drag from the library, drag to
  move, handles to resize, 0.5% grid snap, smart alignment guides (page edges/centre + other
  elements' edges/centres), session-scoped undo/redo (bounded stack), z-order via the layers list,
  delete. No multi-select, no copy/paste, no align toolbar.

  Save upserts a ContentSource kind:"page" — the server re-pushes the slice to every screen showing
  it, so a live wall updates in <150 ms with no reload (D5).
-->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type {
  ContentSource,
  PageAspect,
  PageData,
  PageDefinition,
  PageElement,
  PageElementKind,
} from "@polyptic/protocol";
import { qrContrastIssue } from "@polyptic/protocol";
import { ELEMENT_LIBRARY, PageElementView, defaultElement, libraryEntry } from "@polyptic/elements";
import { useConsoleStore } from "../stores/console";
import { kindLabel } from "../content";
import { canZoomIn, canZoomOut, zoomIn, zoomLabel, zoomOut } from "../zoom";

const store = useConsoleStore();
const route = useRoute();
const router = useRouter();

// ── document state ────────────────────────────────────────────────────────────
const pageId = ref<string | null>(null); // null until the first save of a NEW page
const name = ref("Untitled page");
const aspect = ref<PageAspect>("16:9");
const bg = ref("#0b0b0e");
const elements = ref<PageElement[]>([]);
const selectedId = ref<string | null>(null);
const dirty = ref(false);
const saving = ref(false);
const loaded = ref(false);

// Session-scoped, bounded undo/redo over the whole elements array (the mockup's model: geometry,
// props, add/delete and z-order all snapshot the same thing).
const undoStack = ref<PageElement[][]>([]);
const redoStack = ref<PageElement[][]>([]);
const UNDO_CAP = 50;

function snapshot(): PageElement[] {
  return JSON.parse(JSON.stringify(elements.value)) as PageElement[];
}

function pushUndo(state?: PageElement[]) {
  undoStack.value = [...undoStack.value.slice(-(UNDO_CAP - 1)), state ?? snapshot()];
  redoStack.value = [];
}

function undo() {
  const prev = undoStack.value[undoStack.value.length - 1];
  if (!prev) return;
  undoStack.value = undoStack.value.slice(0, -1);
  redoStack.value = [...redoStack.value, snapshot()];
  elements.value = prev;
  if (selectedId.value && !prev.some((el) => el.id === selectedId.value)) selectedId.value = null;
  dirty.value = true;
}

function redo() {
  const next = redoStack.value[redoStack.value.length - 1];
  if (!next) return;
  redoStack.value = redoStack.value.slice(0, -1);
  undoStack.value = [...undoStack.value.slice(-(UNDO_CAP - 1)), snapshot()];
  elements.value = next;
  if (selectedId.value && !next.some((el) => el.id === selectedId.value)) selectedId.value = null;
  dirty.value = true;
}

// ── load (route param → library source) ──────────────────────────────────────
function loadFrom(source: ContentSource) {
  pageId.value = source.id;
  name.value = source.name;
  const def = source.definition;
  aspect.value = def?.aspect ?? "16:9";
  bg.value = def?.bg ?? "#0b0b0e";
  elements.value = def ? (JSON.parse(JSON.stringify(def.elements)) as PageElement[]) : [];
  selectedId.value = null;
  undoStack.value = [];
  redoStack.value = [];
  dirty.value = false;
  loaded.value = true;
}

function tryLoad() {
  const id = typeof route.params.id === "string" ? route.params.id : "";
  if (!id) {
    loaded.value = true; // a fresh, unsaved page
    return;
  }
  if (pageId.value === id && loaded.value) return;
  const source = store.sources.find((s) => s.id === id);
  if (source) {
    loadFrom(source);
  } else if (store.stateReceived) {
    // The registry has actually answered and the id doesn't exist — nothing to edit here. (Gating on
    // `connected` alone raced the first snapshot and bounced valid deep links back to Content.)
    void router.replace({ name: "content" });
  }
  // No snapshot yet: the watcher below retries when it lands.
}

watch(
  () => [route.params.id, store.stateReceived, store.sources.length] as const,
  () => {
    if (!loaded.value) tryLoad();
  },
);

// ── save ──────────────────────────────────────────────────────────────────────
const currentDefinition = computed<PageDefinition>(() => ({
  aspect: aspect.value,
  bg: bg.value,
  elements: elements.value,
}));

async function save() {
  if (saving.value) return;
  saving.value = true;
  const definition = JSON.parse(JSON.stringify(currentDefinition.value)) as PageDefinition;
  const trimmed = name.value.trim() || "Untitled page";
  try {
    if (pageId.value) {
      const ok = await store.updateSource(pageId.value, { name: trimmed, definition });
      if (ok) dirty.value = false;
    } else {
      const source = await store.createSource({ name: trimmed, kind: "page", definition });
      if (source) {
        pageId.value = source.id;
        dirty.value = false;
        // Re-home the URL onto the saved id so a reload / share edits THIS page.
        void router.replace({ name: "studio", params: { id: source.id } });
      }
    }
  } finally {
    saving.value = false;
  }
}

function goBack() {
  if (dirty.value && !window.confirm("Leave the Studio? Unsaved changes will be discarded.")) return;
  void router.push({ name: "content" });
}

// ── selection + z-order ───────────────────────────────────────────────────────
const selected = computed(() => elements.value.find((el) => el.id === selectedId.value) ?? null);
const selectedEntry = computed(() => (selected.value ? libraryEntry(selected.value.kind) : null));

function select(id: string | null) {
  selectedId.value = id;
}

function zMove(id: string, dir: 1 | -1) {
  const i = elements.value.findIndex((el) => el.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= elements.value.length) return;
  pushUndo();
  const next = [...elements.value];
  const tmp = next[i]!;
  next[i] = next[j]!;
  next[j] = tmp;
  elements.value = next;
  dirty.value = true;
}

function deleteSelected() {
  if (!selectedId.value) return;
  pushUndo();
  elements.value = elements.value.filter((el) => el.id !== selectedId.value);
  selectedId.value = null;
  dirty.value = true;
}

// Layers list: front-most first (reverse of draw order), per the design.
const layers = computed(() =>
  elements.value
    .map((el, i) => ({ el, i }))
    .reverse()
    .map(({ el }) => ({
      el,
      entry: libraryEntry(el.kind),
      label: layerLabel(el),
    })),
);

function layerLabel(el: PageElement): string {
  if (el.kind === "text" && el.props.text) return el.props.text.slice(0, 22);
  if ((el.kind === "embed" || el.kind === "image") && el.props.sourceId) {
    const source = store.sources.find((s) => s.id === el.props.sourceId);
    if (source) return source.name;
  }
  return libraryEntry(el.kind).name;
}

// ── studio-side element data (labels + resolved images for the preview) ──────
const studioData = computed<PageData>(() => {
  const images: Record<string, { src: string }> = {};
  for (const el of elements.value) {
    if (el.kind !== "image" || !el.props.sourceId) continue;
    const source = store.sources.find((s) => s.id === el.props.sourceId);
    if (source?.kind === "image" && source.url) images[el.id] = { src: source.url };
  }
  return Object.keys(images).length > 0 ? { images } : {};
});

/** The placeholder label PageElementView shows for an embed/image element in the studio. */
function elementLabel(el: PageElement): string | undefined {
  if (el.kind === "embed") {
    if (el.props.sourceId) {
      const source = store.sources.find((s) => s.id === el.props.sourceId);
      return source ? source.name : "Source unavailable";
    }
    if (el.props.url) return el.props.url.replace(/^https?:\/\//, "");
    return "Pick a source";
  }
  if (el.kind === "image" && el.props.sourceId) {
    const source = store.sources.find((s) => s.id === el.props.sourceId);
    return source ? source.name : "Image unavailable";
  }
  return undefined;
}

// ── canvas drag / resize / snap machinery (ported from the design mockup) ────
const canvasEl = ref<HTMLElement | null>(null);
const guideV = ref<number | null>(null);
const guideH = ref<number | null>(null);
const dragActive = ref(false);
const ghost = ref<{ x: number; y: number; label: string } | null>(null);

type DragState =
  | { type: "lib"; kind: PageElementKind }
  | { type: "move"; id: string; offx: number; offy: number; pre: PageElement[]; pushed: boolean }
  | {
      type: "resize";
      id: string;
      handle: string;
      startPx: number;
      startPy: number;
      orig: { x: number; y: number; w: number; h: number };
      pre: PageElement[];
      pushed: boolean;
    };

let drag: DragState | null = null;
let elementCounter = 0;

/** Snap threshold, in % of the page. */
const SNAP = 1.1;

function canvasPercent(e: MouseEvent): { px: number; py: number } | null {
  const el = canvasEl.value;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  return {
    px: ((e.clientX - rect.left) / rect.width) * 100,
    py: ((e.clientY - rect.top) / rect.height) * 100,
  };
}

/** Alignment candidates: page edges + centre, plus every OTHER element's edges + centres. */
function snapCandidates(exceptId: string): { cx: number[]; cy: number[] } {
  const cx = [0, 50, 100];
  const cy = [0, 50, 100];
  for (const el of elements.value) {
    if (el.id === exceptId) continue;
    cx.push(el.x, el.x + el.w / 2, el.x + el.w);
    cy.push(el.y, el.y + el.h / 2, el.y + el.h);
  }
  return { cx, cy };
}

function libDown(kind: PageElementKind, e: MouseEvent) {
  e.preventDefault();
  drag = { type: "lib", kind };
  ghost.value = { x: e.clientX, y: e.clientY, label: `${libraryEntry(kind).name} — drop on the page` };
}

function elementDown(id: string, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const pos = canvasPercent(e);
  const el = elements.value.find((x) => x.id === id);
  if (!pos || !el) return;
  select(id);
  drag = { type: "move", id, offx: pos.px - el.x, offy: pos.py - el.y, pre: snapshot(), pushed: false };
}

function handleDown(id: string, handle: string, e: MouseEvent) {
  e.preventDefault();
  e.stopPropagation();
  const pos = canvasPercent(e);
  const el = elements.value.find((x) => x.id === id);
  if (!pos || !el) return;
  drag = {
    type: "resize",
    id,
    handle,
    startPx: pos.px,
    startPy: pos.py,
    orig: { x: el.x, y: el.y, w: el.w, h: el.h },
    pre: snapshot(),
    pushed: false,
  };
}

function patchElement(id: string, patch: Partial<Pick<PageElement, "x" | "y" | "w" | "h">>) {
  elements.value = elements.value.map((el) => (el.id === id ? ({ ...el, ...patch } as PageElement) : el));
}

function onWindowMove(e: MouseEvent) {
  const d = drag;
  if (!d) return;
  if (d.type === "lib") {
    ghost.value = { x: e.clientX, y: e.clientY, label: ghost.value?.label ?? "" };
    return;
  }
  const pos = canvasPercent(e);
  if (!pos) return;
  if (!d.pushed) {
    d.pushed = true;
    dragActive.value = true;
    pushUndo(d.pre);
    dirty.value = true;
  }
  const { cx, cy } = snapCandidates(d.id);

  if (d.type === "move") {
    const el = elements.value.find((x) => x.id === d.id);
    if (!el) return;
    let nx = pos.px - d.offx;
    let ny = pos.py - d.offy;
    let gv: number | null = null;
    let gh: number | null = null;
    for (const c of cx) {
      if (Math.abs(nx - c) < SNAP) { nx = c; gv = c; break; }
      if (Math.abs(nx + el.w / 2 - c) < SNAP) { nx = c - el.w / 2; gv = c; break; }
      if (Math.abs(nx + el.w - c) < SNAP) { nx = c - el.w; gv = c; break; }
    }
    for (const c of cy) {
      if (Math.abs(ny - c) < SNAP) { ny = c; gh = c; break; }
      if (Math.abs(ny + el.h / 2 - c) < SNAP) { ny = c - el.h / 2; gh = c; break; }
      if (Math.abs(ny + el.h - c) < SNAP) { ny = c - el.h; gh = c; break; }
    }
    if (gv === null) nx = Math.round(nx * 2) / 2; // 0.5% grid when not snapped to a guide
    if (gh === null) ny = Math.round(ny * 2) / 2;
    nx = Math.max(0, Math.min(100 - el.w, nx));
    ny = Math.max(0, Math.min(100 - el.h, ny));
    guideV.value = gv;
    guideH.value = gh;
    patchElement(d.id, { x: +nx.toFixed(2), y: +ny.toFixed(2) });
    return;
  }

  // resize
  const { orig, handle } = d;
  let nx = orig.x;
  let ny = orig.y;
  let nw = orig.w;
  let nh = orig.h;
  const dx = pos.px - d.startPx;
  const dy = pos.py - d.startPy;
  let gv: number | null = null;
  let gh: number | null = null;
  if (handle.includes("e")) {
    let right = orig.x + orig.w + dx;
    for (const c of cx) if (Math.abs(right - c) < SNAP) { right = c; gv = c; break; }
    if (gv === null) right = Math.round(right * 2) / 2;
    nw = right - orig.x;
  }
  if (handle.includes("w")) {
    let left = orig.x + dx;
    for (const c of cx) if (Math.abs(left - c) < SNAP) { left = c; gv = c; break; }
    if (gv === null) left = Math.round(left * 2) / 2;
    nx = left;
    nw = orig.x + orig.w - left;
  }
  if (handle.includes("s")) {
    let bottom = orig.y + orig.h + dy;
    for (const c of cy) if (Math.abs(bottom - c) < SNAP) { bottom = c; gh = c; break; }
    if (gh === null) bottom = Math.round(bottom * 2) / 2;
    nh = bottom - orig.y;
  }
  if (handle.includes("n")) {
    let top = orig.y + dy;
    for (const c of cy) if (Math.abs(top - c) < SNAP) { top = c; gh = c; break; }
    if (gh === null) top = Math.round(top * 2) / 2;
    ny = top;
    nh = orig.y + orig.h - top;
  }
  if (nw < 3) {
    if (handle.includes("w")) nx = orig.x + orig.w - 3;
    nw = 3;
  }
  if (nh < 3) {
    if (handle.includes("n")) ny = orig.y + orig.h - 3;
    nh = 3;
  }
  nx = Math.max(0, nx);
  ny = Math.max(0, ny);
  nw = Math.min(100 - nx, nw);
  nh = Math.min(100 - ny, nh);
  guideV.value = gv;
  guideH.value = gh;
  patchElement(d.id, { x: +nx.toFixed(2), y: +ny.toFixed(2), w: +nw.toFixed(2), h: +nh.toFixed(2) });
}

function onWindowUp(e: MouseEvent) {
  const d = drag;
  drag = null;
  dragActive.value = false;
  if (!d) return;
  if (d.type === "lib") {
    ghost.value = null;
    const el = canvasEl.value;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      return; // dropped outside the page — no-op
    }
    const pos = canvasPercent(e);
    if (!pos) return;
    elementCounter += 1;
    const fresh = defaultElement(d.kind, `pe-${Date.now()}-${elementCounter}`);
    const x = Math.max(0, Math.min(100 - fresh.w, Math.round((pos.px - fresh.w / 2) * 2) / 2));
    const y = Math.max(0, Math.min(100 - fresh.h, Math.round((pos.py - fresh.h / 2) * 2) / 2));
    pushUndo();
    elements.value = [...elements.value, { ...fresh, x, y } as PageElement];
    selectedId.value = fresh.id;
    dirty.value = true;
    return;
  }
  guideV.value = null;
  guideH.value = null;
}

// ── inspector: element props ──────────────────────────────────────────────────
// Prop edits made in one quick burst (typing, sliding) share a single undo snapshot; a pause >900ms
// starts a new one — the mockup's throttle, so undo steps match the operator's mental edits.
let lastPropPushMs = 0;

function setProp(key: string, value: unknown) {
  const el = selected.value;
  if (!el) return;
  const now = Date.now();
  if (now - lastPropPushMs > 900) pushUndo();
  lastPropPushMs = now;
  elements.value = elements.value.map((x) =>
    x.id === el.id ? ({ ...x, props: { ...x.props, [key]: value } } as PageElement) : x,
  );
  dirty.value = true;
}

/** One inspector control. Rendered generically in the template — the per-kind lists below mirror
 *  the design mockup's inspector exactly. */
interface PropSpec {
  key: string;
  label?: string;
  control: "text" | "select" | "range" | "color" | "toggle" | "note" | "zoom" | "warn";
  value?: unknown;
  valueLabel?: string;
  options?: { v: string; t: string }[];
  min?: number;
  max?: number;
  note?: string;
  swatches?: string[];
  numeric?: boolean;
}

const ELEMENT_SWATCHES = ["#0b0b0e", "#18181b", "#fafafa", "#2563eb", "#16a34a", "#d97706"];

const propSpecs = computed<PropSpec[]>(() => {
  const el = selected.value;
  if (!el) return [];
  const p = el.props as Record<string, unknown>;
  const text = (label: string, key: string): PropSpec => ({ key, label, control: "text", value: p[key] ?? "" });
  const select = (label: string, key: string, options: { v: string; t: string }[]): PropSpec => ({
    key,
    label,
    control: "select",
    value: p[key],
    options,
  });
  const range = (label: string, key: string, min: number, max: number, unit: string): PropSpec => ({
    key,
    label,
    control: "range",
    value: p[key],
    min,
    max,
    valueLabel: `${String(p[key])}${unit}`,
    numeric: true,
  });
  const color = (label: string, key: string): PropSpec => ({
    key,
    label,
    control: "color",
    value: p[key],
    swatches: ELEMENT_SWATCHES,
  });
  const toggle = (label: string, key: string): PropSpec => ({
    key,
    label,
    control: "toggle",
    value: !!p[key],
    valueLabel: p[key] ? "On" : "Off",
  });
  const note = (n: string): PropSpec => ({ key: "note", control: "note", note: n });
  // POL-133 — the browser-style −/value/+ page-zoom control (the same ladder as the screens
  // Inspector, so it reads as the same feature). Authoring-time: part of the composition.
  const zoom = (label: string, key: string): PropSpec => ({
    key,
    label,
    control: "zoom",
    value: typeof p[key] === "number" ? p[key] : 1,
    numeric: true,
  });
  const warn = (n: string): PropSpec => ({ key: "warn", control: "warn", note: n });

  switch (el.kind) {
    case "embed":
      return [
        select("Content source", "sourceId", embeddableSourceOptions.value),
        zoom("Page zoom", "zoom"),
        note(
          "The player fetches this source with stamped credentials — the page never carries secrets. Sources that refuse framing can't go on a page.",
        ),
      ];
    case "feed":
      return [
        text("Feed URL", "url"),
        range("Items shown", "items", 2, 8, ""),
        range("Font size", "fontScale", 50, 200, "%"),
        note("Polled server-side every ~5 min; last-good items are served if the feed is down."),
      ];
    case "ticker":
      return [
        text("Text", "text"),
        range("Speed", "speed", 20, 120, " px/s"),
        color("Text", "fg"),
        color("Background", "bg"),
      ];
    case "image":
      return [
        select("Media", "sourceId", imageSourceOptions.value),
        select("Fit", "fit", [
          { v: "contain", t: "Contain" },
          { v: "cover", t: "Cover" },
        ]),
      ];
    case "text":
      return [
        text("Text", "text"),
        range("Size", "size", 14, 120, " px"),
        select("Align", "align", [
          { v: "left", t: "Left" },
          { v: "center", t: "Centre" },
          { v: "right", t: "Right" },
        ]),
        color("Colour", "color"),
      ];
    case "clock":
      return [
        select("Format", "format", [
          { v: "24h", t: "24-hour" },
          { v: "12h", t: "12-hour" },
        ]),
        toggle("Show seconds", "seconds"),
        color("Colour", "color"),
        note("Updates a text node once a minute — no animation, safe on every box."),
      ];
    case "shape":
      return [color("Fill", "fill"), range("Corner radius", "radius", 0, 48, " px"), range("Opacity", "opacity", 10, 100, "%")];
    case "weather":
      return [
        text("Location", "location"),
        select("Units", "units", [
          { v: "C", t: "Celsius" },
          { v: "F", t: "Fahrenheit" },
        ]),
        note("Fetched server-side from Open-Meteo (keyless), cached ~15 min."),
      ];
    case "qr": {
      // POL-133 — colour pair scannability, judged as the operator edits: a hard fail here is the
      // same check the contract refuses at save time, so the warning is never a surprise 400.
      const issue = qrContrastIssue(String(p.fg ?? "#09090b"), String(p.bg ?? "#ffffff"));
      return [
        text("Link", "url"),
        color("Modules", "fg"),
        color("Background", "bg"),
        ...(issue ? [warn(issue.level === "refuse" ? `${issue.message}. Saving is refused until the colours are fixed.` : issue.message)] : []),
        note("Encoded to SVG on the client — static, no network."),
      ];
    }
    case "countdown":
      return [text("Label", "label"), text("Target (HH:MM)", "target"), color("Colour", "color")];
  }
  return [];
});

/** Sources an EMBED can frame: everything except pages (no pages-in-pages, by design). */
const embeddableSourceOptions = computed(() =>
  store.sources
    .filter((s) => s.kind !== "page")
    .map((s) => ({ v: s.id, t: `${s.name} — ${kindLabel(s.kind)}` })),
);
const imageSourceOptions = computed(() =>
  store.sources.filter((s) => s.kind === "image").map((s) => ({ v: s.id, t: s.name })),
);

// ── inspector: geometry inputs ────────────────────────────────────────────────
function setGeometry(key: "x" | "y" | "w" | "h", event: Event) {
  const el = selected.value;
  if (!el) return;
  const value = Number.parseFloat((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  const now = Date.now();
  if (now - lastPropPushMs > 900) pushUndo();
  lastPropPushMs = now;
  const next = { x: el.x, y: el.y, w: el.w, h: el.h };
  if (key === "x") next.x = Math.max(0, Math.min(100 - el.w, value));
  if (key === "y") next.y = Math.max(0, Math.min(100 - el.h, value));
  if (key === "w") next.w = Math.max(3, Math.min(100 - el.x, value));
  if (key === "h") next.h = Math.max(3, Math.min(100 - el.y, value));
  patchElement(el.id, next);
  dirty.value = true;
}

// ── inspector: page props ─────────────────────────────────────────────────────
const BG_SWATCHES = ["#0b0b0e", "#101623", "#18181b", "#fafafa"];

function setBg(color: string) {
  bg.value = color;
  dirty.value = true;
}

function setAspect(value: PageAspect) {
  if (aspect.value === value) return;
  aspect.value = value;
  dirty.value = true;
}

/** Where this page is live right now (screens/walls whose content summary names it). */
const assignedTo = computed<string[]>(() => {
  const users: string[] = [];
  const seen = new Set<string>();
  for (const machine of store.machines) {
    for (const screen of machine.screens) {
      if (screen.content?.kind === "page" && screen.content.name === name.value && !seen.has(screen.friendlyName)) {
        seen.add(screen.friendlyName);
        users.push(screen.friendlyName);
      }
    }
  }
  return users;
});

// ── keyboard ──────────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  const tag = ((e.target as HTMLElement | null)?.tagName ?? "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if ((e.key === "Delete" || e.key === "Backspace") && selectedId.value) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redo();
  }
}

onMounted(() => {
  tryLoad();
  window.addEventListener("mousemove", onWindowMove);
  window.addEventListener("mouseup", onWindowUp);
  window.addEventListener("keydown", onKeydown);
});
onUnmounted(() => {
  window.removeEventListener("mousemove", onWindowMove);
  window.removeEventListener("mouseup", onWindowUp);
  window.removeEventListener("keydown", onKeydown);
});

// ── resize handles ────────────────────────────────────────────────────────────
const HANDLES: { key: string; left: number; top: number; cursor: string }[] = [
  { key: "nw", left: 0, top: 0, cursor: "nwse-resize" },
  { key: "n", left: 50, top: 0, cursor: "ns-resize" },
  { key: "ne", left: 100, top: 0, cursor: "nesw-resize" },
  { key: "e", left: 100, top: 50, cursor: "ew-resize" },
  { key: "se", left: 100, top: 100, cursor: "nwse-resize" },
  { key: "s", left: 50, top: 100, cursor: "ns-resize" },
  { key: "sw", left: 0, top: 100, cursor: "nesw-resize" },
  { key: "w", left: 0, top: 50, cursor: "ew-resize" },
];

function badgeText(el: PageElement): string {
  const round = (v: number) => Math.round(v * 10) / 10;
  return `${round(el.x)}, ${round(el.y)}  ·  ${round(el.w)} × ${round(el.h)} %`;
}
</script>

<template>
  <div class="studio">
    <!-- ── header ─────────────────────────────────────────────────────────── -->
    <header class="st-head">
      <button class="back-btn" @click="goBack">← Content</button>
      <input v-model="name" class="name-input" @input="dirty = true" />
      <span class="page-chip">PAGE</span>
      <div class="spacer"></div>
      <div class="aspect-pills">
        <button class="pill" :class="{ active: aspect === '16:9' }" @click="setAspect('16:9')">16:9</button>
        <button class="pill" :class="{ active: aspect === '9:16' }" @click="setAspect('9:16')">9:16</button>
      </div>
      <div class="head-divider"></div>
      <button class="icon-btn" :disabled="!undoStack.length" title="Undo — ⌘Z" @click="undo">↩</button>
      <button class="icon-btn" :disabled="!redoStack.length" title="Redo — ⇧⌘Z" @click="redo">↪</button>
      <div class="head-divider"></div>
      <span v-if="dirty" class="unsaved"><span class="unsaved-dot"></span>Unsaved</span>
      <button class="save-btn" :disabled="saving" @click="save">{{ saving ? "Saving…" : "Save" }}</button>
    </header>

    <div class="st-body">
      <!-- ── library + layers ───────────────────────────────────────────── -->
      <aside class="rail">
        <div class="rail-head">Library</div>
        <div class="lib-grid">
          <div
            v-for="entry in ELEMENT_LIBRARY"
            :key="entry.kind"
            class="lib-tile"
            :title="entry.hint"
            @mousedown="libDown(entry.kind, $event)"
          >
            <span class="lib-glyph">{{ entry.glyph }}</span>
            <span class="lib-name">{{ entry.name }}</span>
          </div>
        </div>

        <div class="rail-head layers-head">
          Layers <span class="rail-hint">· front first</span>
        </div>
        <div class="layers">
          <div v-if="!elements.length" class="layers-empty">
            Nothing on the page yet — drag an element onto the canvas.
          </div>
          <div
            v-for="layer in layers"
            :key="layer.el.id"
            class="layer-row"
            :class="{ selected: selectedId === layer.el.id }"
            @click="select(layer.el.id)"
          >
            <span class="layer-glyph">{{ layer.entry.glyph }}</span>
            <span class="layer-name">{{ layer.label }}</span>
            <button class="layer-btn" title="Bring forward" @click.stop="zMove(layer.el.id, 1)">▲</button>
            <button class="layer-btn" title="Send backward" @click.stop="zMove(layer.el.id, -1)">▼</button>
          </div>
        </div>
      </aside>

      <!-- ── canvas ─────────────────────────────────────────────────────── -->
      <div class="canvas-zone">
        <div class="canvas-center">
          <div
            ref="canvasEl"
            class="canvas"
            :class="aspect === '9:16' ? 'portrait' : 'landscape'"
            :style="{ background: bg }"
            @mousedown="select(null)"
          >
            <div v-if="!elements.length" class="canvas-empty">
              <span class="canvas-empty-plus">+</span>
              <span>Drag elements from the library onto the page</span>
            </div>

            <div
              v-for="(el, i) in elements"
              :key="el.id"
              class="canvas-el"
              :class="{ selected: selectedId === el.id }"
              :style="{
                left: `${el.x}%`,
                top: `${el.y}%`,
                width: `${el.w}%`,
                height: `${el.h}%`,
                zIndex: 10 + i,
              }"
              @mousedown="elementDown(el.id, $event)"
            >
              <PageElementView :element="el" :data="studioData" :live="false" :label="elementLabel(el)" />
              <div v-if="selectedId === el.id && dragActive" class="drag-badge">{{ badgeText(el) }}</div>
              <template v-if="selectedId === el.id">
                <div
                  v-for="h in HANDLES"
                  :key="h.key"
                  class="handle"
                  :style="{ left: `${h.left}%`, top: `${h.top}%`, cursor: h.cursor }"
                  @mousedown="handleDown(el.id, h.key, $event)"
                ></div>
              </template>
            </div>

            <div v-if="guideV !== null" class="guide-v" :style="{ left: `${guideV}%` }"></div>
            <div v-if="guideH !== null" class="guide-h" :style="{ top: `${guideH}%` }"></div>
          </div>
        </div>
        <div class="canvas-foot">
          <span>Positions are % of the screen — pages render at any resolution</span>
          <span>·</span>
          <span>Saving re-pushes the slice: assigned walls update in &lt;150 ms, no reload</span>
        </div>
      </div>

      <!-- ── inspector ──────────────────────────────────────────────────── -->
      <aside class="inspector">
        <!-- page props (nothing selected) -->
        <template v-if="!selected">
          <div class="rail-head flush">Page</div>
          <div class="field-label">Background</div>
          <div class="swatches">
            <button
              v-for="c in BG_SWATCHES"
              :key="c"
              class="swatch lg"
              :class="{ active: bg === c }"
              :style="{ background: c }"
              @click="setBg(c)"
            ></button>
          </div>
          <div class="field-label">Assigned to</div>
          <div class="assigned">
            {{
              assignedTo.length
                ? `Live on ${assignedTo.join(" · ")} — saving re-pushes the slice, the wall updates without a reload.`
                : "Not on any screen yet. Assign it from the Wall or a screen inspector, like any other source."
            }}
          </div>
          <div class="ins-empty">
            <span class="ins-empty-title">Select an element to edit it</span>
            <span class="ins-empty-sub">Drag to move · handles to resize<br />⌘Z undo · Delete removes</span>
          </div>
        </template>

        <!-- element props -->
        <template v-else>
          <div class="sel-head">
            <span class="sel-glyph">{{ selectedEntry?.glyph }}</span>
            <span class="sel-kind">{{ selectedEntry?.name }}</span>
          </div>

          <div class="props">
            <div v-for="spec in propSpecs" :key="spec.key + (spec.label ?? '')" class="prop">
              <div v-if="spec.label" class="prop-head">
                <span class="prop-label">{{ spec.label }}</span>
                <span v-if="spec.valueLabel" class="prop-val">{{ spec.valueLabel }}</span>
              </div>
              <input
                v-if="spec.control === 'text'"
                class="field"
                :value="String(spec.value ?? '')"
                @input="setProp(spec.key, ($event.target as HTMLInputElement).value)"
              />
              <select
                v-else-if="spec.control === 'select'"
                class="field select"
                :value="String(spec.value ?? '')"
                @change="setProp(spec.key, ($event.target as HTMLSelectElement).value)"
              >
                <option v-if="!spec.options?.length" value="" disabled>Nothing available yet</option>
                <option v-else-if="spec.key === 'sourceId'" value="">Assign from library…</option>
                <option v-for="o in spec.options" :key="o.v" :value="o.v">{{ o.t }}</option>
              </select>
              <input
                v-else-if="spec.control === 'range'"
                type="range"
                class="range"
                :min="spec.min"
                :max="spec.max"
                :value="Number(spec.value)"
                @input="setProp(spec.key, Number(($event.target as HTMLInputElement).value))"
              />
              <div v-else-if="spec.control === 'color'" class="swatches">
                <button
                  v-for="c in spec.swatches"
                  :key="c"
                  class="swatch"
                  :class="{ active: spec.value === c }"
                  :style="{ background: c }"
                  @click="setProp(spec.key, c)"
                ></button>
                <!-- Any colour (POL-133): brand walls want more than six swatches. -->
                <input
                  type="color"
                  class="swatch swatch-pick"
                  :value="/^#[0-9a-fA-F]{6}$/.test(String(spec.value ?? '')) ? String(spec.value) : '#888888'"
                  title="Custom colour"
                  @input="setProp(spec.key, ($event.target as HTMLInputElement).value)"
                />
              </div>
              <div v-else-if="spec.control === 'zoom'" class="zoom-ctl">
                <button
                  class="zoom-step"
                  :disabled="!canZoomOut(Number(spec.value))"
                  title="Zoom out"
                  @click="setProp(spec.key, zoomOut(Number(spec.value)))"
                >
                  −
                </button>
                <button
                  class="zoom-val"
                  :disabled="Number(spec.value) === 1"
                  :title="Number(spec.value) === 1 ? 'Already at 100%' : 'Reset to 100%'"
                  @click="setProp(spec.key, 1)"
                >
                  {{ zoomLabel(Number(spec.value)) }}
                </button>
                <button
                  class="zoom-step"
                  :disabled="!canZoomIn(Number(spec.value))"
                  title="Zoom in"
                  @click="setProp(spec.key, zoomIn(Number(spec.value)))"
                >
                  +
                </button>
              </div>
              <div v-else-if="spec.control === 'warn'" class="prop-warn">⚠ {{ spec.note }}</div>
              <button
                v-else-if="spec.control === 'toggle'"
                class="toggle"
                :class="{ on: !!spec.value }"
                @click="setProp(spec.key, !spec.value)"
              >
                <span class="toggle-knob"></span>
              </button>
              <div v-else-if="spec.control === 'note'" class="prop-note">{{ spec.note }}</div>
            </div>
          </div>

          <div class="field-label">
            Position &amp; size <span class="rail-hint">· % of page</span>
          </div>
          <div class="geom-grid">
            <label class="geom"><span>X</span><input :value="selected.x" @change="setGeometry('x', $event)" /></label>
            <label class="geom"><span>Y</span><input :value="selected.y" @change="setGeometry('y', $event)" /></label>
            <label class="geom"><span>W</span><input :value="selected.w" @change="setGeometry('w', $event)" /></label>
            <label class="geom"><span>H</span><input :value="selected.h" @change="setGeometry('h', $event)" /></label>
          </div>
          <div class="z-row">
            <button class="z-btn" @click="zMove(selected.id, 1)">Forward ▲</button>
            <button class="z-btn" @click="zMove(selected.id, -1)">Back ▼</button>
          </div>
          <button class="delete-btn" @click="deleteSelected">Delete element</button>
        </template>
      </aside>
    </div>

    <!-- library drag ghost (follows the cursor until dropped on the canvas) -->
    <div v-if="ghost" class="ghost" :style="{ left: `${ghost.x + 12}px`, top: `${ghost.y + 12}px` }">
      {{ ghost.label }}
    </div>
  </div>
</template>

<style scoped>
.studio {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ── header ── */
.st-head {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  flex: 0 0 56px;
  padding: 0 14px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}
.back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 11px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--fg2);
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--line);
  background: var(--surface);
  font-family: inherit;
  flex: 0 0 auto;
}
.back-btn:hover {
  background: var(--muted-bg);
}
.name-input {
  width: 230px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 7px 9px;
  font-size: 14px;
  font-weight: 600;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.name-input:hover {
  border-color: var(--line);
}
.name-input:focus {
  border-color: var(--accent);
  background: var(--surface);
}
.page-chip {
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 20px;
  color: var(--accent-fg);
  background: var(--accent-soft);
  flex: 0 0 auto;
}
.spacer {
  flex: 1;
}
.aspect-pills {
  display: inline-flex;
  background: var(--muted-bg);
  border-radius: 9px;
  padding: 3px;
  gap: 2px;
  flex: 0 0 auto;
}
.pill {
  padding: 5px 11px;
  border-radius: 7px;
  border: none;
  background: transparent;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  font-family: inherit;
}
.pill.active {
  background: var(--surface);
  color: var(--fg);
  box-shadow: var(--shadow-sm);
}
.head-divider {
  width: 1px;
  height: 22px;
  background: var(--line);
  flex: 0 0 auto;
}
.icon-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 14px;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
  flex: 0 0 auto;
}
.icon-btn:hover:not(:disabled) {
  background: var(--muted-bg);
}
.icon-btn:disabled {
  color: var(--muted2);
  opacity: 0.45;
  cursor: default;
}
.unsaved {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--muted);
  flex: 0 0 auto;
}
.unsaved-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.save-btn {
  padding: 8px 18px;
  border-radius: 9px;
  border: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
  flex: 0 0 auto;
}
.save-btn:hover:not(:disabled) {
  opacity: 0.92;
}
.save-btn:disabled {
  opacity: 0.6;
}

/* ── body ── */
.st-body {
  flex: 1;
  display: flex;
  min-height: 0;
}

/* left rail */
.rail {
  width: 198px;
  flex: 0 0 198px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.rail-head {
  padding: 15px 12px 9px;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
}
.rail-head.flush {
  padding: 0 0 12px;
}
.rail-hint {
  font-weight: 400;
  color: var(--muted2);
  font-size: 10.5px;
}
.lib-grid {
  padding: 0 10px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.lib-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 9px 4px 8px;
  border: 1px solid var(--line);
  border-radius: 9px;
  cursor: grab;
  user-select: none;
  background: var(--card);
}
.lib-tile:hover {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.lib-glyph {
  font-size: 15px;
  line-height: 1;
  color: var(--fg2);
}
.lib-name {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--fg2);
}
.layers-head {
  padding-top: 16px;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.layers {
  flex: 1;
  overflow-y: auto;
  padding: 0 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.layers-empty {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
  padding: 2px;
}
.layer-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 7px;
  border-radius: 8px;
  cursor: pointer;
}
.layer-row.selected {
  background: var(--accent-soft);
}
.layer-glyph {
  font-size: 12px;
  color: var(--muted);
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
}
.layer-name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.layer-btn {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  font-size: 9px;
  color: var(--muted);
  cursor: pointer;
  border: none;
  background: transparent;
  flex: 0 0 auto;
  font-family: inherit;
}
.layer-btn:hover {
  background: var(--muted-bg);
  color: var(--fg);
}

/* canvas */
.canvas-zone {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg);
}
.canvas-center {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 22px 28px 8px;
}
.canvas {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--line);
  container-type: size;
}
.canvas.landscape {
  width: min(100%, calc((100vh - 205px) * 1.7778));
  aspect-ratio: 16 / 9;
}
.canvas.portrait {
  height: min(100%, calc(100vh - 205px));
  aspect-ratio: 9 / 16;
}
.canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  z-index: 5;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.42);
  font-weight: 500;
  pointer-events: none;
}
.canvas-empty-plus {
  font-size: 22px;
  color: rgba(255, 255, 255, 0.3);
  font-weight: 300;
}
.canvas-el {
  position: absolute;
  cursor: grab;
  user-select: none;
}
.canvas-el:hover {
  outline: 1.5px solid var(--accent-line);
}
.canvas-el.selected {
  box-shadow: 0 0 0 1.6px var(--accent);
}
.drag-badge {
  position: absolute;
  left: 0;
  top: calc(100% + 6px);
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 3px 7px;
  border-radius: 5px;
  white-space: nowrap;
  z-index: 40;
}
.handle {
  position: absolute;
  transform: translate(-50%, -50%);
  width: 9px;
  height: 9px;
  background: var(--surface);
  border: 1.5px solid var(--accent);
  border-radius: 2px;
  z-index: 35;
}
.guide-v {
  position: absolute;
  top: 0;
  width: 0;
  height: 100%;
  border-left: 1.5px dashed var(--accent);
  z-index: 60;
  pointer-events: none;
}
.guide-h {
  position: absolute;
  left: 0;
  height: 0;
  width: 100%;
  border-top: 1.5px dashed var(--accent);
  z-index: 60;
  pointer-events: none;
}
.canvas-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px 13px;
  font-size: 11px;
  color: var(--muted2);
}

/* inspector */
.inspector {
  width: 252px;
  flex: 0 0 252px;
  border-left: 1px solid var(--line);
  background: var(--surface);
  overflow-y: auto;
  padding: 16px 14px 24px;
}
.field-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg2);
  margin-bottom: 7px;
}
.swatches {
  display: flex;
  gap: 7px;
  margin-bottom: 18px;
}
.swatch {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  cursor: pointer;
  border: 1px solid var(--line);
  padding: 0;
}
.swatch.lg {
  width: 30px;
  height: 30px;
  border-radius: 8px;
}
.swatch.active {
  box-shadow: 0 0 0 2px var(--accent);
}
.assigned {
  font-size: 12px;
  color: var(--fg2);
  background: var(--muted-bg);
  border-radius: 9px;
  padding: 10px 12px;
  margin-bottom: 18px;
  line-height: 1.55;
}
.ins-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  padding: 26px 12px;
  border: 1.5px dashed var(--line2);
  border-radius: 11px;
  text-align: center;
}
.ins-empty-title {
  font-size: 12.5px;
  color: var(--muted);
  font-weight: 500;
}
.ins-empty-sub {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.6;
}
.sel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.sel-glyph {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: var(--muted-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: var(--fg2);
  flex: 0 0 auto;
}
.sel-kind {
  font-size: 13.5px;
  font-weight: 600;
}
.props {
  display: flex;
  flex-direction: column;
  gap: 13px;
  margin-bottom: 18px;
}
.prop {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.prop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.prop-label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--fg2);
}
.prop-val {
  font-size: 11px;
  color: var(--muted2);
  font-variant-numeric: tabular-nums;
}
.field {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--fg);
  outline: none;
  font-family: inherit;
}
.field:focus {
  border-color: var(--accent);
}
.field.select {
  appearance: auto;
  cursor: pointer;
  color: var(--fg2);
  padding: 8px 9px;
}
.range {
  width: 100%;
}
.toggle {
  width: 38px;
  height: 22px;
  border-radius: 20px;
  border: none;
  background: var(--line2);
  position: relative;
  cursor: pointer;
  padding: 0;
  transition: background 0.15s ease;
}
.toggle.on {
  background: var(--accent);
}
.toggle-knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s ease;
}
.toggle.on .toggle-knob {
  left: 19px;
}
.prop-note {
  font-size: 11px;
  color: var(--muted2);
  line-height: 1.55;
  background: var(--muted-bg);
  border-radius: 8px;
  padding: 9px 11px;
}

/* POL-133: a LOUD authoring-time warning (QR scannability) — must not read like the quiet notes. */
.prop-warn {
  font-size: 11px;
  font-weight: 600;
  color: var(--bad);
  line-height: 1.55;
  background: var(--bad-soft);
  border: 1px solid var(--scr-bad-line);
  border-radius: 8px;
  padding: 9px 11px;
}

/* POL-133: the −/value/+ page-zoom control, visually matching the screens Inspector's ZoomControl. */
.zoom-ctl {
  display: flex;
  align-items: center;
  gap: 7px;
}
.zoom-step {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 28px;
  flex: 0 0 auto;
  border-radius: 8px;
  border: 1px solid var(--line2);
  background: var(--surface);
  color: var(--fg);
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
  cursor: pointer;
  font-family: inherit;
}
.zoom-step:not(:disabled):hover {
  background: var(--muted-bg);
}
.zoom-step:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.zoom-val {
  flex: 1;
  height: 28px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--muted-bg);
  color: var(--fg2);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  font-family: inherit;
}
.zoom-val:disabled {
  cursor: default;
}

/* POL-133: the free colour picker at the end of a swatch row. */
.swatch-pick {
  appearance: none;
  -webkit-appearance: none;
  background: none;
}
.swatch-pick::-webkit-color-swatch-wrapper {
  padding: 2px;
}
.swatch-pick::-webkit-color-swatch {
  border: none;
  border-radius: 5px;
}
.geom-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  margin-bottom: 18px;
}
.geom {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--muted-bg);
  border-radius: 8px;
  padding: 6px 9px;
}
.geom span {
  font-size: 10px;
  font-weight: 600;
  color: var(--muted2);
  flex: 0 0 auto;
}
.geom input {
  width: 100%;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  font-size: 12px;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  font-family: inherit;
}
.z-row {
  display: flex;
  gap: 7px;
}
.z-btn {
  flex: 1;
  text-align: center;
  padding: 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--fg2);
  cursor: pointer;
  font-family: inherit;
}
.z-btn:hover {
  background: var(--muted-bg);
}
.delete-btn {
  margin-top: 14px;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 9px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--surface);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--bad);
  cursor: pointer;
  font-family: inherit;
}
.delete-btn:hover {
  background: var(--bad-soft);
}

/* drag ghost */
.ghost {
  position: fixed;
  z-index: 500;
  pointer-events: none;
  background: var(--primary);
  color: var(--primary-fg);
  font-size: 11px;
  font-weight: 600;
  padding: 5px 9px;
  border-radius: 7px;
  box-shadow: var(--shadow);
  white-space: nowrap;
}
</style>
