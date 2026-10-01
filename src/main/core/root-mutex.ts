const queues = new Map<string, Promise<void>>();

export async function withRootMutex<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  queues.set(key, next);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === next) queues.delete(key);
  }
}
