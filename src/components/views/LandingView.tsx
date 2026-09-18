import React from "react";
import { motion } from "motion/react";
import { PromptBox } from "../ui/chatgpt-prompt-input";

interface LandingViewProps {
  goal: string;
  setGoal: (val: string) => void;
  onPlanGoal: (val: string) => void;
  isBusy: boolean;
}

export const LandingView: React.FC<LandingViewProps> = React.memo(({
  goal,
  setGoal,
  onPlanGoal,
  isBusy,
}) => {
  return (
    <motion.div
      key="landing-screen"
      className="landing-screen"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{
        opacity: 0,
        y: -8,
        transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
      }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="landing-center-content">
        <div className="landing-title-container">
          <motion.p
            className="landing-title"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            Build Anything.
          </motion.p>
          <motion.p
            className="landing-subtitle"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            The Most Powerful Multi-Agent System Ever
          </motion.p>
        </div>
        <div style={{ width: "100%", position: "relative" }}>
          <PromptBox
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onSubmit={(val) => onPlanGoal(val)}
            isBusy={isBusy}
            placeholder=""
          />
        </div>
      </div>
    </motion.div>
  );
});

LandingView.displayName = "LandingView";
