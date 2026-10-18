/** The host supplies an absolute project path; normalize equivalent Windows spellings for storage. */
export function canonicalProjectPreferencePath(projectPath: string): string {
  const slashes = projectPath.replaceAll("\\", "/");
  const windows = /^[a-z]:\//i.test(slashes) || slashes.startsWith("//");
  const prefix = slashes.startsWith("//") ? "//" : slashes.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  for (const segment of slashes.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > 1) segments.pop();
    else if (segment !== "..") segments.push(segment);
  }
  const path = prefix + segments.join("/");
  return windows ? path.toLowerCase() : path;
}

function importPreferenceKey(projectPath: string): string {
  return `specloom.project-files.hide-import:${canonicalProjectPreferencePath(projectPath)}`;
}
export function readHideImportPreference(projectPath: string): boolean {
  try { return window.localStorage.getItem(importPreferenceKey(projectPath)) === "true"; }
  catch { return false; }
}
export function writeHideImportPreference(projectPath: string, hide: boolean): void {
  try { window.localStorage.setItem(importPreferenceKey(projectPath), String(hide)); }
  catch { /* Local UI state remains authoritative when storage is unavailable. */ }
}
export function isImportFile(path: string): boolean { return path.toLowerCase().endsWith(".import"); }
