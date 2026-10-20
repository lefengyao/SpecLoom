import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Load each page on its first visit, then retain drafts and live subscriptions.
 *
 * A hidden page keeps the element from its last active render. The parent App
 * re-renders on unrelated state changes (tab switches, toasts, polling), and
 * handing a fresh element to every hidden page would re-reconcile all visited
 * pages each time. Reusing the cached element lets React bail out of those
 * hidden subtrees; the fresh element is used again as soon as the page becomes
 * active, so no visible data is stale.
 */
export function NavigationPage({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  const cached = useRef(children);
  if (active) cached.current = children;
  useEffect(() => { if (active) setVisited(true); }, [active]);
  if (!active && !visited) return null;
  return <div className="navigation-page" hidden={!active} inert={!active}>{active ? children : cached.current}</div>;
}
