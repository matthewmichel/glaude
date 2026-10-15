import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamEvent } from "../src/anthropic-types.ts";
import { loadConfig } from "../src/config.ts";
import { claudeToGlooId } from "../src/models.ts";
import { formatSse, parseSse } from "../src/sse.ts";
import { translateRequest } from "../src/translate-request.ts";
import { MessageAccumulator, ResponsesToMessagesTranslator } from "../src/translate-stream.ts";

const config = loadConfig({});

test("claude ids map onto Gloo ids", () => {
  assert.equal(claudeToGlooId("claude-sonnet-4-6"), "gloo-anthropic-claude-sonnet-4.6");
  assert.equal(claudeToGlooId("claude-haiku-4-5-20251001"), "gloo-anthropic-claude-haiku-4.5");
  assert.equal(claudeToGlooId("claude-opus-4-1[1m]"), "gloo-anthropic-claude-opus-4.1");
  assert.equal(claudeToGlooId("anthropic/claude-sonnet-5"), "gloo-anthropic-claude-sonnet-5");
  assert.equal(claudeToGlooId("claude-sonnet-4"), "gloo-anthropic-claude-sonnet-4");
  assert.equal(claudeToGlooId("gpt-5"), undefined);
});

test("translates a Claude Code style tool turn", () => {
  const { body, cacheTtl, droppedTools } = translateRequest(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 32000,
      stream: true,
      system: [
        { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.300.9ec; cc_entrypoint=sdk-cli;" },
        { type: "text", text: "You are Claude Code." },
        { type: "text", text: "Be terse.", cache_control: { type: "ephemeral" } },
      ],
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { path: { type: "string" } } },
        },
        { type: "web_search_20250305", name: "web_search" },
      ],
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      thinking: { type: "enabled", budget_tokens: 31999 },
      messages: [
        { role: "user", content: "read a.txt" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm", signature: "sig" },
            { type: "text", text: "Reading." },
            { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "a.txt" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "hello" }] },
            { type: "text", text: "summarize", cache_control: { type: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
    },
    "gloo-anthropic-claude-sonnet-4.6",
    config,
  );

  assert.equal(cacheTtl, "1h");
  assert.deepEqual(droppedTools, ["web_search"]);
  assert.equal(body.instructions, "You are Claude Code.\n\nBe terse.");
  assert.equal(body.max_output_tokens, 32000);
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.tool_choice, "auto");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(body.tools, [
    {
      type: "function",
      function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
    },
  ]);
  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "read a.txt" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Reading." }] },
    { type: "function_call", call_id: "toolu_1", name: "Read", arguments: '{"path":"a.txt"}' },
    { type: "function_call_output", call_id: "toolu_1", output: "hello" },
    { role: "user", content: [{ type: "input_text", text: "summarize", cache_control: { type: "ephemeral" } }] },
  ]);
});

test("breakpoints anchor to the previous user content part, max 3", () => {
  const cc = { type: "ephemeral" as const };
  const { body } = translateRequest(
    {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "zero", cache_control: cc }] },
        { role: "assistant", content: [{ type: "text", text: "a0" }] },
        { role: "user", content: [{ type: "text", text: "one", cache_control: cc }] },
        { role: "assistant", content: [{ type: "text", text: "two" }, { type: "tool_use", id: "t1", name: "X", input: {}, cache_control: cc }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r1", cache_control: cc }] },
        { role: "assistant", content: [{ type: "text", text: "three", cache_control: cc }] },
        { role: "user", content: [{ type: "text", text: "four" }, { type: "text", text: "five", cache_control: cc }] },
        { role: "user", content: [{ type: "text", text: "six", cache_control: cc }] },
      ],
    },
    "gloo-x",
    config,
  );
  const marked = body.input.flatMap((item) => ("content" in item ? item.content : [])).filter((p) => p.cache_control);
  assert.deepEqual(marked.map((p) => (p as { text: string }).text), ["one", "five", "six"]);
  assert.equal(body.input.some((item) => "cache_control" in item), false);
});

