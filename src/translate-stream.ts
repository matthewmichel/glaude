import type { MessageResponse, OutputBlock, StopReason, StreamEvent, Usage } from "./anthropic-types.ts";

type Json = Record<string, any>;

type BlockKind = "text" | "tool_use" | "thinking";

interface OpenBlock {
  key: string;
  index: number;
  kind: BlockKind;
  outputIndex: number;
  hasContent: boolean;
}

const THINKING_SIGNATURE = "gloo-proxy";

/**
 * Converts Gloo Direct Responses stream events into Anthropic Messages stream events.
 *
 * Gloo flattens item/response fields onto the event payload and omits `item_id` on deltas, so every
 * lookup tolerates both the OpenAI shape (`data.item`, `data.response`) and the flattened one, and
 * blocks are keyed by `output_index`.
 */
export class ResponsesToMessagesTranslator {
  private model: string;
  private emit: (event: StreamEvent) => void;
  private started = false;
  private done = false;
  private nextIndex = 0;
  private current: OpenBlock | undefined;
  private emittedKeys = new Set<string>();
  private emittedOutputs = new Set<number>();
  private sawToolUse = false;
  private usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

  constructor(model: string, emit: (event: StreamEvent) => void) {
    this.model = model;
    this.emit = emit;
  }

  get finished(): boolean {
    return this.done;
  }

  get hasStarted(): boolean {
    return this.started;
  }

  get finalUsage(): Usage {
    return this.usage;
  }

  handle(eventName: string | undefined, data: Json): void {
    if (this.done) return;
    const type: string = data.type ?? eventName ?? "";
    const outputIndex: number = data.output_index ?? 0;
    this.ensureStarted(data);

    switch (type) {
      case "response.output_item.added": {
        const item = data.item ?? data;
        if (item.type === "function_call") this.openToolUse(outputIndex, item);
        break;
      }
      case "response.content_part.added": {
        const part = data.part ?? {};
        if (part.type === "output_text" && part.text) this.textDelta(outputIndex, data.content_index ?? 0, part.text);
        break;
      }
      case "response.output_text.delta":
      case "response.refusal.delta":
        this.textDelta(outputIndex, data.content_index ?? 0, data.delta ?? "");
        break;
      case "response.output_text.done":
      case "response.content_part.done": {
        const key = textKey(outputIndex, data.content_index ?? 0);
        const text: string = data.text ?? data.part?.text ?? "";
        if (!this.emittedKeys.has(key) && text) this.textDelta(outputIndex, data.content_index ?? 0, text);
        if (this.current?.key === key) this.closeCurrent();
        break;
      }
      case "response.function_call_arguments.delta": {
        const block = this.openToolUse(outputIndex, data);
        if (data.delta) this.delta(block, { type: "input_json_delta", partial_json: data.delta });
        break;
      }
      case "response.function_call_arguments.done": {
        const block = this.openToolUse(outputIndex, data);
        if (!block.hasContent && data.arguments) {
          this.delta(block, { type: "input_json_delta", partial_json: data.arguments });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.thinkingDelta(outputIndex, data.summary_index ?? data.content_index ?? 0, data.delta ?? "");
        break;
      case "response.output_item.done":
        this.itemDone(outputIndex, data.item ?? data);
        break;
      case "response.completed":
      case "response.incomplete":
        this.complete(data.response ?? data);
        break;
      case "response.failed": {
        const response = data.response ?? data;
        this.fail(response.error?.message ?? "Gloo reported response.failed", response.error?.code);
        break;
      }
      case "error":
        this.fail(data.message ?? data.error?.message ?? "Gloo stream error", data.code ?? data.error?.code);
        break;
      default:
        break;
    }
  }

  /** Call when the upstream body ends. Emits an error if Gloo never sent a terminal event. */
  end(): void {
    if (this.done) return;
    this.ensureStarted({});
    this.fail("Gloo stream ended before response.completed");
  }

  fail(message: string, code?: string): void {
    if (this.done) return;
    this.closeCurrent();
    this.done = true;
    this.emit({ type: "error", error: { type: errorTypeForCode(code), message } });
  }

  private ensureStarted(data: Json): void {
    if (this.started) return;
    this.started = true;
    const responseId: string = (data.response ?? data).id ?? `${Date.now().toString(36)}`;
    this.emit({
      type: "message_start",
      message: {
        id: `msg_${responseId.replace(/^resp_/, "")}`,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...this.usage },
      },
    });
  }

  private open(key: string, kind: BlockKind, outputIndex: number, contentBlock: OutputBlock): OpenBlock {
    if (this.current?.key === key) return this.current;
    this.closeCurrent();
    const block: OpenBlock = { key, index: this.nextIndex++, kind, outputIndex, hasContent: false };
    this.current = block;
    this.emittedKeys.add(key);
    this.emittedOutputs.add(outputIndex);
    this.emit({ type: "content_block_start", index: block.index, content_block: contentBlock });
    return block;
  }

  private closeCurrent(): void {
    const block = this.current;
    if (!block) return;
    if (block.kind === "thinking") {
      this.emit({ type: "content_block_delta", index: block.index, delta: { type: "signature_delta", signature: THINKING_SIGNATURE } });
    }
    this.emit({ type: "content_block_stop", index: block.index });
    this.current = undefined;
  }

  private delta(block: OpenBlock, delta: Extract<StreamEvent, { type: "content_block_delta" }>["delta"]): void {
    block.hasContent = true;
    this.emit({ type: "content_block_delta", index: block.index, delta });
  }

  private textDelta(outputIndex: number, contentIndex: number, text: string): void {
    if (!text) return;
    const block = this.open(textKey(outputIndex, contentIndex), "text", outputIndex, { type: "text", text: "" });
    this.delta(block, { type: "text_delta", text });
  }

  private thinkingDelta(outputIndex: number, partIndex: number, text: string): void {
    if (!text) return;
    const block = this.open(`r:${outputIndex}:${partIndex}`, "thinking", outputIndex, {
      type: "thinking",
      thinking: "",
      signature: "",
    });
    this.delta(block, { type: "thinking_delta", thinking: text });
  }

  private openToolUse(outputIndex: number, item: Json): OpenBlock {
    const key = `f:${outputIndex}`;
    if (this.current?.key === key) return this.current;
    this.sawToolUse = true;
    return this.open(key, "tool_use", outputIndex, {
      type: "tool_use",
      id: item.call_id ?? item.id ?? `toolu_${outputIndex}_${Date.now().toString(36)}`,
      name: item.name ?? "",
      input: {},
    });
  }

  private itemDone(outputIndex: number, item: Json): void {
    if (item.type === "function_call") {
      if (this.emittedKeys.has(`f:${outputIndex}`) && this.current?.key !== `f:${outputIndex}`) return;
      const block = this.openToolUse(outputIndex, item);
      if (!block.hasContent) {
        this.delta(block, { type: "input_json_delta", partial_json: item.arguments || "{}" });
      }
      this.closeCurrent();
      return;
    }

    if (!this.emittedOutputs.has(outputIndex)) {
      if (item.type === "message") {
        for (const [i, part] of (item.content ?? []).entries()) {
          const text = part.text ?? part.refusal;
          if (text) this.textDelta(outputIndex, i, text);
        }
      } else if (item.type === "reasoning") {
        for (const [i, part] of [...(item.summary ?? []), ...(item.content ?? [])].entries()) {
          if (part.text) this.thinkingDelta(outputIndex, i, part.text);
        }
      }
    }
    if (this.current?.outputIndex === outputIndex) this.closeCurrent();
  }

  private complete(response: Json): void {
    this.closeCurrent();
    this.usage = mapUsage(response.usage);

    let stopReason: StopReason = this.sawToolUse ? "tool_use" : "end_turn";
    const reason = response.incomplete_details?.reason;
    if (response.status === "incomplete" || reason) {
      if (reason === "max_output_tokens") stopReason = "max_tokens";
      else if (reason === "content_filter") stopReason = "refusal";
    }

    this.done = true;
    this.emit({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { ...this.usage },
    });
    this.emit({ type: "message_stop" });
  }
}

function textKey(outputIndex: number, contentIndex: number): string {
  return `t:${outputIndex}:${contentIndex}`;
}

/** Responses `input_tokens` includes cached tokens; Anthropic reports them separately. */
export function mapUsage(usage: Json | undefined): Usage {
  const input = Number(usage?.input_tokens ?? 0);
  const cacheRead = Number(usage?.input_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? 0);
  const cacheWrite = Number(
    usage?.input_tokens_details?.cache_creation_tokens ??
      usage?.input_tokens_details?.cache_write_tokens ??
      usage?.cache_creation_input_tokens ??
      0,
  );
  return {
    input_tokens: Math.max(0, input - cacheRead - cacheWrite),
    output_tokens: Number(usage?.output_tokens ?? 0),
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  };
}

function errorTypeForCode(code: string | undefined): string {
  if (!code) return "api_error";
  if (/rate|quota|429/i.test(code)) return "rate_limit_error";
  if (/overload|unavailable|529|503/i.test(code)) return "overloaded_error";
  if (/invalid|bad_request|context/i.test(code)) return "invalid_request_error";
  return "api_error";
}

/** Rebuilds a complete Anthropic message from stream events, for non-streaming clients. */
export class MessageAccumulator {
  message: MessageResponse | undefined;
  error: { type: string; message: string } | undefined;
  private toolJson = new Map<number, string>();

