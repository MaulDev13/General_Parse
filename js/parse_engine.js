/**
 * ParseEngine
 * -----------
 * A generic toolkit for reverse-engineering undocumented, deeply-nested
 * binary-ish / JSON wire formats — originally built against Google's
 * `batchexecute` RPC framing, but not hardcoded to it.
 *
 * What it does, in order:
 *
 *  1. Strips a leading anti-hijacking prefix like `)]}'` if present.
 *  2. Splits the remainder into "framed chunks": Google's batchexecute wire
 *     format writes a decimal byte-length on its own line, then exactly
 *     that many characters of JSON, repeated. We use the *declared length*
 *     to slice each chunk rather than guessing where the JSON ends — this
 *     is what keeps paired delimiters ([ ], { }) from ever being
 *     mis-matched or merged across chunks.
 *  3. JSON.parse()s each chunk. Values inside that are themselves strings
 *     containing valid JSON (Google double-encodes payloads this way,
 *     e.g. the "wrb.fr" RPC body) are detected generically and expanded
 *     recursively — this isn't special-cased to any one RPC name.
 *  4. Every value in the tree gets classified and labeled:
 *       - arrays with no keys  -> indexed as {"0": ..., "1": ..., ...}
 *       - plain scalars        -> {kind:"value", valueType, value}
 *       - auto-expanded strings -> {kind:"encoded", encoding:"json-string", decoded:...}
 *     so you can always tell "this is positional data" from "this is a leaf value".
 *  5. Anything that doesn't fit the expected framing (stray tokens, text
 *     with no declared length, truncated/unbalanced brackets) is preserved
 *     rather than dropped, and flagged so you can see it was irregular.
 *
 * Output of parse() is a plain JSON-serializable object (safe to pass
 * straight into JSON.stringify()).
 */
