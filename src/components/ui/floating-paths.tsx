"use client";

import React from "react";
import { cn } from "@/lib/utils";
import "./floating-paths.css";

interface PathData {
  id: number;
  d: string;
  width: number;
  duration: number;
  firstDuration: number;
}

const FloatingPathItem = React.memo(function FloatingPathItem({ path, active }: { path: PathData; active: boolean }) {
  const [isFirstRound, setIsFirstRound] = React.useState(true);

  return (
    <path
      className={`floating-path ${isFirstRound ? "floating-path-enter" : "floating-path-loop"}`}
      d={path.d}
      stroke="currentColor"
      strokeWidth={path.width}
      strokeOpacity={0.8}
      strokeLinecap="round"
      pathLength={1}
      strokeDasharray="0.3 1"
      strokeDashoffset={0}
      opacity={0.6}
      // Native playback freezes the current position without a JS animation loop.
      style={{
        animationDuration: `${isFirstRound ? path.firstDuration : path.duration}s`,
        animationPlayState: active ? "running" : "paused",
      }}
      onAnimationEnd={() => {
        if (isFirstRound) setIsFirstRound(false);
      }}
    />
  );
});

export function FloatingPathsBackground({
  position,
  active,
  children,
  className,
}: {
  position: number;
  active: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const paths = React.useMemo(() => Array.from({ length: 36 }, (_, i) => {
    const normalDuration = 10 + Math.random() * 5;
    return {
      id: i,
      d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position
        } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${152 - i * 5 * position
        } ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${684 - i * 5 * position
        } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
      color: `rgba(15,23,42,0.6)`,
      width: 1.1 + (i % 3) * 0.15,
      duration: normalDuration,
      firstDuration: normalDuration * 0.8,
    };
  }), [position]);

  return (
    <div className={cn("w-full relative", className)}>
      <div className="absolute inset-0 pointer-events-none">
        <svg
          className="w-full h-full text-slate-950 dark:text-white"
          viewBox="0 0 696 316"
          fill="none"
          style={{ overflow: "visible" }}
        >
          {paths.map((path) => (
            <FloatingPathItem key={path.id} path={path} active={active} />
          ))}
        </svg>
      </div>
      {children}
    </div>
  );
}