test("tool result images move to a following user message", () => {
  const { body } = translateRequest(
    {
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: true,
              content: [
                { type: "text", text: "see image" },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
              ],
            },
            { type: "tool_result", tool_use_id: "toolu_3", content: "ok" },
            { type: "text", text: "continue" },
          ],
        },
      ],
    },
    "gloo-x",
    config,
  );
  assert.deepEqual(body.input, [
    {
      type: "function_call_output",
      call_id: "toolu_2",
      output: "[tool error] see image\n(1 attachment follow in the next user message)",
    },
    { type: "function_call_output", call_id: "toolu_3", output: "ok" },
    {
      role: "user",
      content: [
        { type: "input_text", text: "Attachments from tool result toolu_2:" },
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        { type: "input_text", text: "continue" },
      ],
    },
  ]);
});

test("sse parser handles split chunks and CRLF", async () => {
  const raw = 'event: a\r\ndata: {"x":1}\r\n\r\nevent: b\ndata: {"y":\ndata: 2}\n\n';
  const chunks = [raw.slice(0, 7), raw.slice(7, 19), raw.slice(19, 21), raw.slice(21)];
  async function* source() {
    for (const c of chunks) yield new TextEncoder().encode(c);
  }
  const out = [];
  for await (const m of parseSse(source())) out.push(m);
  assert.deepEqual(out, [
    { event: "a", data: '{"x":1}' },
    { event: "b", data: '{"y":\n2}' },
  ]);
  assert.equal(formatSse("ping", { type: "ping" }), 'event: ping\ndata: {"type":"ping"}\n\n');
});

/** Event payloads as captured from Gloo Direct Responses (gloo-anthropic-claude-haiku-4.5). */
const glooToolStream: [string, Record<string, unknown>][] = [
  ["response.created", { id: "resp_e4f4", object: "response", status: "in_progress", type: "response.created" }],
  ["response.in_progress", { id: "resp_e4f4", status: "in_progress", type: "response.in_progress" }],
  ["response.output_item.added", { id: "msg_1", item: { content: [], id: "msg_1", role: "assistant", type: "message" }, output_index: 0, type: "response.output_item.added" }],
  ["response.content_part.added", { content_index: 0, output_index: 0, part: { text: "", type: "output_text" }, text: "", type: "response.content_part.added" }],
  ["response.output_text.delta", { content_index: 0, delta: "Hi", output_index: 0, type: "response.output_text.delta" }],
  ["response.output_text.delta", { content_index: 0, delta: " there.", output_index: 0, type: "response.output_text.delta" }],
  ["response.content_part.done", { content_index: 0, output_index: 0, part: { text: "Hi there.", type: "output_text" }, text: "Hi there.", type: "response.content_part.done" }],
  ["response.output_item.done", { id: "msg_1", item: { content: [{ text: "Hi there.", type: "output_text" }], id: "msg_1", type: "message" }, output_index: 0, type: "response.output_item.done" }],
  ["response.output_item.added", { arguments: "", call_id: "toolu_015i", id: "fc_0711", item: { arguments: "", call_id: "toolu_015i", id: "fc_0711", name: "get_weather", type: "function_call" }, name: "get_weather", output_index: 1, type: "response.output_item.added" }],
  ["response.function_call_arguments.delta", { delta: '{"city"', output_index: 1, type: "response.function_call_arguments.delta" }],
  ["response.function_call_arguments.delta", { delta: ': "Paris"}', output_index: 1, type: "response.function_call_arguments.delta" }],
  ["response.output_item.done", { arguments: '{"city": "Paris"}', call_id: "toolu_015i", item: { arguments: '{"city": "Paris"}', call_id: "toolu_015i", id: "fc_0711", name: "get_weather", type: "function_call" }, output_index: 1, type: "response.output_item.done" }],
  ["response.completed", { id: "resp_e4f4", status: "completed", type: "response.completed", usage: { input_tokens: 573, input_tokens_details: { cached_tokens: 500 }, output_tokens: 60 } }],
];

