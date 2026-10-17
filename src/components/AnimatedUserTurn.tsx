import React from "react";
import { motion } from "motion/react";
import { useUserTurnAppear } from "../services/messageAnimations";

/** One-shot entrance for a user turn that was just sent or appended. */
export const AnimatedUserTurn = React.memo(function AnimatedUserTurn({ id, animateAppear, className, children }: {
  id: string; animateAppear?: boolean; className: string; children: React.ReactNode;
}) {
  const appear = useUserTurnAppear(id, animateAppear);
  return <motion.div className={className}
    initial={appear ? { opacity: 0, y: 8, scale: 0.99 } : false}
    animate={{ opacity: 1, y: 0, scale: 1 }}
    transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}>
    {children}
  </motion.div>;
});
