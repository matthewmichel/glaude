import type { Config } from "./config.ts";

export interface GlooModel {
  id: string;
  name?: string;
  provider_id?: string;
  context_window?: number;
  max_output_tokens?: number;
}

const CATALOG_TTL_MS = 10 * 60_000;

/**
 * Normalizes an Anthropic/OpenRouter-style Claude id to Gloo's naming:
 *   claude-sonnet-4-6            -> gloo-anthropic-claude-sonnet-4.6
 *   claude-haiku-4-5-20251001    -> gloo-anthropic-claude-haiku-4.5
 *   anthropic/claude-sonnet-5    -> gloo-anthropic-claude-sonnet-5
 *   claude-opus-4-1[1m]          -> gloo-anthropic-claude-opus-4.1
 * Returns undefined for ids that are not recognizably Claude.
 */
export function claudeToGlooId(requested: string): string | undefined {
  let id = requested.trim().toLowerCase();
  id = id.replace(/\[[^\]]*\]$/, "");
  id = id.replace(/^anthropic[/.]/, "");
  id = id.replace(/-latest$/, "");
  id = id.replace(/-\d{8}$/, "");
  id = id.replace(/@\d{8}$/, "");
  if (!id.startsWith("claude-")) return undefined;
  id = id.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return `gloo-anthropic-${id}`;
}

export class ModelResolver {
  private config: Config;
  private catalog: GlooModel[] | undefined;
  private catalogFetchedAt = 0;

  constructor(config: Config) {
    this.config = config;
  }

  async loadCatalog(force = false): Promise<GlooModel[]> {
    if (!force && this.catalog && Date.now() - this.catalogFetchedAt < CATALOG_TTL_MS) return this.catalog;
    try {
      const res = await fetch(this.config.glooModelsUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { data?: GlooModel[] };
      this.catalog = body.data ?? [];
      this.catalogFetchedAt = Date.now();
    } catch (err) {
      if (!this.catalog) {
        console.warn(`[models] could not load Gloo catalog (${(err as Error).message}); skipping id validation`);
        this.catalog = [];
      }
    }
    return this.catalog;
  }

  /** Maps a client-requested model id to the Gloo id to send upstream. */
  async resolve(requested: string | undefined): Promise<string> {
    const { modelMap, defaultModel } = this.config;
    if (!requested) {
      if (defaultModel) return defaultModel;
      throw new Error("Request has no model and GLOO_DEFAULT_MODEL is not set");
    }
    const override = modelMap[requested];
    if (override) return override;
    if (requested.startsWith("gloo-")) return requested;

    const catalog = await this.loadCatalog();
    const known = new Set(catalog.map((m) => m.id));
    const candidates = [claudeToGlooId(requested), mappedOpenRouterId(requested)].filter(
      (c): c is string => Boolean(c),
    );
    for (const candidate of candidates) {
      if (known.size === 0 || known.has(candidate)) return candidate;
    }
    if (defaultModel) {
      console.warn(`[models] "${requested}" has no Gloo equivalent; using GLOO_DEFAULT_MODEL=${defaultModel}`);
      return defaultModel;
    }
    return candidates[0] ?? requested;
  }
}

/** `openai/gpt-5` -> `gloo-openai-gpt-5`, matching Gloo's `gloo-<provider>-<model>` scheme. */
function mappedOpenRouterId(requested: string): string | undefined {
  const match = /^([a-z0-9-]+)\/(.+)$/i.exec(requested.trim());
  if (!match) return undefined;
  return `gloo-${match[1]!.toLowerCase()}-${match[2]!.toLowerCase()}`;
}
