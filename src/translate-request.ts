import type { CacheControl, ContentBlock, MessagesRequest, Tool, ToolChoice } from "./anthropic-types.ts";
import type { Config } from "./config.ts";

type InputPart = { cache_control?: { type: "ephemeral" } } & (
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string }
  | { type: "input_file"; file_data?: string; file_url?: string; filename?: string }
);

/** Anthropic allows 4 breakpoints per request; Gloo reserves one for the system prompt. */
const MAX_MESSAGE_BREAKPOINTS = 3;

type InputItem =
  | { role: "user" | "assistant"; content: InputPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string | InputPart[] };

export interface ResponsesRequest {
  model: string;
  input: InputItem[];
  stream: true;
  instructions?: string;
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string[];
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  reasoning?: { effort: "low" | "medium" | "high" };
}

export interface TranslatedRequest {
  body: ResponsesRequest;
  /** Value for Gloo's X-Cache-TTL header (Anthropic prompt caching), if caching should be enabled. */
  cacheTtl: "5m" | "1h" | undefined;
  /** Anthropic server tools (web_search, code_execution, ...) that Gloo cannot run and were removed. */
  droppedTools: string[];
}

export function translateRequest(req: MessagesRequest, glooModel: string, config: Config): TranslatedRequest {
  const cache = new CacheTracker();
  const input: InputItem[] = [];

  for (const message of req.messages ?? []) {
    const blocks: ContentBlock[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
    appendMessage(input, message.role, blocks, cache);
  }

  const body: ResponsesRequest = { model: glooModel, input, stream: true };

  const instructions = systemText(req.system, cache);
  if (instructions) body.instructions = instructions;
  if (req.max_tokens !== undefined) body.max_output_tokens = req.max_tokens;
  if (req.temperature !== undefined) body.temperature = req.temperature;
  if (req.top_p !== undefined) body.top_p = req.top_p;
  if (req.stop_sequences?.length) body.stop = req.stop_sequences;

  const droppedTools: string[] = [];
  if (req.tools?.length) {
    const tools: unknown[] = [];
    for (const tool of req.tools) {
      cache.note(tool.cache_control);
      if (isServerTool(tool)) {
        droppedTools.push(tool.name ?? tool.type ?? "unknown");
        continue;
      }
      tools.push(translateTool(tool, config.toolSchema));
    }
    if (tools.length) body.tools = tools;
  }

  if (body.tools && req.tool_choice) {
    const choice = translateToolChoice(req.tool_choice, config.toolSchema);
    if (choice !== undefined) body.tool_choice = choice;
    if ("disable_parallel_tool_use" in req.tool_choice && req.tool_choice.disable_parallel_tool_use) {
      body.parallel_tool_calls = false;
    }
  }

  if (config.forwardReasoning) {
    const effort = reasoningEffort(req);
    if (effort) body.reasoning = { effort };
  }

  let cacheTtl: "5m" | "1h" | undefined;
  if (config.cacheTtl === "5m" || config.cacheTtl === "1h") cacheTtl = config.cacheTtl;
  else if (config.cacheTtl === "auto") cacheTtl = cache.ttl();
  if (cacheTtl) cache.applyBreakpoints();

  return { body, cacheTtl, droppedTools };
}

function appendMessage(input: InputItem[], role: "user" | "assistant", blocks: ContentBlock[], cache: CacheTracker) {
  let parts: InputPart[] = [];
  // Gloo drops media inside function_call_output, so tool-result images ride in a user message
  // placed after all of this turn's tool outputs.
  const toolMedia: InputPart[] = [];
  const flush = () => {
    if (parts.length) input.push({ role, content: parts });
    parts = [];
  };
  const push = (part: InputPart) => {
    parts.push(part);
    if (role === "user") cache.lastPart = part;
  };

  for (const block of blocks) {
    switch (block.type) {
      case "text": {
        const text = (block as { text: string }).text;
        if (text) push(role === "assistant" ? { type: "output_text", text } : { type: "input_text", text });
        break;
      }
      case "image":
      case "document": {
        const part = mediaPart(block);
        if (part) push(part);
        break;
      }
      case "tool_use": {
        const b = block as { id: string; name: string; input: unknown };
        flush();
        input.push({
          type: "function_call",
          call_id: b.id,
          name: b.name,
          arguments: JSON.stringify(b.input ?? {}),
        });
        break;
      }
      case "tool_result": {
        const b = block as { tool_use_id: string; content?: string | ContentBlock[]; is_error?: boolean };
        flush();
        const { output, media } = toolResultOutput(b, cache);
        input.push({ type: "function_call_output", call_id: b.tool_use_id, output });
        if (media.length) toolMedia.push({ type: "input_text", text: `Attachments from tool result ${b.tool_use_id}:` }, ...media);
        break;
      }
      default:
        // thinking / redacted_thinking cannot be replayed without the provider's signature;
        // server_tool_use and friends have no Responses equivalent.
        break;
    }
    cache.breakpoint((block as { cache_control?: CacheControl }).cache_control);
  }
  parts = [...toolMedia, ...parts];
  flush();
}

function toolResultOutput(
  block: { content?: string | ContentBlock[]; is_error?: boolean },
  cache: CacheTracker,
): { output: string; media: InputPart[] } {
  const prefix = block.is_error ? "[tool error] " : "";
  if (block.content === undefined) return { output: prefix, media: [] };
  if (typeof block.content === "string") return { output: prefix + block.content, media: [] };

  const texts: string[] = [];
  const media: InputPart[] = [];
  for (const inner of block.content) {
    cache.note((inner as { cache_control?: CacheControl }).cache_control);
    if (inner.type === "text") texts.push((inner as { text: string }).text);
    else {
      const part = mediaPart(inner);
      if (part?.type === "input_text") texts.push(part.text);
      else if (part) media.push(part);
    }
  }
  if (media.length) texts.push(`(${media.length} attachment${media.length > 1 ? "s" : ""} follow in the next user message)`);
  return { output: prefix + texts.join("\n"), media };
}

function mediaPart(block: ContentBlock): InputPart | undefined {
  const source = (block as { source?: Record<string, unknown> }).source;
  if (!source) return undefined;
  if (block.type === "image") {
    if (source.type === "base64") return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
    if (source.type === "url") return { type: "input_image", image_url: String(source.url) };
    return undefined;
  }
  const title = (block as { title?: string }).title;
  if (source.type === "text") return { type: "input_text", text: title ? `${title}\n\n${source.data}` : String(source.data) };
  if (source.type === "content") {
    const content = source.content as string | ContentBlock[];
    const text =
      typeof content === "string"
        ? content
        : content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
    return { type: "input_text", text };
  }
  if (source.type === "base64") {
    return { type: "input_file", file_data: `data:${source.media_type};base64,${source.data}`, filename: title ?? "document.pdf" };
  }
  if (source.type === "url") return { type: "input_file", file_url: String(source.url) };
  return undefined;
}

// Gloo discards the whole `instructions` string when it starts with Claude Code's billing header.
const BILLING_HEADER_LINE = /^x-anthropic-billing-header:[^\n]*(\n|$)/gim;

function systemText(system: MessagesRequest["system"], cache: CacheTracker): string | undefined {
  if (!system) return undefined;
  const texts: string[] = [];
  for (const block of typeof system === "string" ? [{ type: "text", text: system }] : system) {
    cache.note((block as { cache_control?: CacheControl }).cache_control);
    if (block.type !== "text") continue;
    const text = (block as { text: string }).text.replace(BILLING_HEADER_LINE, "").trim();
    if (text) texts.push(text);
  }
  return texts.join("\n\n") || undefined;
}

/** Anthropic-hosted tools (web_search_20250305, code_execution_..., etc.) carry a versioned `type`. */
function isServerTool(tool: Tool): boolean {
  return tool.type !== undefined && tool.type !== "custom" && tool.type !== "function";
}

function translateTool(tool: Tool, shape: Config["toolSchema"]): unknown {
  const parameters = { ...(tool.input_schema ?? { type: "object", properties: {} }) };
  delete parameters.$schema;
  const fn = { name: tool.name, description: tool.description ?? "", parameters };
  return shape === "nested" ? { type: "function", function: fn } : { type: "function", ...fn };
}

function translateToolChoice(choice: ToolChoice, shape: Config["toolSchema"]): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return shape === "nested"
        ? { type: "function", function: { name: choice.name } }
        : { type: "function", name: choice.name };
    default:
      return undefined;
  }
}

