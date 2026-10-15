#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import http from "node:http";
import { Readable } from "node:stream";
import type { MessagesRequest, StreamEvent } from "./anthropic-types.ts";
import { AuthError, UpstreamAuth } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import { ModelResolver } from "./models.ts";
import { GlooEventNormalizer, restoreNamespaces, sanitizeResponsesRequest } from "./responses-sanitize.ts";
import { formatSse, parseSse } from "./sse.ts";
import { translateRequest } from "./translate-request.ts";
import { MessageAccumulator, ResponsesToMessagesTranslator } from "./translate-stream.ts";

const PING_INTERVAL_MS = 10_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ProxyContext {
  config: Config;
  auth: UpstreamAuth;
  models: ModelResolver;
}

class HttpError extends Error {
  status: number;
  errorType: string;
  constructor(status: number, errorType: string, message: string) {
    super(message);
    this.status = status;
    this.errorType = errorType;
  }
}

export function createProxyServer(ctx: ProxyContext): http.Server {
  return http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    route(ctx, req, res, url)
      .catch((err) => {
        const status = err instanceof HttpError ? err.status : err instanceof AuthError ? 401 : 500;
        const type = err instanceof HttpError ? err.errorType : err instanceof AuthError ? "authentication_error" : "api_error";
        if (!(err instanceof HttpError)) console.error(`[proxy] ${req.method} ${url.pathname} failed:`, err);
        if (!res.headersSent) sendJson(res, status, anthropicError(type, (err as Error).message));
        else res.end();
      })
      .finally(() => {
        if (ctx.config.debug || url.pathname !== "/health") {
          console.log(`[proxy] ${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`);
        }
      });
  });
}

async function route(ctx: ProxyContext, req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if ((req.method === "GET" || req.method === "HEAD") && (path === "/" || path === "/health")) {
    return sendJson(res, 200, { ok: true, upstream: ctx.config.glooBaseUrl, auth: ctx.auth.mode });
  }

  const clientToken = checkClientAuth(ctx, req);

  if (req.method === "POST" && path === "/v1/messages") return handleMessages(ctx, req, res, clientToken);
  if (req.method === "POST" && path === "/v1/messages/count_tokens") return handleCountTokens(req, res);
  if (req.method === "GET" && path === "/v1/models") return handleListModels(ctx, res);
  if (req.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
    return handleResponsesPassthrough(ctx, req, res, clientToken);
  }

  throw new HttpError(404, "not_found_error", `No route for ${req.method} ${url.pathname}`);
}

function inboundToken(req: http.IncomingMessage): string | undefined {
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey) return apiKey;
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim() || undefined;
  return undefined;
}

function checkClientAuth(ctx: ProxyContext, req: http.IncomingMessage): string | undefined {
  const token = inboundToken(req);
  const expected = ctx.config.proxyAuthToken;
  if (expected && token !== expected) {
    throw new HttpError(401, "authentication_error", "Invalid proxy token (PROXY_AUTH_TOKEN)");
  }
  return expected ? undefined : token;
}

async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request_too_large", "Request body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid_request_error", "Request body is not valid JSON");
  }
}

