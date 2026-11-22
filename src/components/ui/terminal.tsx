"use client";

import {
  Children,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefAttributes,
} from "react";
import {
  motion,
  useInView,
  type DOMMotionComponents,
  type HTMLMotionProps,
  type MotionProps,
} from "motion/react";

import { cn } from "@/lib/utils";

interface SequenceContextValue {
  completeItem: (index: number) => void;
  activeIndex: number;
  sequenceStarted: boolean;
}

const SequenceContext = createContext<SequenceContextValue | null>(null);

const useSequence = () => useContext(SequenceContext);

const ItemIndexContext = createContext<number | null>(null);
const useItemIndex = () => useContext(ItemIndexContext);

const motionElements = {
  article: motion.article,
  div: motion.div,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  h4: motion.h4,
  h5: motion.h5,
  h6: motion.h6,
  li: motion.li,
  p: motion.p,
  section: motion.section,
  span: motion.span,
} as const;

type MotionElementType = Extract<
  keyof DOMMotionComponents,
  keyof typeof motionElements
>;
type TerminalTypingMotionComponent = ComponentType<
  Omit<HTMLMotionProps<"span">, "ref"> & RefAttributes<HTMLElement>
>;

interface AnimatedSpanProps extends MotionProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  startOnView?: boolean;
}

