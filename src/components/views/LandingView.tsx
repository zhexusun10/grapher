import React from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import type { PlanMode } from "../../types";

interface LandingViewProps {
  goal: string;
  setGoal: (val: string) => void;
  onPlanGoal: (val: string, options?: PromptBoxSubmitOptions) => void;
  isBusy: boolean;
  planMode?: PlanMode;
  onPlanModeChange?: (mode: PlanMode) => void;
  isWorking?: boolean;
  onInterrupt?: () => void;
  repository?: string;
}

export const LandingView: React.FC<LandingViewProps> = React.memo(({
  goal,
  setGoal,
  onPlanGoal,
  isBusy,
  planMode,
  onPlanModeChange,
  isWorking,
  onInterrupt,
  repository,
}) => {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  return (
    <motion.div
      className="landing-screen"
      inert={!isPresent}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="landing-center-content">
        <motion.div
          className="landing-title-container"
          exit={{
            opacity: 0,
            y: reduceMotion ? 0 : -14,
            transition: { duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] },
          }}
        >
          <motion.p
            className="landing-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
          >
            Build Anything
          </motion.p>
          <motion.p
            className="landing-title"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, delay: 0.05 }}
          >
            With Grapher.
          </motion.p>
          <motion.p
            className="landing-subtitle"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25, delay: 0.1 }}
          >
            Don't orchestrate agents. Compile work.
          </motion.p>
        </motion.div>
        <div style={{ width: "100%", position: "relative", flexShrink: 0 }}>
          <PromptBox
            layoutId="conversation-composer"
            repository={repository}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onSubmit={(val, options) => onPlanGoal(val, options)}
            isBusy={isBusy}
            isWorking={isWorking}
            onInterrupt={onInterrupt}
            planMode={planMode}
            onPlanModeChange={onPlanModeChange}
            placeholder=""
          />
        </div>
      </div>
    </motion.div>
  );
});

LandingView.displayName = "LandingView";
