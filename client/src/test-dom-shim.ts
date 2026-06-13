/**
 * Minimal DOM stub for client-side hook tests. The full hook
 * (useTextChunkSearch) is pure (no DOM access), but the test
 * uses Preact's `render` to drive the hook, and Preact's render
 * expects a `document` global with `createElement` /
 * `createDocumentFragment` / `body.appendChild` / `removeChild`.
 *
 * Bun's test runner does not provide a DOM by default. We
 * install a tiny shim here that satisfies Preact's needs without
 * pulling in `happy-dom` or `jsdom` (which are not in the
 * project's deps).
 */

class FakeNode {
  children: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeType = 1;
  ownerDocument: FakeDocument | null = null;
  style: Record<string, string> = {};
  attributes: Record<string, string> = {};
  _listeners: Record<string, Array<(e: any) => void>> = {};
  constructor(public tagName: string) {}
  appendChild<T extends FakeNode>(child: T): T {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  insertBefore<T extends FakeNode>(child: T, ref: T | null): T {
    if (ref == null) return this.appendChild(child);
    const idx = this.children.indexOf(ref);
    if (idx < 0) return this.appendChild(child);
    this.children.splice(idx, 0, child);
    child.parentNode = this;
    return child;
  }
  setAttribute(name: string, value: string) {
    this.attributes[name] = String(value);
  }
  getAttribute(name: string): string | null {
    return this.attributes[name] != null ? this.attributes[name] : null;
  }
  addEventListener(name: string, fn: (e: any) => void) {
    (this._listeners[name] ||= []).push(fn);
  }
  removeEventListener(name: string, fn: (e: any) => void) {
    const arr = this._listeners[name];
    if (!arr) return;
    const idx = arr.indexOf(fn);
    if (idx >= 0) arr.splice(idx, 1);
  }
}

class FakeElement extends FakeNode {
  classList = {
    add() {},
    remove() {},
    contains() { return false; },
  };
  get className() { return this.attributes["class"] ?? ""; }
  set className(v: string) { this.attributes["class"] = v; }
  get textContent() { return this._textContent; }
  set textContent(v: string) { this._textContent = String(v); }
  get innerHTML() { return this._innerHTML; }
  set innerHTML(v: string) {
    this._innerHTML = String(v);
    this.children = [];
  }
  private _textContent = "";
  private _innerHTML = "";
}

class FakeDocument {
  body: FakeElement;
  head: FakeElement;
  constructor() {
    this.body = new FakeElement("body");
    this.body.ownerDocument = this;
    this.head = new FakeElement("head");
    this.head.ownerDocument = this;
  }
  createElement(tag: string): FakeElement {
    const el = new FakeElement(tag);
    el.ownerDocument = this;
    return el;
  }
  createElementNS(_ns: string, tag: string): FakeElement {
    return this.createElement(tag);
  }
  createDocumentFragment(): FakeNode {
    const frag = new FakeNode("#fragment");
    frag.ownerDocument = this;
    return frag;
  }
  createTextNode(text: string): FakeNode {
    const node = new FakeNode("#text");
    (node as any).data = String(text);
    return node;
  }
  get activeElement(): FakeElement | null {
    return null;
  }
  addEventListener() {}
  removeEventListener() {}
}

const existingDoc: any = (globalThis as any).document;
if (!existingDoc || typeof existingDoc.createElement !== "function") {
  const fakeDoc = new FakeDocument();
  (globalThis as any).document = fakeDoc;
  (globalThis as any).window = (globalThis as any).window ?? {
    document: fakeDoc,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    location: { hash: "" },
  };
}
