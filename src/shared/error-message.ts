/** Handles native errors and the cloned error records returned through Electron's bridge. */
export function errorMessage(error: unknown): string {
  const value = error as { message?: unknown } | null | undefined;
  return typeof value?.message === "string" ? value.message : String(error);
}
