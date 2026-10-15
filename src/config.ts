export type CacheTtlMode = "auto" | "off" | "5m" | "1h";
export type ToolSchemaShape = "nested" | "flat";

export interface Config {
  host: string;
  port: number;
  glooBaseUrl: string;
  glooTokenUrl: string;
  glooModelsUrl: string;
  glooApiKey: string | undefined;
  glooClientId: string | undefined;
  glooClientSecret: string | undefined;
  proxyAuthToken: string | undefined;
  modelMap: Record<string, string>;
  defaultModel: string | undefined;
  cacheTtl: CacheTtlMode;
  forwardReasoning: boolean;
  toolSchema: ToolSchemaShape;
  debug: boolean;
}

function str(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseModelMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GLOO_MODEL_MAP is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("GLOO_MODEL_MAP must be a JSON object of { requestedId: glooId }");
  }
  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`GLOO_MODEL_MAP["${key}"] must be a string`);
    map[key] = value;
  }
  return map;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cacheTtl = (str(env, "GLOO_CACHE_TTL") ?? "auto").toLowerCase();
  if (!["auto", "off", "5m", "1h"].includes(cacheTtl)) {
    throw new Error(`GLOO_CACHE_TTL must be one of auto, off, 5m, 1h (got "${cacheTtl}")`);
  }
  const toolSchema = (str(env, "GLOO_TOOL_SCHEMA") ?? "nested").toLowerCase();
  if (toolSchema !== "nested" && toolSchema !== "flat") {
    throw new Error(`GLOO_TOOL_SCHEMA must be "nested" or "flat" (got "${toolSchema}")`);
  }
  const origin = (str(env, "GLOO_ORIGIN") ?? "https://platform.ai.gloo.com").replace(/\/+$/, "");

  return {
    host: str(env, "HOST") ?? "127.0.0.1",
    port: Number(str(env, "PORT") ?? 9797),
    glooBaseUrl: (str(env, "GLOO_BASE_URL") ?? `${origin}/ai/v2/direct`).replace(/\/+$/, ""),
    glooTokenUrl: str(env, "GLOO_TOKEN_URL") ?? `${origin}/oauth2/token`,
    glooModelsUrl: str(env, "GLOO_MODELS_URL") ?? `${origin}/platform/v2/models`,
    glooApiKey: str(env, "GLOO_API_KEY"),
    glooClientId: str(env, "GLOO_CLIENT_ID", "GLOO_AI_CLIENT_ID"),
    glooClientSecret: str(env, "GLOO_CLIENT_SECRET", "GLOO_AI_CLIENT_SECRET"),
    proxyAuthToken: str(env, "PROXY_AUTH_TOKEN"),
    modelMap: parseModelMap(str(env, "GLOO_MODEL_MAP")),
    defaultModel: str(env, "GLOO_DEFAULT_MODEL"),
    cacheTtl: cacheTtl as CacheTtlMode,
    forwardReasoning: bool(str(env, "GLOO_FORWARD_REASONING"), true),
    toolSchema: toolSchema as ToolSchemaShape,
    debug: bool(str(env, "GLOO_PROXY_DEBUG"), false),
  };
}