const ParseEngine = (function () {

  // ---------------------------------------------------------------------
  // Low-level helpers
  // ---------------------------------------------------------------------

  // Detects and strips Google's `)]}'` anti-JSON-hijacking prefix, if present.
  function detectAntiHijackPrefix(text) {
    const m = /^\)\]\}'\s*/.exec(text);
    if (m) return { prefix: m[0], rest: text.slice(m[0].length) };
    return { prefix: null, rest: text };
  }

  function tryJSON(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // Attempts to repair truncated / unbalanced JSON by closing whatever
  // brackets or quotes were left open, so a partial capture still parses
  // into *something* instead of throwing away the whole chunk.
  // Never invents content — only appends the minimum closers needed.
  function attemptRepair(text) {
    const stack = [];
    let inString = false;
    let quoteChar = null;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quoteChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; continue; }
      if (ch === '[' || ch === '{') { stack.push(ch); continue; }
      if (ch === ']' || ch === '}') {
        const wantsOpen = ch === ']' ? '[' : '{';
        if (stack.length && stack[stack.length - 1] === wantsOpen) stack.pop();
        // an unmatched closer is left as-is; JSON.parse will report it if it matters
      }
    }

    let repaired = text;
    if (inString) repaired += quoteChar;
    for (let i = stack.length - 1; i >= 0; i--) {
      repaired += stack[i] === '[' ? ']' : '}';
    }
    return { repaired, unclosedDelimiters: stack.length, danglingString: inString };
  }

  // ---------------------------------------------------------------------
  // Chunk framing: "<decimal length>\n<exactly that many chars of JSON>"
  // repeated. This is the actual batchexecute wire shape; kept generic
  // (no assumptions about what the JSON contains).
  // ---------------------------------------------------------------------

  // Scans forward from `start` for one complete, bracket-balanced JSON value
  // (an array or object), respecting string/escape state. Returns null if
  // the value never closes (truncated capture) or doesn't start with a
  // bracket. This is the primary mechanism for finding a chunk's real end —
  // more reliable than trusting the declared length literally, because
  // Google's declared length is a *byte* count (UTF-8) while JS string
  // length counts UTF-16 code units, so the two only agree for pure ASCII.
  function scanBalancedValue(text, start) {
    let i = start;
    const len = text.length;
    while (i < len && /\s/.test(text[i])) i++;
    if (i >= len) return null;
    if (text[i] !== '[' && text[i] !== '{') return null;

    let depth = 0;
    let inString = false;
    let quoteChar = null;
    let escaped = false;
    let j = i;

    for (; j < len; j++) {
      const ch = text[j];
      if (inString) {
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === quoteChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; quoteChar = ch; continue; }
      if (ch === '[' || ch === '{') { depth++; continue; }
      if (ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) { j++; break; }
      }
    }

    if (depth !== 0) return null; // truncated: never closed
    return { text: text.slice(i, j), start: i, end: j };
  }

  function splitFramedChunks(text) {
    const chunks = [];
    const unassigned = [];
    let i = 0;
    const len = text.length;

    while (i < len) {
      while (i < len && /\s/.test(text[i])) i++;
      if (i >= len) break;

      const lineMatch = /^(\d+)[ \t]*\r?\n/.exec(text.slice(i));
      if (lineMatch) {
        const declaredLength = parseInt(lineMatch[1], 10);
        const afterLenIdx = i + lineMatch[0].length;

        const balanced = scanBalancedValue(text, afterLenIdx);
        if (balanced) {
          chunks.push({
            declaredLength,
            raw: balanced.text,
            lengthMatch: balanced.text.length === declaredLength
          });
          i = balanced.end;
          continue;
        }

        // Bracket never closed within the remaining text — the capture was
        // cut off mid-chunk. Keep everything that's left as a truncated
        // chunk rather than silently dropping it.
        const rest = text.slice(afterLenIdx);
        if (rest.trim().length) {
          chunks.push({
            declaredLength,
            raw: rest,
            lengthMatch: rest.length === declaredLength,
            truncated: true
          });
        }
        i = len;
        continue;
      }

      // The current line isn't a bare number, so it isn't a length prefix.
      // Record it as an unassigned token and keep scanning — this is where
      // stray text/markers with "no place" in the framing end up.
      const nlIdx = text.indexOf('\n', i);
      const tokenEnd = nlIdx === -1 ? len : nlIdx;
      const token = text.slice(i, tokenEnd).trim();
      if (token.length) unassigned.push(token);
      i = tokenEnd + 1;
    }

    return { chunks, unassigned };
  }

  // ---------------------------------------------------------------------
  // Generic value annotation
  // ---------------------------------------------------------------------

  const MAX_EXPAND_DEPTH = 20; // guards against pathological recursive strings

  function looksLikeJSON(str) {
    if (typeof str !== "string") return false;
    const s = str.trim();
    if (s.length < 2) return false;
    const first = s[0], last = s[s.length - 1];
    return (first === "[" && last === "]") || (first === "{" && last === "}");
  }

  // Turns any already-parsed JS value into a self-describing tree.
  //
  // Array items are keyed by their full hierarchical position from the
  // root — "1", "1.1", "1.1.1", "1.1.2", "1.2", ... — instead of a flat
  // per-array index. That way the key itself tells you exactly where a
  // value sits in the tree (e.g. "1.3.2" is unambiguous on its own),
  // rather than every array restarting at "0" and losing that context
  // once you're several levels deep.
  //
  //  - arrays  -> {kind:"array", length, items:{"1":node,"1.1":node,...}}
  //  - objects -> {kind:"object", fields:{key:node,...}}
  //  - scalars -> {kind:"value", valueType, value}
  //  - strings that are themselves JSON -> {kind:"encoded", ..., decoded:node}
  function annotate(value, depth, path) {
    depth = depth || 0;
    path = path || "";

    if (value === null) {
      return { kind: "value", valueType: "null", value: null };
    }

    if (Array.isArray(value)) {
      const items = {};
      for (let idx = 0; idx < value.length; idx++) {
        const childPath = path ? path + "." + (idx + 1) : String(idx + 1);
        items[childPath] = annotate(value[idx], depth + 1, childPath);
      }
      return { kind: "array", length: value.length, items };
    }

    const t = typeof value;

    if (t === "object") {
      const fields = {};
      for (const k of Object.keys(value)) {
        const childPath = path ? path + "." + k : k;
        fields[k] = annotate(value[k], depth + 1, childPath);
      }
      return { kind: "object", fields };
    }

    if (t === "string") {
      if (depth < MAX_EXPAND_DEPTH && looksLikeJSON(value)) {
        const parsed = tryJSON(value);
        if (parsed.ok) {
          return {
            kind: "encoded",
            encoding: "json-string",
            length: value.length,
            // Decoding is a transparent expansion, not a real nesting step,
            // so it keeps this node's own path rather than adding a level.
            decoded: annotate(parsed.value, depth + 1, path)
          };
        }
        const repair = attemptRepair(value);
        const parsed2 = tryJSON(repair.repaired);
        if (parsed2.ok) {
          return {
            kind: "encoded",
            encoding: "json-string",
            length: value.length,
            repaired: true,
            unclosedDelimiters: repair.unclosedDelimiters,
            decoded: annotate(parsed2.value, depth + 1, path)
          };
        }
        // Looked like JSON, couldn't be salvaged even after repair — keep
        // the raw text rather than losing it.
        return {
          kind: "value",
          valueType: "string",
          value,
          note: "looked like embedded JSON but failed to parse"
        };
      }
      return { kind: "value", valueType: "string", value };
    }

    // number / boolean
    return { kind: "value", valueType: t, value };
  }

  // ---------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------

  function parse(input) {
    if (typeof input !== "string") {
      throw new Error("Input harus berupa teks (string).");
    }
    if (!input.trim()) {
      throw new Error("Input kosong.");
    }

    const { prefix, rest } = detectAntiHijackPrefix(input);
    const { chunks, unassigned } = splitFramedChunks(rest);

    // Nothing matched the length-prefixed framing at all -> fall back to
    // treating the whole body as a single generic JSON document. This
    // keeps the engine useful for formats that AREN'T batchexecute chunks.
    if (chunks.length === 0) {
      const body = rest.trim();
      const whole = tryJSON(body);
      if (whole.ok) {
        return {
          format: "raw-json",
          antiHijackPrefixDetected: !!prefix,
          data: annotate(whole.value)
        };
      }
      const repair = attemptRepair(body);
      const whole2 = tryJSON(repair.repaired);
      return {
        format: whole2.ok ? "raw-json-repaired" : "unparsed",
        antiHijackPrefixDetected: !!prefix,
        unclosedDelimiters: repair.unclosedDelimiters,
        data: whole2.ok ? annotate(whole2.value) : null,
        rawPreview: whole2.ok ? undefined : body.slice(0, 500),
        error: whole2.ok ? undefined : whole.error
      };
    }

    const parsedChunks = chunks.map((c, idx) => {
      const result = tryJSON(c.raw);
      if (result.ok) {
        return {
          index: idx,
          declaredLength: c.declaredLength,
          actualLength: c.raw.length,
          lengthMatch: c.lengthMatch,
          truncated: !!c.truncated,
          status: "ok",
          data: annotate(result.value)
        };
      }
      const repair = attemptRepair(c.raw);
      const result2 = tryJSON(repair.repaired);
      return {
        index: idx,
        declaredLength: c.declaredLength,
        actualLength: c.raw.length,
        lengthMatch: c.lengthMatch,
        truncated: !!c.truncated,
        status: result2.ok ? "repaired" : "unparsed",
        unclosedDelimiters: repair.unclosedDelimiters,
        data: result2.ok ? annotate(result2.value) : null,
        rawPreview: result2.ok ? undefined : c.raw.slice(0, 300),
        error: result2.ok ? undefined : result.error
      };
    });

    return {
      format: "batchexecute",
      antiHijackPrefixDetected: !!prefix,
      chunkCount: parsedChunks.length,
      chunks: parsedChunks,
      unassignedTokens: unassigned
    };
  }

  return {
    parse,
    annotate,
    tryJSON,
    attemptRepair,
    splitFramedChunks,
    detectAntiHijackPrefix
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = ParseEngine;
}