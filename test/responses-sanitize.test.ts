import assert from "node:assert/strict";
import { test } from "node:test";
import { GlooEventNormalizer, restoreNamespaces, sanitizeResponsesRequest } from "../src/responses-sanitize.ts";

test("Codex tools are reduced to what Gloo accepts", () => {
  const { body, namespaced, dropped } = sanitizeResponsesRequest({
    model: "gloo-anthropic-claude-sonnet-4.6",
    stream: true,
    stream_options: { include_usage: true },
    tools: [
      { type: "function", name: "exec_command", parameters: {} },
      {
        type: "namespace",
        name: "mcp__node_repl",
        description: "Node REPL",
        tools: [{ type: "function", name: "js", description: "run js", parameters: {} }],
      },
      { type: "web_search", external_web_access: false },
    ],
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "function_call", call_id: "toolu_1", name: "js", namespace: "mcp__node_repl", arguments: "{}" },
      { type: "function_call_output", call_id: "toolu_1", output: "42" },
    ],
  });

  assert.equal(body.stream_options, undefined);
  assert.deepEqual(dropped, ["web_search"]);
  assert.deepEqual(body.tools.map((t: { name: string }) => t.name), ["exec_command", "mcp__node_repl__js"]);
  assert.equal(body.tools[1].description, "Node REPL\n\nrun js");
  assert.deepEqual(namespaced.get("mcp__node_repl__js"), { namespace: "mcp__node_repl", name: "js" });
  assert.deepEqual(body.input[1], { type: "function_call", call_id: "toolu_1", name: "mcp__node_repl__js", arguments: "{}" });
});

test("namespaced calls are restored in Gloo's flattened events", () => {
  const namespaced = new Map([["mcp__node_repl__js", { namespace: "mcp__node_repl", name: "js" }]]);
  const event = {
    type: "response.output_item.done",
    call_id: "toolu_1",
    name: "mcp__node_repl__js",
    item: { type: "function_call", call_id: "toolu_1", name: "mcp__node_repl__js", arguments: "{}" },
  };
  restoreNamespaces(event, namespaced);
  assert.equal(event.item.name, "js");
  assert.equal((event.item as Record<string, unknown>).namespace, "mcp__node_repl");
  assert.equal(event.name, "js");
});

test("Gloo lifecycle events are rewrapped and deltas get item_id", () => {
  const n = new GlooEventNormalizer();
  assert.deepEqual(n.normalize({ type: "response.completed", id: "resp_1", status: "completed", usage: { input_tokens: 3 } }), {
    type: "response.completed",
    response: { object: "response", output: [], id: "resp_1", status: "completed", usage: { input_tokens: 3 } },
  });
  n.normalize({ type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message" } });
  assert.equal(n.normalize({ type: "response.output_text.delta", output_index: 0, delta: "hi" }).item_id, "msg_1");
  const wrapped = { type: "response.created", response: { id: "resp_2" } };
  assert.equal(n.normalize(wrapped), wrapped);
});
