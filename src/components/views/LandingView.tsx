import React, { useState } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import type { PlanMode } from "../../types";

interface LandingViewProps {
  goal: string;
  setGoal: (val: string) => void;
  onPlanGoal: (val: string, options?: PromptBoxSubmitOptions) => boolean | void | Promise<boolean>;
  isBusy: boolean;
  planMode?: PlanMode;
  onPlanModeChange?: (mode: PlanMode) => void;
  isWorking?: boolean;
  onInterrupt?: () => void;
  repository?: string;
}

const TITLE_EXIT_DURATION = 0.2;

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
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  return (
    <motion.div
      className="landing-screen"
      inert={!isPresent}
      // Fading this ancestor also fades the shared composer after its handoff.
      // Keep it opaque and animate only the welcome copy below.
      initial={false}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0 }}
    >
      <div className="landing-center-content">
        <div className="landing-title-container">
          <motion.div
            className="landing-title-copy"
            initial={false}
            animate={{
              opacity: isComposerExpanded ? 0 : 1,
              y: reduceMotion || !isComposerExpanded ? 0 : -14,
              visibility: isComposerExpanded ? "hidden" : "visible",
            }}
            transition={{
              opacity: { duration: reduceMotion ? 0 : TITLE_EXIT_DURATION },
              y: { duration: reduceMotion ? 0 : TITLE_EXIT_DURATION },
              visibility: { duration: 0, delay: !reduceMotion && isComposerExpanded ? TITLE_EXIT_DURATION : 0 },
            }}
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
              transition={{ duration: reduceMotion ? 0 : 0.25 }}
            >
              Build Anything
            </motion.p>
            <motion.p
              className="landing-title"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reduceMotion ? 0 : 0.25, delay: reduceMotion ? 0 : 0.05 }}
            >
              With Grapher.
            </motion.p>
            <motion.p
              className="landing-subtitle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: reduceMotion ? 0 : 0.25, delay: reduceMotion ? 0 : 0.1 }}
            >
              Don't orchestrate agents. Compile work.
            </motion.p>
          </motion.div>
        </div>
        <div style={{ width: "100%", position: "relative", flexShrink: 0 }}>
          <PromptBox
            layoutId="conversation-composer"
            expandDelay={TITLE_EXIT_DURATION}
            onExpandedChange={setIsComposerExpanded}
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
