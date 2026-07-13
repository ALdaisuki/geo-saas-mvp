import { canonicalJson, sha256Canonical } from "@geo/core";

export { canonicalJson };

export function stableSha256(value: unknown): string {
  return sha256Canonical(value);
}
