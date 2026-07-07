/**
 * ParseRenderer
 * -------------
 * Turns a ParseEngine.parse() result (or any annotated node from it) into a
 * readable, interactive HTML tree instead of a raw JSON dump.
 *
 * What it fixes vs. JSON.stringify(reviews, null, 2):
 *
 *  1. NOISE: long runs of `null` (very common in this data — most positional
 *     slots in any given review are unused) get collapsed into a single line
 *     like "[3–13] (11× null)" instead of 11 separate lines.
 *  2. READABILITY: every node is collapsible (native <details>/<summary>),
 *     so you can fold away whole reviews/branches you don't care about and
 *     focus on one at a time.
 *  3. LINKING: any scalar value (string/number) that appears more than once
 *     anywhere in the parsed tree is underlined and tagged with a "×N"
 *     badge. Click it and every other occurrence lights up — this is how
 *     you spot things like a business ID or place ID that's repeated across
 *     every review without having to eyeball 40 fields of nulls each time.
 */
const ParseRenderer = (function () {

  // Only scalars "distinctive" enough to be worth cross-linking. Small
  // integers (0, 1, 2, 5...) repeat constantly and would just add noise.
  const LINK_MIN_STRING_LEN = 3;
  const LINK_MIN_NUMBER_ABS = 100;

  function isLinkable(node) {
    if (node.kind !== "value") return false;
    if (node.valueType === "string") return node.value.length >= LINK_MIN_STRING_LEN;
    if (node.valueType === "number") return Math.abs(node.value) >= LINK_MIN_NUMBER_ABS;
    return false;
  }

  function valueKey(node) {
    return node.valueType + ":" + String(node.value);
  }

  // First pass over the whole tree: count how many times each linkable
  // scalar value occurs, so we know which ones are worth highlighting.
  function buildValueIndex(node, index) {
    if (!node) return;
    if (node.kind === "value") {
      if (isLinkable(node)) {
        const key = valueKey(node);
        index.set(key, (index.get(key) || 0) + 1);
      }
      return;
    }
    if (node.kind === "array") {
      for (const k of Object.keys(node.items)) buildValueIndex(node.items[k], index);
      return;
    }
    if (node.kind === "object") {
      for (const k of Object.keys(node.fields)) buildValueIndex(node.fields[k], index);
      return;
    }
    if (node.kind === "encoded") {
      buildValueIndex(node.decoded, index);
    }
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === "class") e.className = attrs[k];
        else if (k === "text") e.textContent = attrs[k];
        else if (k === "open") { if (attrs[k]) e.open = true; }
        else e.setAttribute(k, attrs[k]);
      }
    }
    if (children) for (const c of children) if (c) e.appendChild(c);
    return e;
  }

  function renderLeaf(node, valueIndex) {
    if (node.valueType === "null") {
      return el("span", { class: "pe-null", text: "null" });
    }
    const text = node.valueType === "string" ? '"' + node.value + '"' : String(node.value);
    const span = el("span", { class: "pe-value pe-" + node.valueType, text: text });

    if (isLinkable(node)) {
      const key = valueKey(node);
      const count = valueIndex.get(key) || 1;
      span.dataset.linkKey = key;
      if (count > 1) {
        span.classList.add("pe-linkable");
        span.title = "Muncul " + count + "x di data ini — klik untuk menyorot semua";
        span.addEventListener("click", (evt) => {
          evt.stopPropagation();
          const willActivate = !span.classList.contains("pe-link-active");
          document.querySelectorAll('[data-link-key="' + CSS.escape(key) + '"]').forEach((elm) => {
            elm.classList.toggle("pe-link-active", willActivate);
          });
        });
        const badge = el("span", { class: "pe-badge", text: "×" + count });
        return el("span", { class: "pe-leaf-wrap" }, [span, badge]);
      }
    }
    return span;
  }

  function renderNode(node, label, valueIndex) {
    if (!node) return el("span", { class: "pe-null", text: "null" });

    if (node.kind === "value") {
      return renderLeaf(node, valueIndex);
    }

    if (node.kind === "encoded") {
      const details = el("details", { class: "pe-node", open: true });
      const prefix = label ? label + ": " : "";
      details.appendChild(el("summary", {
        class: "pe-summary",
        text: prefix + "🔓 decoded string (" + node.length + " chars)" + (node.repaired ? " [repaired]" : "")
      }));
      details.appendChild(renderNode(node.decoded, null, valueIndex));
      return details;
    }

    if (node.kind === "object") {
      const keys = Object.keys(node.fields);
      const details = el("details", { class: "pe-node" });
      const prefix = label ? label + ": " : "";
      details.appendChild(el("summary", { class: "pe-summary", text: prefix + "{ } " + keys.length + " field" + (keys.length === 1 ? "" : "s") }));
      const box = el("div", { class: "pe-children" });
      keys.forEach((k) => box.appendChild(renderRow(k, node.fields[k], valueIndex)));
      details.appendChild(box);
      return details;
    }

    if (node.kind === "array") {
      return renderArray(node, label, valueIndex);
    }

    return el("span", { text: JSON.stringify(node) });
  }

  function renderRow(label, childNode, valueIndex) {
    const row = el("div", { class: "pe-row" });
    row.appendChild(el("span", { class: "pe-index", text: label }));
    row.appendChild(renderNode(childNode, null, valueIndex));
    return row;
  }

  function renderArray(node, label, valueIndex) {
    // Keys are already hierarchical paths like "1", "1.1", "1.1.2" — insertion
    // order from ParseEngine already matches the intended display order, so
    // no numeric parsing/sorting is needed (and dotted strings like "1.1.10"
    // wouldn't sort correctly as numbers anyway).
    const keys = Object.keys(node.items);

    // Collapse consecutive null slots into a single "(N× null)" line.
    const groups = [];
    let i = 0;
    while (i < keys.length) {
      const key = keys[i];
      const child = node.items[key];
      const isNull = child && child.kind === "value" && child.valueType === "null";
      if (isNull) {
        let j = i;
        while (
          j < keys.length &&
          node.items[keys[j]] &&
          node.items[keys[j]].kind === "value" &&
          node.items[keys[j]].valueType === "null"
        ) j++;
        groups.push({ type: "null-run", from: key, to: keys[j - 1], count: j - i });
        i = j;
      } else {
        groups.push({ type: "item", key, node: child });
        i++;
      }
    }

    const withValueCount = groups.filter((g) => g.type === "item").length;
    const details = el("details", { class: "pe-node" });
    const prefix = label ? label + ": " : "";
    details.appendChild(el("summary", {
      class: "pe-summary",
      text: prefix + "[ ] " + node.length + " item" + (node.length === 1 ? "" : "s") +
            (withValueCount !== node.length ? " · " + withValueCount + " berisi nilai" : "")
    }));

    const box = el("div", { class: "pe-children" });
    for (const g of groups) {
      if (g.type === "null-run") {
        if (g.count === 1) {
          box.appendChild(renderRow(g.from, node.items[g.from], valueIndex));
        } else {
          box.appendChild(el("div", {
            class: "pe-row pe-nullrun",
            text: g.from + "–" + g.to + "  (" + g.count + "× null)"
          }));
        }
      } else {
        box.appendChild(renderRow(g.key, g.node, valueIndex));
      }
    }
    details.appendChild(box);
    return details;
  }

  function injectStyles() {
    if (document.getElementById("pe-styles")) return;
    const style = document.createElement("style");
    style.id = "pe-styles";
    style.textContent = `
      .pe-tree { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; line-height: 1.6; }
      .pe-meta { margin-bottom: 10px; }
      .pe-warn { color: #a15c00; }
      .pe-node { margin-left: 12px; }
      .pe-summary { cursor: pointer; color: #444; }
      .pe-summary:hover { color: #000; }
      .pe-children { margin-left: 4px; border-left: 1px dashed #ccc; padding-left: 10px; }
      .pe-row { display: flex; gap: 6px; align-items: baseline; }
      .pe-index { color: #999; min-width: 62px; flex-shrink: 0; }
      .pe-null { color: #bbb; font-style: italic; }
      .pe-nullrun { color: #bbb; font-style: italic; padding: 2px 0; }
      .pe-value.pe-string { color: #0a6b2d; }
      .pe-value.pe-number { color: #1b5fbd; }
      .pe-value.pe-boolean { color: #a0522d; }
      .pe-leaf-wrap { display: inline-flex; align-items: center; gap: 3px; }
      .pe-linkable { cursor: pointer; border-bottom: 1px dotted currentColor; }
      .pe-badge { font-size: 10px; color: #fff; background: #888; border-radius: 8px; padding: 0 5px; }
      .pe-link-active { background: #fff2a8 !important; outline: 1px solid #e0c200; border-radius: 2px; }
      .pe-raw { white-space: pre-wrap; word-break: break-all; color: #a00; }
    `;
    document.head.appendChild(style);
  }

  // Accepts either a raw ParseEngine.parse() result (with .format/.chunks/.data)
  // or a bare annotated node (with .kind) if you want to render a sub-tree.
  function render(parseResult, container) {
    injectStyles();
    container.innerHTML = "";
    container.classList.add("pe-tree");

    if (parseResult && parseResult.kind) {
      const valueIndex = new Map();
      buildValueIndex(parseResult, valueIndex);
      container.appendChild(renderNode(parseResult, null, valueIndex));
      return;
    }

    if (!parseResult || !parseResult.format) {
      container.appendChild(el("div", { class: "pe-warn", text: "Tidak ada data untuk ditampilkan." }));
      return;
    }

    const meta = el("div", { class: "pe-meta" });
    meta.appendChild(el("div", {}, [
      el("strong", { text: "Format: " }),
      document.createTextNode(parseResult.format)
    ]));
    if (parseResult.antiHijackPrefixDetected) {
      meta.appendChild(el("div", { text: "Prefix )]}' terdeteksi dan dibuang." }));
    }
    if (parseResult.unassignedTokens && parseResult.unassignedTokens.length) {
      meta.appendChild(el("div", {
        class: "pe-warn",
        text: parseResult.unassignedTokens.length + " token tidak masuk framing (lihat unassignedTokens di hasil JSON)."
      }));
    }
    container.appendChild(meta);

    const valueIndex = new Map();

    if (parseResult.chunks) {
      parseResult.chunks.forEach((c) => buildValueIndex(c.data, valueIndex));
      parseResult.chunks.forEach((c) => {
        const wrap = el("details", { class: "pe-node", open: true });
        const statusNote = c.status === "ok" ? "" : " [" + c.status + "]";
        wrap.appendChild(el("summary", {
          class: "pe-summary",
          text: "Chunk " + c.index + statusNote + " — " + c.actualLength + " karakter"
        }));
        if (c.data) {
          wrap.appendChild(renderNode(c.data, null, valueIndex));
        } else if (c.rawPreview) {
          wrap.appendChild(el("pre", { class: "pe-raw", text: c.rawPreview }));
        }
        container.appendChild(wrap);
      });
      return;
    }

    if (parseResult.data) {
      buildValueIndex(parseResult.data, valueIndex);
      container.appendChild(renderNode(parseResult.data, null, valueIndex));
    } else if (parseResult.rawPreview) {
      container.appendChild(el("pre", { class: "pe-raw", text: parseResult.rawPreview }));
    }
  }

  return { render };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ParseRenderer;
}