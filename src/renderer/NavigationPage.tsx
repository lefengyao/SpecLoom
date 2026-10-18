import { useEffect, useState, type ReactNode } from "react";

/** Load each page on its first visit, then retain drafts and live subscriptions. */
export function NavigationPage({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  useEffect(() => { if (active) setVisited(true); }, [active]);
  if (!active && !visited) return null;
  return <div className="navigation-page" hidden={!active} inert={!active}>{children}</div>;
}
