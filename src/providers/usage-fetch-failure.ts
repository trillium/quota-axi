import type { ProviderQuota } from "../types.js";

const USAGE_FETCH_FAILURE = Symbol("usageFetchFailure");

type UsageFetchFailureEvidence = ProviderQuota & {
  [USAGE_FETCH_FAILURE]?: true;
};

export function withUsageFetchFailure(provider: ProviderQuota): ProviderQuota {
  const evidence: UsageFetchFailureEvidence = {
    ...provider,
    [USAGE_FETCH_FAILURE]: true,
  };
  return evidence;
}

export function isUsageFetchFailure(provider: ProviderQuota): boolean {
  return (provider as UsageFetchFailureEvidence)[USAGE_FETCH_FAILURE] === true;
}
