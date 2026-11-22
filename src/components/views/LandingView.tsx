import React, { useState } from "react";
import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { PromptBox, type PromptBoxSubmitOptions } from "../ui/chatgpt-prompt-input";
import { DotPattern } from "../ui/dot-pattern";
import type { ComposerDrafts } from "../../services/composerDrafts";
import type { LandingBackground } from "../../services/displayPreferences";
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
  background?: LandingBackground;
  draftStore?: ComposerDrafts;
  draftKey?: string;
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
  background = "paths",
  draftStore,
  draftKey,
}) => {
  const reduceMotion = useReducedMotion();
  const isPresent = useIsPresent();
  const [isComposerExpanded, setIsComposerExpanded] = useState(false);
  return (
    <div
      className="landing-screen"
      inert={!isPresent}
    >
      <div className="landing-center-content">
        <div className="landing-title-space">
          <div className="landing-title-container">
            {background === "dots" && (
              <div className="landing-title-dot-pattern" aria-hidden="true">
                {/* Wide spacing keeps the dots as a quiet texture rather than a grid. */}
                <DotPattern width={24} height={24} cr={1} />
              </div>
            )}
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
        </div>
        <div className="landing-composer">
          <PromptBox
            layoutId="conversation-composer"
            expandDelay={TITLE_EXIT_DURATION}
            onExpandedChange={setIsComposerExpanded}
            repository={repository}
            draftStore={draftStore}
            draftKey={draftKey}
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
    </div>
  );
});

LandingView.displayName = "LandingView";
