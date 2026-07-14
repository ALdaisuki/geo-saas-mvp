import type { PublicationJobState } from "@geo/contracts";

import { invariant } from "./errors.js";
import { freezeDeep } from "./validation.js";

export type PublicationEvent =
  | "dispatch_started"
  | "dispatch_confirmed"
  | "dispatch_preview_completed"
  | "dispatch_retryable_failure"
  | "dispatch_permanent_failure"
  | "dispatch_uncertain"
  | "retry_due"
  | "reconcile_started"
  | "reconcile_confirmed"
  | "reconcile_not_found"
  | "reconcile_inconclusive"
  | "manual_confirmed"
  | "manual_retry"
  | "manual_failure"
  | "cancel";

export interface PublicationTransition {
  readonly from: PublicationJobState;
  readonly event: PublicationEvent;
  readonly to: PublicationJobState;
  readonly requiresReconcile: boolean;
  readonly terminal: boolean;
}

const TERMINAL_STATES = new Set<PublicationJobState>([
  "preview_completed",
  "confirmed",
  "permanent_failure",
  "cancelled",
]);

const TRANSITIONS: Readonly<
  Partial<
    Record<PublicationJobState, Readonly<Partial<Record<PublicationEvent, PublicationJobState>>>>
  >
> = {
  queued: {
    dispatch_started: "dispatching",
    cancel: "cancelled",
  },
  dispatching: {
    dispatch_preview_completed: "preview_completed",
    dispatch_confirmed: "confirmed",
    dispatch_retryable_failure: "retry_wait",
    dispatch_permanent_failure: "permanent_failure",
    dispatch_uncertain: "uncertain",
  },
  retry_wait: {
    retry_due: "dispatching",
    cancel: "cancelled",
  },
  uncertain: {
    reconcile_started: "reconciling",
  },
  reconciling: {
    reconcile_confirmed: "confirmed",
    reconcile_not_found: "retry_wait",
    reconcile_inconclusive: "needs_review",
  },
  needs_review: {
    manual_confirmed: "confirmed",
    manual_retry: "retry_wait",
    manual_failure: "permanent_failure",
    cancel: "cancelled",
  },
};

export function isTerminalPublicationState(state: PublicationJobState): boolean {
  return TERMINAL_STATES.has(state);
}

export function transitionPublicationState(
  from: PublicationJobState,
  event: PublicationEvent,
): Readonly<PublicationTransition> {
  invariant(
    !isTerminalPublicationState(from),
    "PUBLICATION_STATE_TERMINAL",
    `Publication state ${from} is terminal`,
    { from, event },
  );
  const to = TRANSITIONS[from]?.[event];
  invariant(
    to !== undefined,
    "INVALID_PUBLICATION_TRANSITION",
    `Event ${event} is not valid from ${from}`,
    { from, event },
  );
  return freezeDeep({
    from,
    event,
    to,
    requiresReconcile: to === "uncertain" || to === "reconciling",
    terminal: isTerminalPublicationState(to),
  });
}
