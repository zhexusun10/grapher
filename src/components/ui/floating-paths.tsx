"use client";

import React from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export function FloatingPathsBackground({
  position,
  children,
  className,
}: {
  position: number;
  className?: string;
  children: React.ReactNode;
}) {
  const paths = React.useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    id: i,
    d: `M-${380 - i * 5 * position} -${189 + i * 6}C-${380 - i * 5 * position
      } -${189 + i * 6} -${312 - i * 5 * position} ${216 - i * 6} ${152 - i * 5 * position
      } ${343 - i * 6}C${616 - i * 5 * position} ${470 - i * 6} ${684 - i * 5 * position
      } ${875 - i * 6} ${684 - i * 5 * position} ${875 - i * 6}`,
    color: `rgba(15,23,42,0.6)`,
    width: 1.1 + (i % 3) * 0.15,
    duration: 10 + Math.random() * 5,
  })), [position]);

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
            <motion.path
              key={path.id}
              d={path.d}
              stroke="currentColor"
              strokeWidth={path.width}
              strokeOpacity={0.8}
              strokeLinecap="round"
              initial={{ pathLength: 0.3, pathOffset: 0, opacity: 0.6 }}
              animate={{
                pathLength: [0.3, 0.3, 0.3, 0.3],
                pathOffset: [0, 0.08, 0.92, 1],
                opacity: [0.6, 0.6, 0.6, 0.6],
              }}
              transition={{
                duration: path.duration,
                times: [0, 0.08, 0.92, 1],
                repeat: Number.POSITIVE_INFINITY,
                repeatType: "reverse",
                ease: "linear",
              }}
            />
          ))}
        </svg>
      </div>
      {children}
    </div>
  );
}
