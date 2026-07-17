import { ChevronDown } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

import styles from "./ThinkingReasoningShell.module.css";

interface ThinkingReasoningShellProps {
  active: boolean;
  expanded: boolean;
  label: ReactNode;
  accessory?: ReactNode;
  summary: string;
  children: ReactNode;
  viewportRef: Ref<HTMLDivElement>;
  contentRef: Ref<HTMLDivElement>;
  onToggle: () => void;
  onScroll: () => void;
}

/**
 * Adapted from AIcss' free Thinking + Reasoning component.
 * Source: https://www.aicss.dev/components/thinking-reasoning
 */
export function ThinkingReasoningShell({
  active,
  expanded,
  label,
  accessory,
  summary,
  children,
  viewportRef,
  contentRef,
  onToggle,
  onScroll,
}: ThinkingReasoningShellProps) {
  return (
    <div className={styles.root} data-state={active ? "thinking" : "done"}>
      <button
        type="button"
        className={styles.header}
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={summary}
        aria-live={active ? "polite" : undefined}
      >
        <span className={cn(styles.label, active && styles.shimmer)}>{label}</span>
        {accessory ? <span className={styles.accessory}>{accessory}</span> : null}
        <ChevronDown
          className={cn(styles.chevron, expanded && styles.chevronExpanded)}
          strokeWidth={1.8}
          aria-hidden
        />
      </button>

      <div className={cn(styles.collapsible, !expanded && styles.collapsed)}>
        <div className={styles.inner}>
          <div
            ref={viewportRef}
            data-testid={expanded ? "agent-activity-scroll" : undefined}
            onScroll={onScroll}
            className={styles.viewport}
            aria-hidden={!expanded}
          >
            <div ref={contentRef} className={styles.stream}>
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
