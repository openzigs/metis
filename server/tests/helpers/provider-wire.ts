/**
 * Epic #129 / #236 — the wire side of the real-provider loopback tests: read
 * what a REAL provider class put on the wire (system prompt, tools, tool
 * results) and answer in that provider family's own format (Anthropic
 * Messages, or OpenAI chat completions — streaming or not). Shared by
 * `agents-real-providers.sqlite.test.ts` and
 * `chat-custom-agent-real-providers.sqlite.test.ts`.
 */
import type { ServerResponse } from "node:http";

export type Body = Record<string, unknown>;

/** What the fake model "decides" to do next. */
export type Move = { tool: string; args: Body } | { text: string };

export function systemOf(body: Body): string {
  const sys = body.system;
  const fromTop =
    typeof sys === "string"
      ? sys
      : Array.isArray(sys)
        ? (sys as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n")
        : "";
  const fromMessages = ((body.messages as Body[] | undefined) ?? [])
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  return `${fromTop}\n${fromMessages}`;
}

export function toolResults(body: Body): number {
  let n = 0;
  for (const m of (body.messages as Body[] | undefined) ?? []) {
    if (m.role === "tool") n++;
    if (Array.isArray(m.content)) {
      n += (m.content as Body[]).filter((c) => c.type === "tool_result").length;
    }
  }
  return n;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Body[])
      .map((c) => (typeof c.text === "string" ? c.text : textOf(c.content)))
      .join("\n");
  }
  return "";
}

/**
 * #236 — the CURRENT turn as the model sees it on the wire: the text of the
 * last user message (not a tool-result carrier), and every tool result sent
 * after it, in order — for a multi-turn chat whose history carries earlier
 * turns' tool results too.
 */
export function currentTurn(body: Body): { userText: string; results: string[] } {
  const messages = (body.messages as Body[] | undefined) ?? [];
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "user") continue;
    const blocks = Array.isArray(m.content) ? (m.content as Body[]) : null;
    if (!blocks || !blocks.some((c) => c.type === "tool_result")) {
      userIdx = i;
      break;
    }
  }
  const results: string[] = [];
  for (const m of messages.slice(userIdx + 1)) {
    if (m.role === "tool") results.push(textOf(m.content));
    if (Array.isArray(m.content)) {
      for (const c of m.content as Body[])
        if (c.type === "tool_result") results.push(textOf(c.content));
    }
  }
  return { userText: userIdx >= 0 ? textOf(messages[userIdx]!.content) : "", results };
}

export function toolNames(body: Body): string[] {
  return ((body.tools as Body[] | undefined) ?? []).map((t) =>
    String(t.name ?? (t.function as { name?: string } | undefined)?.name),
  );
}

export function anthropicReply(res: ServerResponse, streaming: boolean, move: Move) {
  const isTool = "tool" in move;
  const content = isTool
    ? [
        {
          type: "tool_use",
          id: `toolu_${Math.random().toString(36).slice(2, 8)}`,
          name: move.tool,
          input: move.args,
        },
      ]
    : [{ type: "text", text: move.text }];
  const stop = isTool ? "tool_use" : "end_turn";
  if (!streaming) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content,
        stop_reason: stop,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (type: string, data: Body) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const block = isTool
    ? ev("content_block_start", { index: 0, content_block: { ...content[0], input: {} } }) +
      ev("content_block_delta", {
        index: 0,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(move.args) },
      })
    : ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: move.text } });
  res.end(
    ev("message_start", {
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    }) +
      block +
      ev("content_block_stop", { index: 0 }) +
      ev("message_delta", {
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: 2 },
      }) +
      ev("message_stop", {}),
  );
}

export function openAiReply(res: ServerResponse, streaming: boolean, move: Move) {
  const usage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
  const isTool = "tool" in move;
  const toolCall = isTool
    ? {
        id: `call_${Math.random().toString(36).slice(2, 8)}`,
        type: "function",
        function: { name: move.tool, arguments: JSON.stringify(move.args) },
      }
    : null;
  const finish = isTool ? "tool_calls" : "stop";
  if (!streaming) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "c1",
        object: "chat.completion",
        model: "m",
        choices: [
          {
            index: 0,
            message: isTool
              ? { role: "assistant", content: null, tool_calls: [toolCall] }
              : { role: "assistant", content: move.text },
            finish_reason: finish,
          },
        ],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (d: Body) => `data: ${JSON.stringify(d)}\n\n`;
  res.end(
    chunk({
      id: "c1",
      choices: [
        {
          index: 0,
          delta: isTool
            ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] }
            : { content: move.text },
          finish_reason: null,
        },
      ],
    }) +
      chunk({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }) +
      "data: [DONE]\n\n",
  );
}
