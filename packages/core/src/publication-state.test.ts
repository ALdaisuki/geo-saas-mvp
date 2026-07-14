import { describe, expect, it } from "vitest";

import { CoreInvariantError } from "./errors.js";
import { transitionPublicationState } from "./publication-state.js";

describe("publication state transitions", () => {
  it("supports a confirmed dispatch path", () => {
    const dispatching = transitionPublicationState("queued", "dispatch_started");
    const confirmed = transitionPublicationState(dispatching.to, "dispatch_confirmed");

    expect(dispatching).toMatchObject({ from: "queued", to: "dispatching" });
    expect(confirmed).toMatchObject({ to: "confirmed", terminal: true });
  });

  it("records dry-run completion as an unconfirmed terminal preview", () => {
    const dispatching = transitionPublicationState("queued", "dispatch_started");
    const preview = transitionPublicationState(dispatching.to, "dispatch_preview_completed");

    expect(preview).toMatchObject({ to: "preview_completed", terminal: true });
  });

  it("forces an unknown dispatch outcome through reconciliation before retry", () => {
    const uncertain = transitionPublicationState("dispatching", "dispatch_uncertain");

    expect(uncertain).toMatchObject({ to: "uncertain", requiresReconcile: true });
    expect(() => transitionPublicationState("uncertain", "retry_due")).toThrowError(
      expect.objectContaining({ code: "INVALID_PUBLICATION_TRANSITION" }),
    );
    expect(() => transitionPublicationState("uncertain", "dispatch_started")).toThrow(
      CoreInvariantError,
    );

    const reconciling = transitionPublicationState("uncertain", "reconcile_started");
    const notFound = transitionPublicationState(reconciling.to, "reconcile_not_found");
    const retry = transitionPublicationState(notFound.to, "retry_due");

    expect(reconciling.to).toBe("reconciling");
    expect(notFound.to).toBe("retry_wait");
    expect(retry.to).toBe("dispatching");
  });

  it("routes inconclusive reconciliation to manual review", () => {
    expect(transitionPublicationState("reconciling", "reconcile_inconclusive")).toMatchObject({
      to: "needs_review",
      terminal: false,
    });
  });

  it.each(["preview_completed", "confirmed", "permanent_failure", "cancelled"] as const)(
    "does not allow transitions out of terminal state %s",
    (state) => {
      expect(() => transitionPublicationState(state, "cancel")).toThrowError(
        expect.objectContaining({ code: "PUBLICATION_STATE_TERMINAL" }),
      );
    },
  );
});
