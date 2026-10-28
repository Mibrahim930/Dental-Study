// QA for src/components/MarkableText.tsx: the offset math (textNodes / domRange / offsetOf / selectionOffsets).
// No DOM library is installed (vitest runs in node), so the functions are lifted out of the component's source text and
// run against a tiny hand-made DOM (text nodes, elements, a text TreeWalker, and a Range that just records its ends).
// Cases that expose a bug are written as the CORRECT expectation under `it.fails`: the suite is green today and goes red
// (telling you to drop `.fails`) the moment the bug is fixed.
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

class N {
  parentNode: E | null = null;
  childNodes: N[] = [];
  nodeType = 0;
  contains(n: N | null): boolean {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
}
class T extends N {
  nodeType = 3;
  constructor(public data: string) {
    super();
  }
}
class E extends N {
  nodeType = 1;
  constructor(public tag: string, kids: (N | string)[] = []) {
    super();
    for (const k of kids) {
      const c = typeof k === "string" ? new T(k) : k;
      c.parentNode = this;
      this.childNodes.push(c);
    }
  }
}
const h = (tag: string, ...kids: (N | string)[]) => new E(tag, kids);

class FakeRange {
  sc: N | null = null;
  so = 0;
  ec: N | null = null;
  eo = 0;
  setStart(n: N, o: number) {
    this.sc = n;
    this.so = o;
  }
  setEnd(n: N, o: number) {
    this.ec = n;
    this.eo = o;
  }
}
const fakeDocument = {
  createRange: () => new FakeRange(),
  createTreeWalker(root: N) {
    const texts: N[] = [];
    const walk = (n: N) => {
      for (const c of n.childNodes) (c.nodeType === 3 ? texts.push(c) : walk(c));
    };
    walk(root);
    let i = 0;
    return { nextNode: () => texts[i++] ?? null };
  },
};

type Nodes = { node: T; start: number }[];
type Fns = {
  textNodes: (el: E) => Nodes;
  domRange: (nodes: Nodes, r: [number, number]) => FakeRange | null;
  offsetOf: (nodes: Nodes, node: N, offset: number) => number | null;
  selectionOffsets: (el: E, nodes: Nodes, r: { startContainer: N; startOffset: number; endContainer: N; endOffset: number }) => [number, number] | null;
};

function load(): Fns {
  const src = readFileSync(path.resolve(import.meta.dirname, "../src/components/MarkableText.tsx"), "utf8");
  const from = src.indexOf("function textNodes");
  const to = src.indexOf("/**\n * Rendered lesson text");
  expect(from).toBeGreaterThan(0);
  expect(to).toBeGreaterThan(from);
  const js = ts.transpileModule(src.slice(from, to), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function("document", "NodeFilter", `${js}\nreturn { textNodes, domRange, offsetOf, selectionOffsets };`)(fakeDocument, { SHOW_TEXT: 4 }) as Fns;
}
const f = load();
const sel = (sc: N, so: number, ec: N, eo: number) => ({ startContainer: sc, startOffset: so, endContainer: ec, endOffset: eo });

describe("textNodes / domRange", () => {
  const a = new T("Alpha ");
  const b = new T("beta");
  const c = new T("Gamma");
  const root = h("div", h("p", a, h("strong", b)), h("p", c)); // "Alpha beta" + "Gamma" -> "Alpha betaGamma"
  const nodes = f.textNodes(root);

  it("walks text nodes in order with running offsets (no separator between paragraphs)", () => {
    expect(nodes.map((n) => [n.node.data, n.start])).toEqual([["Alpha ", 0], ["beta", 6], ["Gamma", 10]]);
  });

  it("maps [s,e) to the right nodes, including ends exactly on a node boundary", () => {
    let r = f.domRange(nodes, [2, 4])!;
    expect([r.sc, r.so, r.ec, r.eo]).toEqual([a, 2, a, 4]);
    r = f.domRange(nodes, [2, 6])!; // ends exactly at the end of "Alpha "
    expect([r.sc, r.so, r.ec, r.eo]).toEqual([a, 2, a, 6]);
    r = f.domRange(nodes, [6, 10])!; // starts exactly at the end of the previous node: begins in the next one at 0
    expect([r.sc, r.so, r.ec, r.eo]).toEqual([b, 0, b, 4]);
    r = f.domRange(nodes, [3, 12])!; // across the paragraph break
    expect([r.sc, r.so, r.ec, r.eo]).toEqual([a, 3, c, 2]);
  });

  it("start at/after the very end of the text paints nothing; an end past the end is clipped", () => {
    expect(f.domRange(nodes, [15, 20])).toBeNull();
    expect(f.domRange(nodes, [99, 120])).toBeNull();
    const r = f.domRange(nodes, [12, 40])!; // text got shorter since the mark was saved
    expect([r.sc, r.so, r.ec, r.eo]).toEqual([c, 2, c, 5]);
    expect(f.domRange([], [0, 3])).toBeNull();
  });
});

describe("offsetOf", () => {
  it("text-node boundaries", () => {
    const t1 = new T("Hello ");
    const t2 = new T("world");
    const root = h("div", h("p", t1, h("em", t2)));
    const nodes = f.textNodes(root);
    expect(f.offsetOf(nodes, t2, 3)).toBe(9);
  });

  it("element boundary: (p, 0), and a child element holding several text nodes -> start of its first text", () => {
    const root = h("div", h("p", "one "), h("p", "two ", h("strong", "th", h("em", "ree"))));
    const p2 = root.childNodes[1] as E;
    const nodes = f.textNodes(root);
    expect(f.offsetOf(nodes, p2, 0)).toBe(4);
    expect(f.offsetOf(nodes, p2, 1)).toBe(8); // before <strong>
    expect(f.offsetOf(nodes, root, 0)).toBe(0);
    expect(f.offsetOf(nodes, root, 1)).toBe(4); // before the 2nd <p>
  });

  it("(el, childNodes.length) on the LAST block is the end of the text", () => {
    const root = h("div", h("p", "one "), h("p", "two"));
    const nodes = f.textNodes(root);
    expect(f.offsetOf(nodes, root, 2)).toBe(7);
    expect(f.offsetOf(nodes, root.childNodes[1] as E, 1)).toBe(7);
  });

  // BUG: offset === childNodes.length of an element that is NOT last returns the end of the WHOLE block, not the end
  // of that element. Input: "Alpha beta" | "Gamma", selection from (p1.text,0) to (p1,1) -> should be [0,10], is [0,15].
  it("(p1, p1.childNodes.length) in a non-last paragraph is the end of p1, not of the block", () => {
    const root = h("div", h("p", "Alpha beta"), h("p", "Gamma"));
    const p1 = root.childNodes[0] as E;
    const nodes = f.textNodes(root);
    expect(f.offsetOf(nodes, p1, 1)).toBe(10);
  });

  // BUG: a start/end boundary sitting on a child with no text (<br>, <img>, empty span) returns the END of the block.
  // Input: <p>foo<br>bar</p>, boundary (p, 1) (just before the <br>) should be 3, is 6.
  it("a boundary on a <br>/<img> child maps to the text position there, not to the end of the block", () => {
    const root = h("div", h("p", "foo", h("br"), "bar"));
    const p = root.childNodes[0] as E;
    const nodes = f.textNodes(root);
    expect(f.offsetOf(nodes, p, 1)).toBe(3);
    expect(f.offsetOf(nodes, p, 2)).toBe(3);
  });
});

describe("selectionOffsets", () => {
  it("a selection from one paragraph into the next maps to one range over the joined text and is trimmed", () => {
    const t1 = new T("  Alpha beta ");
    const t2 = new T(" Gamma delta");
    const root = h("div", h("p", t1), h("p", t2));
    const nodes = f.textNodes(root);
    // text = "  Alpha beta  Gamma delta"
    expect(f.selectionOffsets(root, nodes, sel(t1, 0, t2, 6))).toEqual([2, 19]);
    expect(f.selectionOffsets(root, nodes, sel(t1, 0, t1, 2))).toBeNull(); // only spaces
  });

  it("outside the block -> null", () => {
    const inside = new T("abc def");
    const root = h("div", h("p", inside));
    const other = new T("zzz");
    const page = h("main", root, h("p", other));
    const nodes = f.textNodes(root);
    expect(page.contains(other)).toBe(true);
    expect(f.selectionOffsets(root, nodes, sel(inside, 0, other, 2))).toBeNull();
  });

  it("triple-click in the middle of the block: end is (nextParagraph, 0) -> ends exactly where the paragraph ends", () => {
    const t1 = new T("First para.");
    const t2 = new T("Second para.");
    const root = h("div", h("p", t1), h("p", t2));
    const nodes = f.textNodes(root);
    expect(f.selectionOffsets(root, nodes, sel(t1, 0, root.childNodes[1] as E, 0))).toEqual([0, 11]);
  });

  // BUG (edge): triple-click on the LAST paragraph of a block (Chrome ends the range at offset 0 of the next block,
  // which is outside this block): the whole selection is rejected, so no Highlight/Underline pill. Intro blocks are always
  // a single paragraph, so this is every triple-click there. Expected [0, 11].
  it("a paragraph selected up to the start of the next element OUTSIDE the block still counts", () => {
    const t1 = new T("First para.");
    const root = h("div", h("p", t1));
    const next = h("p", "Next block");
    const page = h("main", root, next);
    void page;
    const nodes = f.textNodes(root);
    expect(f.selectionOffsets(root, nodes, sel(t1, 0, next, 0))).toEqual([0, 11]);
  });

  // BUG: Firefox-style end (p1, childNodes.length) in a NON-last paragraph extends the mark through the rest of the block.
  it("selection ending at (p1, p1.childNodes.length) stays inside p1", () => {
    const t1 = new T("Alpha beta");
    const root = h("div", h("p", t1), h("p", "Gamma"));
    const nodes = f.textNodes(root);
    expect(f.selectionOffsets(root, nodes, sel(t1, 0, root.childNodes[0] as E, 1))).toEqual([0, 10]);
  });
});
