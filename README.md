# Parser

A small browser-based toolkit for reverse-engineering **undocumented, deeply-nested wire formats** — the kind of positional, key-less JSON-in-JSON responses APIs return when there's no public schema to go by.

It was built and tested against Google's internal `batchexecute` RPC format (the one behind Google Maps, e.g. `MapsUgcPostService.ListUgcPosts`), but the parsing engine itself is generic and not hardcoded to that API — it should work on any similarly-framed nested array/JSON payload.

No build step, no dependencies. Open `index.html` in a browser and paste a raw response body in.

## What it does

1. **Strips the anti-hijacking prefix** (`)]}'`) that these APIs prepend to stop naive JSON evaluation.
2. **Splits length-prefixed chunks** — the wire format writes a decimal byte-length on its own line, then exactly that many characters of JSON, repeated. The engine uses bracket-balanced scanning (not just the declared length) to find each chunk's real boundaries, so nesting can't get corrupted even when byte-length vs. character-length disagree on non-ASCII text.
3. **Auto-expands double-encoded JSON** — these APIs often embed a whole second JSON document as a string inside the first. The engine detects any string that looks like JSON and recursively decodes it, generically, without hardcoding which field that is.
4. **Annotates every value** in the tree with what it is: a positional array item, a real keyed field, or a plain scalar — and labels array items with a full hierarchical path (`1`, `1.1`, `1.1.2`, ...) instead of a flat per-array index, so you always know exactly where a value sits in the tree, however deep.
5. **Repairs truncated/unbalanced input** where possible (missing closing brackets/quotes) instead of just throwing, and preserves anything that doesn't fit the expected framing rather than silently dropping it.
6. **Renders the result two ways:**
   - An **interactive, collapsible tree** with long runs of `null` collapsed into a single line, and repeated values (IDs, coordinates, etc.) underlined and clickable — click one and every other occurrence highlights, so you can spot how pieces of data connect to each other.
   - The **raw annotated JSON**, for copying, diffing, or feeding into other tools.
7. **Download the parsed result** as a `.json` file.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page layout — input box, sample loader, parse button, both result views |
| `js/parse_engine.js` | The parsing/annotation engine (`ParseEngine`) — framework-agnostic, no DOM dependencies |
| `js/render_tree.js` | The interactive tree renderer (`ParseRenderer`) — builds the collapsible/linkable view |
| `js/parse.js` | Wires the UI together: reads input, calls the engine, displays/downloads results |

## Status

Work in progress / personal reverse-engineering tool — not an official API client for any of the services it happens to parse.

---

Built with the help of [Claude](https://claude.ai) (Anthropic).
