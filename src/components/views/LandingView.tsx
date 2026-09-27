import React from "react";
import { motion } from "motion/react";
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
  return (
    <motion.div
      className="landing-screen"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        y: -16,
        transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] },
      }}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="landing-center-content">
        <motion.div
          className="landing-title-container"
          exit={{
            opacity: 0,
            y: -14,
            transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
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
            The Most Elegant Multi-Agent Architecture Ever
          </motion.p>
        </motion.div>
        <motion.div
          style={{ width: "100%", position: "relative" }}
          exit={{
            opacity: 0,
            scale: 0.98,
            y: -6,
            transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
          }}
        >
          <PromptBox
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
        </motion.div>
      </div>
    </motion.div>
  );
});

LandingView.displayName = "LandingView";
