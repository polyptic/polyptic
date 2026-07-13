/**
 * A single shared 1 Hz "now" for every clock/countdown element on a page.
 *
 * Clock and countdown elements update TEXT NODES on a timer — never an opacity/transform/filter
 * animation (D66: wall-rendered chrome must not animate those; software-rendered boxes drop the
 * layers or repaint forever). One interval serves any number of elements (refcounted), and Vue only
 * patches the DOM when a derived string actually changes, so a minute-clock costs one text-node
 * write per minute.
 */
import { onMounted, onUnmounted, ref } from "vue";
import type { Ref } from "vue";

const now = ref(new Date());
let refs = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Component-scoped access to the shared clock: starts the 1 Hz interval on first use, stops it
 *  when the last element unmounts. Call from setup(). */
export function useNow(): Ref<Date> {
  onMounted(() => {
    refs += 1;
    if (!timer) {
      now.value = new Date();
      timer = setInterval(() => {
        now.value = new Date();
      }, 1000);
    }
  });
  onUnmounted(() => {
    refs -= 1;
    if (refs <= 0 && timer) {
      clearInterval(timer);
      timer = undefined;
      refs = 0;
    }
  });
  return now;
}

/** "08:05" / "8:05 pm" per the clock element's props. */
export function formatClock(date: Date, format: "24h" | "12h", seconds: boolean): string {
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = seconds ? `:${String(date.getSeconds()).padStart(2, "0")}` : "";
  if (format === "12h") {
    const suffix = date.getHours() < 12 ? " am" : " pm";
    const hh = date.getHours() % 12 || 12;
    return `${hh}:${mm}${ss}${suffix}`;
  }
  return `${String(date.getHours()).padStart(2, "0")}:${mm}${ss}`;
}

/** Minutes until the next occurrence of "HH:MM" today/tomorrow, rendered "HH:MM". */
export function formatCountdown(date: Date, target: string): string {
  const [h, m] = target.split(":");
  let mins = (Number(h) || 0) * 60 + (Number(m) || 0) - (date.getHours() * 60 + date.getMinutes());
  if (mins < 0) mins += 24 * 60;
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/** A compact age ("2h", "3d", "now") for feed item timestamps. */
export function formatAge(iso: string | undefined, reference: Date): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((reference.getTime() - then) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