/** POSTs to Gloo, re-minting the OAuth token once if Gloo rejects it. */
async function callGloo(
  ctx: ProxyContext,
  path: string,
  body: unknown,
  clientToken: string | undefined,
  extraHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  const send = async () =>
    fetch(`${ctx.config.glooBaseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await ctx.auth.token(clientToken)}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream, application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal,
    });
  let res: Response;
  try {
    res = await send();
    if (res.status === 401 && ctx.auth.mode === "oauth") {
      await res.body?.cancel();
      ctx.auth.invalidate();
      res = await send();
    }
  } catch (err) {
    if (signal.aborted) throw err;
    throw new HttpError(502, "api_error", `Could not reach Gloo: ${(err as Error).message}`);
  }
  return res;
}

async function handleMessages(
  ctx: ProxyContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientToken: string | undefined,
): Promise<void> {
  const body = await readJson<MessagesRequest>(req);
  if (!Array.isArray(body.messages)) throw new HttpError(400, "invalid_request_error", "messages: Field required");

  const glooModel = await ctx.models.resolve(body.model);
  const translated = translateRequest(body, glooModel, ctx.config);
  const headers: Record<string, string> = {};
  if (translated.cacheTtl) headers["X-Cache-TTL"] = translated.cacheTtl;

  console.log(
    `[proxy] messages model=${body.model} -> ${glooModel} stream=${Boolean(body.stream)} ` +
      `items=${translated.body.input.length} tools=${translated.body.tools?.length ?? 0}` +
      (translated.cacheTtl ? ` cache=${translated.cacheTtl}` : "") +
      (translated.droppedTools.length ? ` dropped_server_tools=${translated.droppedTools.join(",")}` : ""),
  );
  if (ctx.config.debug) {
    const { messages: _messages, system: _system, tools: _tools, ...rest } = body;
    console.error(`[debug] anthropic-beta=${req.headers["anthropic-beta"] ?? ""} params:`, JSON.stringify(rest));
    console.error("[debug] gloo request:", JSON.stringify(translated.body, truncateLongStrings));
  }

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });

  const upstream = await callGloo(ctx, "/responses", translated.body, clientToken, headers, abort.signal);
  if (!upstream.ok) {
    const text = await upstream.text();
    if (ctx.config.debug) console.error(`[debug] gloo error ${upstream.status}: ${text}`);
    const mapped = mapUpstreamError(upstream.status, text);
    return sendJson(res, mapped.status, anthropicError(mapped.type, mapped.message));
  }

  const stream = Boolean(body.stream);
  const accumulator = new MessageAccumulator();
  let pinger: NodeJS.Timeout | undefined;

  const emit = (event: StreamEvent) => {
    if (ctx.config.debug) console.error("[debug] ->", JSON.stringify(event));
    if (event.type === "error") console.warn(`[proxy] stream error (${event.error.type}): ${event.error.message}`);
    if (stream) res.write(formatSse(event.type, event));
    else accumulator.apply(event);
  };
  const translator = new ResponsesToMessagesTranslator(body.model, emit);

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    pinger = setInterval(() => res.write(formatSse("ping", { type: "ping" })), PING_INTERVAL_MS);
  }

  try {
    const contentType = upstream.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      replayResponseObject(translator, (await upstream.json()) as Record<string, any>);
    } else if (upstream.body) {
      for await (const message of parseSse(upstream.body as AsyncIterable<Uint8Array>)) {
        if (ctx.config.debug) console.error(`[debug] <- ${message.event ?? ""} ${message.data.slice(0, 2000)}`);
        if (!message.data || message.data === "[DONE]") continue;
        let data: Record<string, any>;
        try {
          data = JSON.parse(message.data);
        } catch {
          continue;
        }
        translator.handle(message.event, data);
        if (translator.finished) break;
      }
    }
    translator.end();
  } catch (err) {
    if (abort.signal.aborted) return;
    translator.fail(`Gloo stream failed: ${(err as Error).message}`);
  } finally {
    if (pinger) clearInterval(pinger);
  }

  const usage = translator.finalUsage;
  console.log(
    `[proxy] usage in=${usage.input_tokens} cache_read=${usage.cache_read_input_tokens} ` +
      `cache_write=${usage.cache_creation_input_tokens} out=${usage.output_tokens}`,
  );

  if (stream) {
    res.end();
    return;
  }
  if (accumulator.error || !accumulator.message) {
    const error = accumulator.error ?? { type: "api_error", message: "Empty response from Gloo" };
    return sendJson(res, error.type === "invalid_request_error" ? 400 : 502, anthropicError(error.type, error.message));
  }
  return sendJson(res, 200, accumulator.message);
}

/** Feeds a non-streaming Responses object through the stream translator. */
function replayResponseObject(translator: ResponsesToMessagesTranslator, response: Record<string, any>): void {
  translator.handle("response.created", { type: "response.created", response });
  for (const [index, item] of (response.output ?? []).entries()) {
    translator.handle("response.output_item.done", { type: "response.output_item.done", output_index: index, item });
  }
  const terminal = response.status === "incomplete" ? "response.incomplete" : "response.completed";
  translator.handle(terminal, { type: terminal, response });
}

async function handleCountTokens(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJson<MessagesRequest>(req);
  // Gloo has no token-counting endpoint; ~4 characters per token is close enough for context budgeting.
  const chars = JSON.stringify([body.system ?? "", body.messages ?? [], body.tools ?? []]).length;
  return sendJson(res, 200, { input_tokens: Math.ceil(chars / 4) });
}

async function handleListModels(ctx: ProxyContext, res: http.ServerResponse): Promise<void> {
  const catalog = await ctx.models.loadCatalog();
  const data = catalog.map((m) => ({
    type: "model",
    id: m.id,
    object: "model",
    display_name: m.name ?? m.id,
    owned_by: "gloo",
    created_at: "1970-01-01T00:00:00Z",
  }));
  return sendJson(res, 200, {
    object: "list",
    data,
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
  });
}

/**
 * Codex-facing Responses passthrough: maps the model id, rewrites tools into what Gloo accepts,
 * refuses `previous_response_id` (unsupported by Gloo), and handles auth.
 */
async function handleResponsesPassthrough(
  ctx: ProxyContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  clientToken: string | undefined,
): Promise<void> {
  const body = await readJson<Record<string, any>>(req);
  if (body.previous_response_id) {
    return sendJson(res, 400, {
      error: {
        type: "invalid_request_error",
        code: "unsupported_parameter",
        message: "Gloo does not support previous_response_id; resend the full input each turn.",
      },
    });
  }
  const { body: sanitized, namespaced, dropped } = sanitizeResponsesRequest(body);
  const requested = sanitized.model;
  sanitized.model = await ctx.models.resolve(requested);
  console.log(
    `[proxy] responses model=${requested} -> ${sanitized.model} stream=${Boolean(sanitized.stream)} ` +
      `tools=${sanitized.tools?.length ?? 0}` +
      (namespaced.size ? ` flattened=${namespaced.size}` : "") +
      (dropped.length ? ` dropped_tools=${dropped.join(",")}` : ""),
  );
  if (ctx.config.debug) console.error("[debug] responses request:", JSON.stringify(sanitized, truncateLongStrings));

  const headers: Record<string, string> = {};
  const cacheTtl = req.headers["x-cache-ttl"];
  if (typeof cacheTtl === "string") headers["X-Cache-TTL"] = cacheTtl;

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) abort.abort();
  });
  const upstream = await callGloo(ctx, "/responses", sanitized, clientToken, headers, abort.signal);
  const contentType = upstream.headers.get("content-type") ?? "application/json";
  res.writeHead(upstream.status, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  if (!upstream.body) return void res.end();

  try {
    if (!upstream.ok) {
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(upstream.body as any).on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
      });
    } else if (contentType.includes("text/event-stream")) {
      const normalizer = new GlooEventNormalizer();
      for await (const message of parseSse(upstream.body as AsyncIterable<Uint8Array>)) {
        let data: Record<string, any>;
        try {
          data = normalizer.normalize(JSON.parse(message.data));
        } catch {
          res.write(`${message.event ? `event: ${message.event}\n` : ""}data: ${message.data}\n\n`);
          continue;
        }
        restoreNamespaces(data, namespaced);
        if (ctx.config.debug) console.error(`[debug] responses <- ${JSON.stringify(data).slice(0, 600)}`);
        res.write(formatSse(message.event ?? data.type ?? "message", data));
      }
      res.end();
    } else {
      const data = await upstream.json();
      restoreNamespaces(data, namespaced);
      res.end(JSON.stringify(data));
    }
  } catch (err) {
    if (!abort.signal.aborted) throw err;
  }
}

function mapUpstreamError(status: number, text: string): { status: number; type: string; message: string } {
  let message = text.slice(0, 2000) || `Gloo returned HTTP ${status}`;
  try {
    const parsed = JSON.parse(text);
    const detail = parsed.detail ?? parsed.error ?? parsed;
    message = typeof detail === "string" ? detail : detail.message ?? message;
  } catch {
    // keep raw text
  }
  // Claude Code triggers auto-compaction on Anthropic's "prompt is too long" wording.
  if (/context (window|length)|too many tokens|prompt is too long|maximum context/i.test(message)) {
    return { status: 400, type: "invalid_request_error", message: `prompt is too long: ${message}` };
  }
  const type =
    status === 400 || status === 422
      ? "invalid_request_error"
      : status === 401
        ? "authentication_error"
        : status === 403
          ? "permission_error"
          : status === 404
            ? "not_found_error"
            : status === 413
              ? "request_too_large"
              : status === 429
                ? "rate_limit_error"
                : status === 503 || status === 529
                  ? "overloaded_error"
                  : "api_error";
  return { status: status === 422 ? 400 : status, type, message: `Gloo: ${message}` };
}

function anthropicError(type: string, message: string) {
  return { type: "error", error: { type, message } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function truncateLongStrings(_key: string, value: unknown): unknown {
  return typeof value === "string" && value.length > 500 ? `${value.slice(0, 500)}…(${value.length} chars)` : value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx: ProxyContext = { config, auth: new UpstreamAuth(config), models: new ModelResolver(config) };
  void ctx.models.loadCatalog();

  const server = createProxyServer(ctx);
  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(err.code === "EADDRINUSE" ? `[proxy] port ${config.port} is already in use` : err);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    const origin = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`;
    console.log(`[proxy] listening on ${origin} -> ${config.glooBaseUrl} (auth: ${ctx.auth.mode})`);
    const token =
      ctx.auth.mode === "passthrough" ? "<your Gloo API key>" : config.proxyAuthToken ? "<PROXY_AUTH_TOKEN>" : "local";
    console.log(`[proxy] Claude Code: ANTHROPIC_BASE_URL=${origin} ANTHROPIC_AUTH_TOKEN=${token} claude`);
    console.log(`[proxy] Codex:       base_url = "${origin}/v1", wire_api = "responses"`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      server.closeAllConnections();
      server.close(() => process.exit(0));
    });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
