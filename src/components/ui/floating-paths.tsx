"use client";

import React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

interface PathData {
  id: number;
  d: string;
  width: number;
  duration: number;
  firstDuration: number;
}

const FloatingPathItem = React.memo(function FloatingPathItem({ path }: { path: PathData }) {
  const [isFirstRound, setIsFirstRound] = React.useState(true);

  return (
    <motion.path
      d={path.d}
      stroke="currentColor"
      strokeWidth={path.width}
      strokeOpacity={0.8}
      strokeLinecap="round"
      initial={isFirstRound ? { pathLength: 0.3, pathOffset: 0, opacity: 0.6 } : false}
      animate={
        isFirstRound
          ? {
              pathLength: [0.3, 0.3, 0.3, 0.3],
              pathOffset: [0, 0.08, 0.92, 1],
              opacity: [0.6, 0.6, 0.6, 0.6],
            }
          : {
              pathLength: [0.3, 0.3, 0.3, 0.3],
              pathOffset: [1, 0.92, 0.08, 0],
              opacity: [0.6, 0.6, 0.6, 0.6],
            }
      }
      transition={
        isFirstRound
          ? {
              duration: path.firstDuration,
              times: [0, 0.08, 0.92, 1],
              ease: "linear",
            }
          : {
              duration: path.duration,
              times: [0, 0.08, 0.92, 1],
              repeat: Number.POSITIVE_INFINITY,
              repeatType: "reverse",
              ease: "linear",
            }
      }
      onAnimationComplete={() => {
        if (isFirstRound) {
          setIsFirstRound(false);
        }
      }}
    />
  );
});

export function FloatingPathsBackground({
  position,
  children,
  className,
}: {
  position: number;
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
            <FloatingPathItem key={path.id} path={path} />
          ))}
        </svg>
      </div>
      {children}
    </div>
  );
}
