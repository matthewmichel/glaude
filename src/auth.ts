import type { Config } from "./config.ts";

export type AuthMode = "api-key" | "oauth" | "passthrough";

interface CachedToken {
  value: string;
  expiresAt: number;
}

const REFRESH_MARGIN_MS = 120_000;

/** Resolves the bearer token sent to Gloo for a given inbound request. */
export class UpstreamAuth {
  readonly mode: AuthMode;
  private config: Config;
  private cached: CachedToken | undefined;
  private inflight: Promise<CachedToken> | undefined;

  constructor(config: Config) {
    this.config = config;
    if (config.glooApiKey) this.mode = "api-key";
    else if (config.glooClientId && config.glooClientSecret) this.mode = "oauth";
    else this.mode = "passthrough";
  }

  /** `clientToken` is the token the caller presented (only used in passthrough mode). */
  async token(clientToken: string | undefined): Promise<string> {
    if (this.mode === "api-key") return this.config.glooApiKey!;
    if (this.mode === "passthrough") {
      if (!clientToken) {
        throw new AuthError(
          "No Gloo credentials configured on the proxy and none supplied by the client. " +
            "Set GLOO_API_KEY (or GLOO_CLIENT_ID/GLOO_CLIENT_SECRET) for the proxy, or send a Gloo key as the bearer token.",
        );
      }
      return clientToken;
    }
    if (this.cached && this.cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.cached.value;
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    this.cached = await this.inflight;
    return this.cached.value;
  }

  /** Drop a cached OAuth token after Gloo rejects it so the next call re-mints. */
  invalidate(): void {
    this.cached = undefined;
  }

  private async fetchToken(): Promise<CachedToken> {
    const { glooClientId, glooClientSecret, glooTokenUrl } = this.config;
    const basic = Buffer.from(`${glooClientId}:${glooClientSecret}`).toString("base64");
    const res = await fetch(glooTokenUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=api/access",
    });
    const text = await res.text();
    if (!res.ok) throw new AuthError(`Gloo token exchange failed (HTTP ${res.status}): ${text.slice(0, 500)}`);
    const data = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!data.access_token) throw new AuthError("Gloo token exchange returned no access_token");
    return { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 };
  }
}

export class AuthError extends Error {}
