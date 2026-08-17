import type { AutomationBatchItem } from "@geo/contracts";

export interface CtripDistributionInput {
  readonly items: readonly AutomationBatchItem[];
  readonly accountPoolIds: readonly string[];
  readonly startOffset?: number;
}

export function assignRoundRobin({
  items,
  accountPoolIds,
  startOffset = 0,
}: CtripDistributionInput): readonly AutomationBatchItem[] {
  if (accountPoolIds.length === 0) throw new TypeError("Distribution account pool cannot be empty");
  const uniqueAccountIds = new Set(accountPoolIds);
  if (uniqueAccountIds.size !== accountPoolIds.length) {
    throw new TypeError("Distribution account pool must contain unique accounts");
  }
  if (!Number.isSafeInteger(startOffset) || startOffset < 0) {
    throw new TypeError("Distribution start offset must be a non-negative safe integer");
  }
  return items.map((item, index) => ({
    ...item,
    channelAccountIds: [accountPoolIds[(startOffset + index) % accountPoolIds.length] ?? ""],
  }));
}
