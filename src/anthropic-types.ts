export interface CacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
}

export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export type DocumentSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string }
  | { type: "text"; media_type?: string; data: string }
  | { type: "content"; content: string | ContentBlock[] };

export type ContentBlock =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "image"; source: ImageSource; cache_control?: CacheControl }
  | { type: "document"; source: DocumentSource; title?: string; cache_control?: CacheControl }
  | { type: "tool_use"; id: string; name: string; input: unknown; cache_control?: CacheControl }
  | {
      type: "tool_result";
      tool_use_id: string;
      content?: string | ContentBlock[];
      is_error?: boolean;
      cache_control?: CacheControl;
    }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "redacted_thinking"; data: string }
  | { type: string; [key: string]: unknown };

export interface Message {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface Tool {
  type?: string;
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  cache_control?: CacheControl;
}

export type ToolChoice =
  | { type: "auto"; disable_parallel_tool_use?: boolean }
  | { type: "any"; disable_parallel_tool_use?: boolean }
  | { type: "tool"; name: string; disable_parallel_tool_use?: boolean }
  | { type: "none" };

export interface MessagesRequest {
  model: string;
  messages: Message[];
  system?: string | ContentBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Tool[];
  tool_choice?: ToolChoice;
  thinking?: { type: "enabled"; budget_tokens?: number } | { type: "disabled" } | { type: "adaptive" };
  output_config?: { effort?: string };
  metadata?: Record<string, unknown>;
}

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type OutputBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "thinking"; thinking: string; signature: string };

export interface MessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: OutputBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
}

/** Server-sent events emitted on a streaming /v1/messages response. */
export type StreamEvent =
  | { type: "message_start"; message: MessageResponse }
  | { type: "content_block_start"; index: number; content_block: OutputBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: StopReason | null; stop_sequence: string | null };
      usage: Partial<Usage> & { output_tokens: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };
