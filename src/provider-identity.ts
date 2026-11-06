/** Internal inert host identity, deliberately outside registered provider-ID syntax. */
export const UNCONFIGURED_PROVIDER_ID = "__xiu_unconfigured__";
export const UNCONFIGURED_PROVIDER_MODEL = "unconfigured";

export function isUnconfiguredProvider(providerId: string | undefined): boolean {
  return providerId === UNCONFIGURED_PROVIDER_ID;
}
