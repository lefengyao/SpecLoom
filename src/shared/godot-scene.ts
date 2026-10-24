/**
 * Minimal Godot 4 text-scene reader: extracts the node paths a `.tscn` defines.
 *
 * Only the `[node ...]` sections matter for spec validation, so this deliberately
 * skips resources, connections and properties. Paths are returned without a
 * leading slash and use `/` separators, matching how anchors declare `node`.
 */
export function sceneNodePaths(text: string): Set<string> {
  const nodes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[node ")) continue;
    const attributes = parseAttributes(trimmed.slice("[node ".length, trimmed.lastIndexOf("]")));
    const name = attributes.get("name");
    if (!name) continue;
    const parent = attributes.get("parent");
    if (parent === undefined) { nodes.add(""); continue; }
    const base = parent === "." ? "" : parent.replace(/\/+$/, "");
    nodes.add(base ? `${base}/${name}` : name);
  }
  return nodes;
}

/** True when the file looks like a Godot text scene at all (header + at least one node). */
export function looksLikeScene(text: string): boolean {
  return /^\s*\[gd_scene\b/m.test(text) && sceneNodePaths(text).size > 0;
}

function parseAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|[^\s\]]+)/g;
  for (const match of source.matchAll(pattern)) {
    const value = match[2]!;
    attributes.set(match[1]!, value.startsWith('"') ? value.slice(1, -1).replace(/\\(.)/g, "$1") : value);
  }
  return attributes;
}