  apply(event: StreamEvent): void {
    switch (event.type) {
      case "message_start":
        this.message = structuredClone(event.message);
        break;
      case "content_block_start":
        this.message!.content[event.index] = structuredClone(event.content_block);
        if (event.content_block.type === "tool_use") this.toolJson.set(event.index, "");
        break;
      case "content_block_delta": {
        const block = this.message!.content[event.index]!;
        const d = event.delta;
        if (d.type === "text_delta" && block.type === "text") block.text += d.text;
        else if (d.type === "thinking_delta" && block.type === "thinking") block.thinking += d.thinking;
        else if (d.type === "signature_delta" && block.type === "thinking") block.signature = d.signature;
        else if (d.type === "input_json_delta") this.toolJson.set(event.index, (this.toolJson.get(event.index) ?? "") + d.partial_json);
        break;
      }
      case "content_block_stop": {
        const block = this.message!.content[event.index]!;
        if (block.type === "tool_use") {
          const raw = this.toolJson.get(event.index) ?? "";
          try {
            block.input = raw ? JSON.parse(raw) : {};
          } catch {
            block.input = {};
          }
        }
        break;
      }
      case "message_delta":
        this.message!.stop_reason = event.delta.stop_reason;
        this.message!.stop_sequence = event.delta.stop_sequence;
        this.message!.usage = { ...this.message!.usage, ...event.usage };
        break;
      case "error":
        this.error = event.error;
        break;
      default:
        break;
    }
  }
}