function run(events: [string, Record<string, unknown>][]): StreamEvent[] {
  const out: StreamEvent[] = [];
  const t = new ResponsesToMessagesTranslator("claude-haiku-4-5", (e) => out.push(e));
  for (const [name, data] of events) t.handle(name, data);
  t.end();
  return out;
}

test("Gloo tool-call stream becomes a well-formed Anthropic stream", () => {
  const events = run(glooToolStream);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ],
  );
  assert.deepEqual(events[5], {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_015i", name: "get_weather", input: {} },
  });
  assert.deepEqual(events[9], {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { input_tokens: 73, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 500 },
  });

  const acc = new MessageAccumulator();
  events.forEach((e) => acc.apply(e));
  assert.deepEqual(acc.message!.content, [
    { type: "text", text: "Hi there." },
    { type: "tool_use", id: "toolu_015i", name: "get_weather", input: { city: "Paris" } },
  ]);
  assert.equal(acc.message!.id, "msg_e4f4");
  assert.equal(acc.message!.model, "claude-haiku-4-5");
});

test("max_output_tokens truncation maps to max_tokens", () => {
  const events = run([
    ["response.created", { id: "resp_x", type: "response.created" }],
    ["response.output_item.done", { item: { type: "message", content: [{ type: "output_text", text: "1, 2, " }] }, output_index: 0, type: "response.output_item.done" }],
    ["response.incomplete", { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, type: "response.incomplete", usage: { input_tokens: 11, output_tokens: 16 } }],
  ]);
  const acc = new MessageAccumulator();
  events.forEach((e) => acc.apply(e));
  assert.equal(acc.message!.stop_reason, "max_tokens");
  assert.deepEqual(acc.message!.content, [{ type: "text", text: "1, 2, " }]);
});

test("function call without argument deltas still yields input", () => {
  const events = run([
    ["response.output_item.added", { item: { type: "function_call", call_id: "toolu_9", name: "Bash", arguments: "" }, output_index: 0, type: "response.output_item.added" }],
    ["response.output_item.done", { item: { type: "function_call", call_id: "toolu_9", name: "Bash", arguments: '{"cmd":"ls"}' }, output_index: 0, type: "response.output_item.done" }],
    ["response.completed", { type: "response.completed", usage: {} }],
  ]);
  const acc = new MessageAccumulator();
  events.forEach((e) => acc.apply(e));
  assert.deepEqual(acc.message!.content, [{ type: "tool_use", id: "toolu_9", name: "Bash", input: { cmd: "ls" } }]);
  assert.equal(acc.message!.stop_reason, "tool_use");
});

test("reasoning summaries become signed thinking blocks", () => {
  const events = run([
    ["response.reasoning_summary_text.delta", { output_index: 0, summary_index: 0, delta: "Let me think", type: "response.reasoning_summary_text.delta" }],
    ["response.output_item.done", { item: { type: "reasoning" }, output_index: 0, type: "response.output_item.done" }],
    ["response.output_text.delta", { output_index: 1, content_index: 0, delta: "391", type: "response.output_text.delta" }],
    ["response.completed", { type: "response.completed", usage: {} }],
  ]);
  const acc = new MessageAccumulator();
  events.forEach((e) => acc.apply(e));
  assert.deepEqual(acc.message!.content, [
    { type: "thinking", thinking: "Let me think", signature: "gloo-proxy" },
    { type: "text", text: "391" },
  ]);
});

test("stream that ends early produces an error event", () => {
  const events = run([["response.output_text.delta", { output_index: 0, delta: "partial", type: "response.output_text.delta" }]]);
  assert.equal(events.at(-1)!.type, "error");
});
