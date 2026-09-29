// ae run --diff: compare two project snapshots written by AE._snapshot (items, then per comp and per layer the dump
// lines) and print what the script changed.

interface CompBlock {
  header: string;
  markers: string[];
  layers: Map<string, string[]>; // layer key (id, or name on old AE) -> dump lines
}

export interface Snapshot {
  items: string[];
  comps: Map<string, CompBlock>; // comp id -> block
}

export function parseSnapshot(text: string): Snapshot {
  const snap: Snapshot = { items: [], comps: new Map() };
  let comp: CompBlock | null = null;
  let layer: string[] | null = null;
  let inItems = false;
  for (const line of text.split("\n")) {
    if (line === "@I") {
      inItems = true;
    } else if (line.startsWith("@C ")) {
      inItems = false;
      const sp = line.indexOf(" ", 3);
      comp = { header: line.slice(sp + 1), markers: [], layers: new Map() };
      snap.comps.set(line.slice(3, sp), comp);
      layer = null;
    } else if (line.startsWith("@L ") && comp) {
      let key = line.slice(3);
      while (comp.layers.has(key)) key += "'"; // two layers with the same name on AE without Layer.id
      layer = [];
      comp.layers.set(key, layer);
    } else if (inItems) {
      if (line) snap.items.push(line);
    } else if (layer) {
      layer.push(line);
    } else if (comp && line.startsWith("marker ")) {
      comp.markers.push(line);
    }
  }
  return snap;
}

/** Lines only in `a` ("-") and only in `b` ("+"), in order (longest common subsequence). */
export function lineDiff(a: string[], b: string[]): string[] {
  if (a.length * b.length > 4_000_000) {
    const sa = new Set(a);
    const sb = new Set(b);
    return [...a.filter((l) => !sb.has(l)).map((l) => "- " + l), ...b.filter((l) => !sa.has(l)).map((l) => "+ " + l)];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const res: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) res.push("- " + a[i++]);
    else res.push("+ " + b[j++]);
  }
  while (i < n) res.push("- " + a[i++]);
  while (j < m) res.push("+ " + b[j++]);
  return res;
}

const compName = (header: string) => /^COMP ('.*?') id=/.exec(header)?.[1] ?? header;

/** Human-readable changes from `before` to `after`; empty when nothing changed. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  const items = lineDiff(before.items, after.items);
  if (items.length) out.push("project items:", ...items.map((l) => "  " + l));
  for (const [id, a] of before.comps) {
    if (!after.comps.has(id)) out.push(`- comp ${compName(a.header)} id=${id} (removed, ${a.layers.size} layers)`);
  }
  for (const [id, b] of after.comps) {
    const a = before.comps.get(id);
    if (!a) {
      out.push(`+ comp ${compName(b.header)} id=${id} (new)`);
      for (const lines of b.layers.values()) out.push("    + " + lines[0].trim());
      continue;
    }
    const body: string[] = [];
    if (a.header !== b.header) body.push("  - " + a.header, "  + " + b.header);
    for (const l of lineDiff(a.markers, b.markers)) body.push("  " + l);
    for (const [key, la] of a.layers) if (!b.layers.has(key)) body.push("  - " + la[0].trim() + "  (removed)");
    const moved: string[] = [];
    for (const [key, lb] of b.layers) {
      const la = a.layers.get(key);
      if (!la) {
        body.push("  + " + lb[0].trim() + "  (new)");
        continue;
      }
      // the index changes whenever a layer above is added or removed: diff without it, list moves on one line
      const ia = /^#(\d+) /.exec(la[0])?.[1];
      const ib = /^#(\d+) /.exec(lb[0])?.[1];
      const d = lineDiff([la[0].replace(/^#\d+ /, ""), ...la.slice(1)], [lb[0].replace(/^#\d+ /, ""), ...lb.slice(1)]);
      if (ia !== ib) moved.push(`${/^#\d+ ('.*?') \[/.exec(lb[0])?.[1] ?? key} #${ia}->#${ib}`);
      if (!d.length) continue;
      body.push("  ~ " + lb[0].trim());
      for (const l of d) body.push("      " + l.slice(0, 2) + l.slice(2).trim());
    }
    if (moved.length) body.push("  layer order: " + moved.join(", "));
    if (body.length) out.push(`comp ${compName(b.header)} id=${id}:`, ...body);
  }
  return out;
}
