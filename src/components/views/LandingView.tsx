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
}) => {
  return (
    <motion.div
      key="landing-screen"
      className="landing-screen"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{
        opacity: 0,
        transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
      }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="landing-center-content">
        <div className="landing-title-container">
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
            The Most Powerful Multi Agent System Ever
          </motion.p>
        </div>
        <div style={{ width: "100%", position: "relative" }}>
          <PromptBox
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
