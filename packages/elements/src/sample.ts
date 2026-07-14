/**
 * POL-99 — the Studio's stand-in table.
 *
 * On the Studio canvas (live=false) a data element with no real sample yet draws THIS, obviously
 * generic, so the operator can lay the page out before the endpoint exists. On the WALL (live=true)
 * it is never used: a wall shows real values or an honest hole, never invented numbers.
 */
import type { DataSet } from "@polyptic/protocol";

export const SAMPLE_DATASET: DataSet = {
  columns: ["name", "value", "change"],
  rows: [
    { name: "Line 1", value: 92, change: 1.4 },
    { name: "Line 2", value: 87, change: -0.6 },
    { name: "Line 3", value: 78, change: 2.1 },
    { name: "Line 4", value: 74, change: 0.3 },
    { name: "Line 5", value: 69, change: -1.2 },
    { name: "Line 6", value: 61, change: 0.9 },
    { name: "Line 7", value: 55, change: -0.4 },
    { name: "Line 8", value: 48, change: 1.7 },
  ],
  fetchedAt: "1970-01-01T00:00:00.000Z",
  stale: false,
};
