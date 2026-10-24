export type DiffLineKind = "added" | "removed" | "hunk" | "meta" | "context";

// Longest first: file headers (`+++ b/x`, `--- a/x`) must win over the single-character diff markers.
const metaPrefixes = [
  "diff --git ", "index ", "new file mode ", "deleted file mode ", "old mode ", "new mode ",
  "similarity index ", "dissimilarity index ", "rename from ", "rename to ", "copy from ", "copy to ",
  "Binary files ", "\\ No newline",
];

/** Classify one line of `git diff --no-color` output for colouring. */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith("+++ ") || line.startsWith("--- ")) return "meta";
  if (metaPrefixes.some((prefix) => line.startsWith(prefix))) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

/** Render a raw diff as one coloured block per line, keeping monospace wrapping and copyability. */
export function GitDiff({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return <pre className="git-diff-body">{lines.map((line, index) => <span key={index} className={`git-diff-line ${diffLineKind(line)}`}>{line}</span>)}</pre>;
}
