/**
 * Pure provider-configuration predicate shared by server gates and tests.
 * A URL alone is not an authentication credential and must not make the AI
 * pipeline appear configured.
 */
export type AiProviderEnvironment = Record<string, string | null | undefined>;

export function hasConfiguredAiProvider(env: AiProviderEnvironment): boolean {
  const openAiKey = env["OPENAI_API_KEY"]?.trim();
  const omniRouteKey = env["OMNIROUTE_API_KEY"]?.trim();
  const openRouterKey = env["OPENROUTER_API_KEY"]?.trim();
  const openRouterModel = env["OPENROUTER_MODEL"]?.trim();
  // Direct NVIDIA is a one-shot independent route using the configured model
  // or the server's safe default model tier.
  const nvidiaKey = env["NVIDIA_API_KEY"]?.trim();

  return Boolean(openAiKey || omniRouteKey || nvidiaKey || (openRouterKey && openRouterModel));
}
