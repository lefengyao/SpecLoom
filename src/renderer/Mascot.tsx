import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

export const ORBIT_PRESETS = {
  thread: { label: "线团", rx: 72, ry: 44, depth: 0.18, tilt: -12 },
  wide: { label: "宽摆", rx: 84, ry: 52, depth: 0.2, tilt: -22 },
  tall: { label: "高抛", rx: 54, ry: 66, depth: 0.22, tilt: -8 },
} as const;

export type OrbitPreset = keyof typeof ORBIT_PRESETS;

export interface MascotProps {
  size?: number;
  className?: string;
  /** Draws a matte thread ball orbiting the sprite in 3D; pass a preset name to choose its path. */
  orbit?: boolean | OrbitPreset;
  /** Makes the pupil follow the pointer while the component is mounted. */
  trackPointer?: boolean;
}

const TRAIL = [
  { className: "mascot-orbit-trail-1", r: 5.8, opacity: 0.85 },
  { className: "mascot-orbit-trail-2", r: 4.8, opacity: 0.7 },
  { className: "mascot-orbit-trail-3", r: 3.8, opacity: 0.5 },
  { className: "mascot-orbit-trail-4", r: 2.8, opacity: 0.3 },
] as const;

/**
 * 络络 / THREAD SPRITE. The SVG is decorative; the visible name is rendered as text
 * beside it. Animation lives in styles.css and is disabled by reduced-motion rules.
 */
export function Mascot({
  size = 144,
  className = "",
  orbit = false,
  trackPointer = false,
}: MascotProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const eyeId = `mascot-eye-${uid}`;
  const clipId = `mascot-clip-${uid}`;
  const spriteRef = useRef<SVGSVGElement>(null);
  const [idle, setIdle] = useState(true);
  const presetName: OrbitPreset = typeof orbit === "string" ? orbit : "thread";
  const preset = ORBIT_PRESETS[presetName];
  const orbitVisible = orbit !== false;

  useEffect(() => {
    if (!trackPointer) return;
    const sprite = spriteRef.current;
    if (!sprite || typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(pointer: fine)");
    if (reduce.matches || !fine.matches) return;

    let frame = 0;
    const reset = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      sprite.style.setProperty("--look-x", "0px");
      sprite.style.setProperty("--look-y", "0px");
      setIdle(true);
    };
    const move = (event: PointerEvent) => {
      if (frame) return;
      setIdle(false);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const rect = sprite.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const dx = Math.max(-1, Math.min(1, (event.clientX - cx) / (rect.width * 1.4)));
        const dy = Math.max(-1, Math.min(1, (event.clientY - cy) / (rect.height * 1.4)));
        // The sprite group is rotated 180deg, so invert the local pupil translation.
        // The pupil sits left of the eye-hole centre, so it has more room to the right.
        const lookX = Math.max(-20, Math.min(3, -dx * 20));
        sprite.style.setProperty("--look-x", `${lookX.toFixed(1)}px`);
        sprite.style.setProperty("--look-y", `${(-dy * 2.6).toFixed(1)}px`);
      });
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerleave", reset);
    window.addEventListener("blur", reset);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerleave", reset);
      window.removeEventListener("blur", reset);
    };
  }, [trackPointer]);

  const classes = ["mascot", className, idle ? "is-idle" : ""].filter(Boolean).join(" ");
  const orbitStyle = orbitVisible
    ? ({
        "--orbit-rx": `${preset.rx}px`,
        "--orbit-ry": `${preset.ry}px`,
        "--orbit-depth": `${preset.depth}`,
      } as CSSProperties)
    : undefined;

  const orbitBalls = (
    <>
      {TRAIL.map((trail) => (
        <g key={trail.className} className={`mascot-orbit-body mascot-orbit-trail ${trail.className}`}>
          <circle className="mascot-trail-dot" r={trail.r} opacity={trail.opacity} />
        </g>
      ))}
      <g className="mascot-orbit-body mascot-orbit-lead">
        <circle className="mascot-ball" r="9" />
      </g>
    </>
  );

  return (
    <svg
      ref={spriteRef}
      className={classes}
      width={size}
      height={size}
      viewBox={orbitVisible ? "-30 -30 220 220" : "0 0 160 160"}
      style={orbitStyle}
      data-orbit-preset={orbitVisible ? presetName : undefined}
      role="presentation"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <mask id={eyeId} maskUnits="userSpaceOnUse" x="0" y="0" width="160" height="160">
          <rect width="160" height="160" fill="white" />
          <rect className="mascot-eye-hole" x="34" y="64" width="47" height="33" rx="16.5" fill="black" />
          <path className="mascot-mouth" d="M33 50c7-9 18-13 29-11" fill="none" stroke="black" strokeWidth="6" strokeLinecap="round" />
        </mask>
        <clipPath id={clipId}>
          <rect className="mascot-eye-clip" x="34" y="64" width="47" height="33" rx="16.5" />
        </clipPath>
      </defs>
      {orbitVisible && (
        <g
          key={`${presetName}-back`}
          className="mascot-orbit-plane"
          transform={`rotate(${preset.tilt} 80 80)`}
          aria-hidden="true"
        >
          <ellipse className="mascot-orbit-track" cx="80" cy="80" rx={preset.rx} ry={preset.ry} />
          <g className="mascot-orbit-layer mascot-orbit-back">{orbitBalls}</g>
        </g>
      )}
      <g className="mascot-bob">
        <g transform="translate(-17 0) rotate(180 80 80)">
          <path
            d="M65 25c28 0 48 21 48 49 0 15-6 29-17 38l-3 16c-1 7-10 9-15 4l-6-7H49l-6 7c-5 5-14 3-15-4l-2-18C17 100 13 88 13 74c0-28 22-49 52-49z"
            fill="#239d7c"
            mask={`url(#${eyeId})`}
          />
          <g clipPath={`url(#${clipId})`}>
            <rect className="mascot-pupil" x="60" y="68" width="12" height="25" rx="6" fill="#254438" />
          </g>
        </g>
      </g>
      {orbitVisible && (
        <g
          key={`${presetName}-front`}
          className="mascot-orbit-plane"
          transform={`rotate(${preset.tilt} 80 80)`}
          aria-hidden="true"
        >
          <path
            className="mascot-orbit-track mascot-orbit-track-front"
            d={`M ${80 - preset.rx} 80 A ${preset.rx} ${preset.ry} 0 0 0 ${80 + preset.rx} 80`}
          />
          <g className="mascot-orbit-layer mascot-orbit-front">{orbitBalls}</g>
        </g>
      )}
    </svg>
  );
}
