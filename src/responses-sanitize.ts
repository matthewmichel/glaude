type Json = Record<string, any>;

/** Tool types Gloo's Responses endpoint accepts besides plain functions. */
const PASSTHROUGH_TOOL_TYPES = new Set(["function", "image_generation", "web_search_preview", "web_search_20250305"]);

export interface SanitizedResponsesRequest {
  body: Json;
  /** Flattened Gloo function name -> original { namespace, name } for namespaced tools. */
  namespaced: Map<string, { namespace: string; name: string }>;
  dropped: string[];
}

/**
 * Rewrites a Codex Responses request into the subset Gloo accepts: drops Chat Completions-only
 * `stream_options`, flattens `namespace` tool groups into `namespace__name` functions, and removes
 * tool types Gloo rejects (Codex's hosted `web_search`, freeform `custom`, `local_shell`).
 */
export function sanitizeResponsesRequest(input: Json): SanitizedResponsesRequest {
  const body: Json = { ...input };
  delete body.stream_options;

  const namespaced = new Map<string, { namespace: string; name: string }>();
  const dropped: string[] = [];

  if (Array.isArray(body.tools)) {
    const tools: Json[] = [];
    for (const tool of body.tools as Json[]) {
      if (tool.type === "namespace" && Array.isArray(tool.tools)) {
        for (const inner of tool.tools as Json[]) {
          if (inner.type !== "function") {
            dropped.push(`${tool.name}/${inner.name ?? inner.type}`);
            continue;
          }
          const flat = `${tool.name}__${inner.name}`;
          namespaced.set(flat, { namespace: tool.name, name: inner.name });
          const description = [tool.description, inner.description].filter(Boolean).join("\n\n");
          tools.push({ ...inner, name: flat, description });
        }
      } else if (PASSTHROUGH_TOOL_TYPES.has(tool.type)) {
        tools.push(tool);
      } else {
        dropped.push(tool.name ?? tool.type);
      }
    }
    body.tools = tools;
    if (!tools.length) {
      delete body.tools;
      delete body.tool_choice;
      delete body.parallel_tool_calls;
    }
  }

  if (Array.isArray(body.input) && namespaced.size) {
    const flatByOriginal = new Map([...namespaced].map(([flat, o]) => [`${o.namespace}\0${o.name}`, flat]));
    body.input = (body.input as Json[]).map((item) => {
      if (item?.type !== "function_call" || !item.namespace) return item;
      const flat = flatByOriginal.get(`${item.namespace}\0${item.name}`) ?? `${item.namespace}__${item.name}`;
      const { namespace: _namespace, ...rest } = item;
      return { ...rest, name: flat };
    });
  }

  return { body, namespaced, dropped };
}

const RESPONSE_LIFECYCLE_EVENTS = new Set([
  "response.created",
  "response.queued",
  "response.in_progress",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);

/**
 * Gloo flattens the response object onto lifecycle events and omits `item_id` on deltas. OpenAI
 * clients (Codex) expect `{ type, response: {...} }` and `item_id`, so rebuild that shape.
 */
export class GlooEventNormalizer {
  private itemIds = new Map<number, string>();

  normalize(data: Json): Json {
    const type: string = data.type ?? "";
    if (RESPONSE_LIFECYCLE_EVENTS.has(type) && !data.response) {
      const { type: _type, sequence_number, ...response } = data;
      return { type, ...(sequence_number !== undefined ? { sequence_number } : {}), response: { object: "response", output: [], ...response } };
    }
    if (typeof data.output_index === "number") {
      const itemId = data.item?.id;
      if (itemId) this.itemIds.set(data.output_index, itemId);
      if (!data.item_id && this.itemIds.has(data.output_index)) data.item_id = this.itemIds.get(data.output_index);
    }
    return data;
  }
}

/** Restores `{ name, namespace }` on function calls in a Gloo response object or stream event. */
export function restoreNamespaces(value: unknown, namespaced: Map<string, { namespace: string; name: string }>): void {
  if (!namespaced.size || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) restoreNamespaces(entry, namespaced);
    return;
  }
  const obj = value as Json;
  if (typeof obj.name === "string" && "call_id" in obj) {
    const original = namespaced.get(obj.name);
    if (original) {
      obj.name = original.name;
      obj.namespace = original.namespace;
    }
  }
  for (const child of Object.values(obj)) {
    if (child && typeof child === "object") restoreNamespaces(child, namespaced);
  }
}