export const AnimatedSpan = ({
  children,
  delay = 0,
  className,
  startOnView = false,
  ...props
}: AnimatedSpanProps) => {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const isInView = useInView(elementRef as React.RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const sequence = useSequence();
  const itemIndex = useItemIndex();
  const [hasStarted, setHasStarted] = useState(false);
  useEffect(() => {
    if (!sequence || itemIndex === null) return;
    if (!sequence.sequenceStarted) return;
    if (hasStarted) return;
    if (sequence.activeIndex === itemIndex) {
      setHasStarted(true);
    }
  }, [sequence, hasStarted, itemIndex]);

  const shouldAnimate = sequence ? hasStarted : startOnView ? isInView : true;

  return (
    <motion.div
      ref={elementRef}
      initial={{ opacity: 0, y: -5 }}
      animate={shouldAnimate ? { opacity: 1, y: 0 } : { opacity: 0, y: -5 }}
      transition={{ duration: 0.3, delay: sequence ? 0 : delay / 1000 }}
      className={cn("grid text-sm font-normal tracking-tight", className)}
      onAnimationComplete={() => {
        if (!sequence) return;
        if (itemIndex === null) return;
        sequence.completeItem(itemIndex);
      }}
      {...props}
    >
      {children}
    </motion.div>
  );
};

interface TypingAnimationProps extends Omit<MotionProps, "children"> {
  children: string;
  className?: string;
  duration?: number;
  delay?: number;
  as?: MotionElementType;
  startOnView?: boolean;
}

export const TypingAnimation = ({
  children,
  className,
  duration = 60,
  delay = 0,
  as: Component = "span",
  startOnView = true,
  ...props
}: TypingAnimationProps) => {
  if (typeof children !== "string") {
    throw new Error("TypingAnimation: children must be a string. Received:");
  }

  const MotionComponent = motionElements[
    Component
  ] as TerminalTypingMotionComponent;

  const [displayedText, setDisplayedText] = useState<string>("");
  const [started, setStarted] = useState(false);
  const elementRef = useRef<HTMLElement | null>(null);
  const isInView = useInView(elementRef as React.RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const sequence = useSequence();
  const itemIndex = useItemIndex();
  const hasSequence = sequence !== null;
  const sequenceStarted = sequence?.sequenceStarted ?? false;
  const sequenceActiveIndex = sequence?.activeIndex ?? null;
  const sequenceCompleteItemRef = useRef<
    SequenceContextValue["completeItem"] | null
  >(null);
  const sequenceItemIndexRef = useRef<number | null>(null);

  useEffect(() => {
    sequenceCompleteItemRef.current = sequence?.completeItem ?? null;
    sequenceItemIndexRef.current = itemIndex;
  }, [sequence?.completeItem, itemIndex]);

  useEffect(() => {
    let startTimeout: ReturnType<typeof setTimeout> | null = null;

    if (hasSequence && itemIndex !== null) {
      if (sequenceStarted && !started && sequenceActiveIndex === itemIndex) {
        setStarted(true);
      }
    } else if (!startOnView || isInView) {
      startTimeout = setTimeout(() => setStarted(true), delay);
    }

    return () => {
      if (startTimeout !== null) {
        clearTimeout(startTimeout);
      }
    };
  }, [
    delay,
    startOnView,
    isInView,
    started,
    hasSequence,
    sequenceActiveIndex,
    sequenceStarted,
    itemIndex,
  ]);

  useEffect(() => {
    let typingEffect: ReturnType<typeof setInterval> | null = null;

    if (started) {
      let i = 0;
      typingEffect = setInterval(() => {
        if (i < children.length) {
          setDisplayedText(children.substring(0, i + 1));
          i++;
        } else {
          if (typingEffect !== null) {
            clearInterval(typingEffect);
          }
          const completeItem = sequenceCompleteItemRef.current;
          const currentItemIndex = sequenceItemIndexRef.current;
          if (completeItem && currentItemIndex !== null) {
            completeItem(currentItemIndex);
          }
        }
      }, duration);
    }

    return () => {
      if (typingEffect !== null) {
        clearInterval(typingEffect);
      }
    };
  }, [children, duration, started]);

  return (
    <MotionComponent
      ref={elementRef}
      className={cn("text-sm font-normal tracking-tight", className)}
      {...props}
    >
      {displayedText}
    </MotionComponent>
  );
};

export interface TerminalProps {
  children: React.ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  headerContent?: React.ReactNode;
  topSlot?: React.ReactNode;
  cardRef?: React.Ref<HTMLDivElement>;
  sequence?: boolean;
  startOnView?: boolean;
  rawBody?: boolean;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  isMaximized?: boolean;
  closeLabel?: string;
  minimizeLabel?: string;
  maximizeLabel?: string;
  "data-testid"?: string;
}

export const Terminal = ({
  children,
  className,
  headerClassName,
  bodyClassName,
  headerContent,
  topSlot,
  cardRef,
  sequence = true,
  startOnView = true,
  rawBody = false,
  onClose,
  onMinimize,
  onMaximize,
  isMaximized = false,
  closeLabel = "Close terminal",
  minimizeLabel = "Minimize terminal",
  maximizeLabel = "Toggle maximize terminal",
  "data-testid": dataTestId,
}: TerminalProps) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const assignContainerRef = (node: HTMLDivElement | null) => {
    containerRef.current = node;
    if (typeof cardRef === "function") {
      cardRef(node);
    } else if (cardRef && "current" in cardRef) {
      (cardRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  };
  const isInView = useInView(containerRef as React.RefObject<Element>, {
    amount: 0.3,
    once: true,
  });

  const [activeIndex, setActiveIndex] = useState(0);
  const sequenceHasStarted = sequence ? !startOnView || isInView : false;

  const contextValue = useMemo<SequenceContextValue | null>(() => {
    if (!sequence) return null;
    return {
      completeItem: (index: number) => {
        setActiveIndex((current) =>
          index === current ? current + 1 : current,
        );
      },
      activeIndex,
      sequenceStarted: sequenceHasStarted,
    };
  }, [sequence, activeIndex, sequenceHasStarted]);

  const wrappedChildren = useMemo(() => {
    if (!sequence) return children;
    const array = Children.toArray(children);
    return array.map((child, index) => (
      <ItemIndexContext.Provider key={index} value={index}>
        {child as React.ReactNode}
      </ItemIndexContext.Provider>
    ));
  }, [children, sequence]);

  const hasWindowControls = Boolean(onClose || onMinimize || onMaximize);

  const content = (
    <div
      ref={assignContainerRef}
      data-testid={dataTestId}
      className={cn(
        "border-border bg-background z-0 h-full max-h-100 w-full max-w-lg rounded-xl border",
        className,
      )}
    >
      {topSlot}
      <div
        className={cn(
          "border-border flex flex-col gap-y-2 border-b p-4",
          headerClassName,
        )}
      >
        <div className="flex flex-row items-center justify-between gap-x-3">
          {hasWindowControls ? (
            <div className="terminal-traffic-lights" role="group">
              <button
                type="button"
                className="terminal-traffic-btn is-close"
                onClick={onClose}
                disabled={!onClose}
                aria-label={closeLabel}
                title={closeLabel}
                data-terminal-action="close"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3.5 3.5l5 5M8.5 3.5l-5 5"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="terminal-traffic-btn is-minimize"
                onClick={onMinimize}
                disabled={!onMinimize}
                aria-label={minimizeLabel}
                title={minimizeLabel}
                data-terminal-action="minimize"
              >
                <svg viewBox="0 0 12 12" aria-hidden="true">
                  <path
                    d="M3 6h6"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
              <button
                type="button"
                className="terminal-traffic-btn is-maximize"
                onClick={onMaximize}
                disabled={!onMaximize}
                aria-label={maximizeLabel}
                aria-pressed={isMaximized}
                title={maximizeLabel}
                data-terminal-action="maximize"
              >
                {isMaximized ? (
                  <svg viewBox="0 0 12 12" aria-hidden="true" data-traffic-glyph="restore">
                    <path d="M6.4 5.6H9.7L6.4 2.3Z" fill="currentColor" />
                    <path d="M5.6 6.4H2.3L5.6 9.7Z" fill="currentColor" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 12 12" aria-hidden="true" data-traffic-glyph="expand">
                    <path d="M3 4V9H8Z" fill="currentColor" />
                    <path d="M9 8V3H4Z" fill="currentColor" />
                  </svg>
                )}
              </button>
            </div>
          ) : (
            <div className="flex flex-row gap-x-2">
              <div className="h-2 w-2 rounded-full bg-red-500"></div>
              <div className="h-2 w-2 rounded-full bg-yellow-500"></div>
              <div className="h-2 w-2 rounded-full bg-green-500"></div>
            </div>
          )}
          {headerContent}
        </div>
      </div>
      {rawBody ? (
        <div className={cn("min-h-0 flex-1 overflow-hidden", bodyClassName)}>
          {wrappedChildren}
        </div>
      ) : (
        <pre className={cn("p-4", bodyClassName)}>
          <code className="grid gap-y-1 overflow-auto">{wrappedChildren}</code>
        </pre>
      )}
    </div>
  );

  if (!sequence) return content;

  return (
    <SequenceContext.Provider value={contextValue}>
      {content}
    </SequenceContext.Provider>
  );
};

export default Terminal;
