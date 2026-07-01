/**
 * Unit tests for the console's keyed node diff (POL-8).
 *
 * The whole point of reconcileNodes is that a tile PATCHES IN PLACE across store pushes rather than
 * re-mounting (which is what makes the canvas flash). These tests pin that invariant down at the data
 * level — node object identity is preserved, and untouched fields are left strictly alone — which is
 * exactly what lets Vue Flow reuse the mounted ScreenNode/WallNode instead of tearing it down.
 */
import { describe, expect, test } from "bun:test";
import { reconcileNodes } from "./reconcileNodes";
import type { NodeSpec } from "./reconcileNodes";
// Node objects are plain here; the real type comes from @vue-flow/core but the diff only touches
// id/type/position/data/style, so a structural stand-in is enough for the logic under test.
type TestNode = {
  id: string;
  type?: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
  style?: Record<string, string>;
  draggable?: boolean;
  selectable?: boolean;
};

function spec(id: string, over: Partial<NodeSpec> = {}): NodeSpec {
  return {
    id,
    type: "screen",
    position: { x: 0, y: 0 },
    data: { name: id, status: "live" },
    style: { width: "180px", height: "101px", zIndex: "10" },
    draggable: true,
    selectable: true,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (nodes: TestNode[], desired: NodeSpec[], opts?: any) =>
  reconcileNodes(nodes as any, desired, opts);

describe("reconcileNodes", () => {
  test("first pass creates a node per spec", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a"), spec("b")]);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });

  test("re-running with an equivalent spec keeps the SAME node object (no remount)", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a")]);
    const first = nodes[0];
    // A fresh, structurally-identical spec (as a server rebroadcast produces).
    run(nodes, [spec("a")]);
    expect(nodes[0]).toBe(first); // identity preserved
  });

  test("an unchanged tile is not touched — data & style refs are left alone", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a")]);
    const beforeData = nodes[0].data;
    const beforeStyle = nodes[0].style;
    run(nodes, [spec("a")]); // no real change
    expect(nodes[0].data).toBe(beforeData); // not reassigned → no re-render
    expect(nodes[0].style).toBe(beforeStyle);
  });

  test("a changed field is patched in place on the same node object", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a", { data: { name: "a", status: "empty" } })]);
    const node = nodes[0];
    const beforeStyle = nodes[0].style;
    run(nodes, [spec("a", { data: { name: "a", status: "live" } })]);
    expect(nodes[0]).toBe(node); // still the same node
    expect(nodes[0].data).toEqual({ name: "a", status: "live" }); // data updated
    expect(nodes[0].style).toBe(beforeStyle); // style untouched (unchanged)
  });

  test("position updates when it moves, but sub-pixel jitter is ignored", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a", { position: { x: 10, y: 10 } })]);
    const pos = nodes[0].position;
    run(nodes, [spec("a", { position: { x: 10.2, y: 10.1 } })]); // < 0.5px → ignored
    expect(nodes[0].position).toBe(pos);
    run(nodes, [spec("a", { position: { x: 40, y: 60 } })]); // real move → updated
    expect(nodes[0].position).toEqual({ x: 40, y: 60 });
  });

  test("freezePosition keeps a dragging node's position pinned", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a", { position: { x: 0, y: 0 } })]);
    run(nodes, [spec("a", { position: { x: 500, y: 500 } })], {
      freezePosition: new Set(["a"]),
    });
    expect(nodes[0].position).toEqual({ x: 0, y: 0 }); // not yanked mid-drag
  });

  test("adding a node leaves existing siblings' identity intact", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a"), spec("b")]);
    const a = nodes[0];
    const b = nodes[1];
    run(nodes, [spec("a"), spec("b"), spec("c")]);
    expect(nodes[0]).toBe(a);
    expect(nodes[1]).toBe(b);
    expect(nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  test("removing a node drops it but preserves the survivors", () => {
    const nodes: TestNode[] = [];
    run(nodes, [spec("a"), spec("b"), spec("c")]);
    const a = nodes[0];
    const c = nodes[2];
    run(nodes, [spec("a"), spec("c")]); // b unplaced
    expect(nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(nodes[0]).toBe(a);
    expect(nodes[1]).toBe(c);
  });
});