function reasoningEffort(req: MessagesRequest): "low" | "medium" | "high" | undefined {
  const thinking = req.thinking;
  if (!thinking || thinking.type === "disabled") return undefined;
  const requested = req.output_config?.effort?.toLowerCase();
  if (requested === "low" || requested === "medium" || requested === "high") return requested;
  if (requested === "max" || requested === "xhigh") return "high";
  if (thinking.type === "enabled" && thinking.budget_tokens !== undefined) {
    if (thinking.budget_tokens <= 4096) return "low";
    if (thinking.budget_tokens <= 16_000) return "medium";
    return "high";
  }
  return "medium";
}

/**
 * Records Anthropic cache breakpoints. Gloo only honors `cache_control` on user message content parts
 * (not assistant parts, function_call or function_call_output items), so every breakpoint is anchored
 * to the closest preceding user part (a shorter, still-valid cached prefix).
 */
class CacheTracker {
  lastPart: InputPart | undefined;
  private seen = false;
  private longest: "5m" | "1h" = "5m";
  private anchors: InputPart[] = [];

  note(control: CacheControl | undefined): void {
    if (!control) return;
    this.seen = true;
    if (control.ttl === "1h") this.longest = "1h";
  }

  breakpoint(control: CacheControl | undefined): void {
    if (!control) return;
    this.note(control);
    if (this.lastPart && !this.anchors.includes(this.lastPart)) this.anchors.push(this.lastPart);
  }

  applyBreakpoints(): void {
    for (const part of this.anchors.slice(-MAX_MESSAGE_BREAKPOINTS)) part.cache_control = { type: "ephemeral" };
  }

  ttl(): "5m" | "1h" | undefined {
    return this.seen ? this.longest : undefined;
  }
}
