export const PACKAGE_VERSION = "1.2.0";
export const AGENT_INTENT_VERSION = "1.0" as const;
export const LEGACY_AGENT_INTENT_VERSION = "0.1" as const;
export const SUPPORTED_AGENT_INTENT_VERSIONS = [
  LEGACY_AGENT_INTENT_VERSION,
  AGENT_INTENT_VERSION,
] as const;

export type AgentIntentVersion =
  (typeof SUPPORTED_AGENT_INTENT_VERSIONS)[number];
