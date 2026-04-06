# pi-llm-debugging

A [pi](https://shittycodingagent.ai) extension that captures both the full LLM provider request payload **and** the direct HTTP response from the provider to disk for every LLM call — letting you inspect exactly what gets sent to (and received from) the model, turn by turn.

## Install

```bash
pi install npm:pi-llm-debugging
```

To uninstall:

```bash
pi remove npm:pi-llm-debugging
```

## How it works

Every time pi is about to call the LLM, the extension writes **two** JSON files into your project's local `.pi` directory — one for the request, one for the raw provider response:

```
.pi/pi-llm-debugging/<session_id>/<seq>-req.json
.pi/pi-llm-debugging/<session_id>/<seq>-res.json
```

- **`session_id`** — the current pi session identifier (visible in the footer bar). Resets on `/new`, `/resume`, and `/fork`.
- **`seq`** — a zero-padded sequence number (`001`, `002`, ...) that increments with each LLM call within the session.

For example, a session might produce:

```
.pi/pi-llm-debugging/
└── abc123def/
    ├── 001-req.json   ← first turn, request payload
    ├── 001-res.json   ← first turn, raw provider response
    ├── 002-req.json   ← second turn (after a tool call loops back)
    ├── 002-res.json
    ├── 003-req.json
    └── 003-res.json
```

**`<seq>-req.json`** is the exact payload the provider receives: the full message history, system prompt, tool definitions, model parameters, and any cache hints. It is captured via pi's `before_provider_request` event.

**`<seq>-res.json`** is the direct HTTP response from the provider, captured by transparently intercepting `fetch` for known LLM hosts (Anthropic, OpenAI, Gemini, Groq, Mistral, DeepSeek, xAI, Together, Fireworks, Cohere, Perplexity, OpenRouter, …). Each file has this shape:

```jsonc
{
  "url": "https://api.anthropic.com/v1/messages",
  "method": "POST",
  "status": 200,
  "statusText": "OK",
  "headers": { "content-type": "text/event-stream", ... },
  "body": "event: message_start\ndata: {...}\n\n...",   // raw bytes verbatim
  "parsedBody": { /* decoded JSON, when content-type is application/json */ }
}
```

For streaming SSE responses, `body` contains the full raw SSE text exactly as sent by the provider, so you can replay or diff it. For non-streamed JSON responses, `parsedBody` holds the decoded object for convenience.

## Walkthrough: a 2-turn session

Let's trace what gets written when you run a single prompt that requires one tool call. Imagine you start a fresh pi session and type:

> **show me the number of files in cwd**

pi loops with the model twice: once to decide which tool to call, and once to summarize the tool output. That produces four files:

```
.pi/pi-llm-debugging/abc123def/
├── 001-req.json   ← user prompt is sent
├── 001-res.json   ← model replies with a Bash tool call
├── 002-req.json   ← prompt + tool call + tool result are sent back
└── 002-res.json   ← model replies with the final text answer
```

### Turn 1 — ask the question

**`001-req.json`** (trimmed) — just the user message and the model/tool config:

```jsonc
{
  "model": "claude-opus-4-6",
  "system": [{ "type": "text", "text": "You are Claude Code, ..." }],
  "tools": [ { "name": "Bash", /* ... */ }, /* Read, Edit, ... */ ],
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "show me the number of files in cwd" }
      ]
    }
  ]
}
```

**`001-res.json`** — the raw SSE stream from Anthropic. The model decides to call `Bash`:

```jsonc
{
  "url": "https://api.anthropic.com/v1/messages",
  "status": 200,
  "headers": { "content-type": "text/event-stream", /* ... */ },
  "body": "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":6,\"cache_read_input_tokens\":5996,\"output_tokens\":0}}}\n\nevent: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01GE7771KFZvGYeQhyLmbJqQ\",\"name\":\"Bash\",\"input\":{}}}\n\nevent: content_block_delta\ndata: {\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"command\\\": \\\"ls -1 | wc -l\\\"}\"}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":72}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
}
```

If you `jq -r '.body' 001-res.json` you'll see the SSE events laid out cleanly. Notable bits in this response:

- `stop_reason: "tool_use"` — the model wants pi to run a tool before continuing.
- `tool_use.name: "Bash"`, `input: { command: "ls -1 | wc -l" }` — exactly what pi will execute.
- `usage.cache_read_input_tokens: 5996` — 5996 tokens of system prompt + tool defs hit the prompt cache; only 6 fresh input tokens were billed at full rate.

pi runs `ls -1 | wc -l` locally and gets `13`. It then loops back to the model.

### Turn 2 — the tool result is sent back

**`002-req.json`** (trimmed) — the conversation has grown by two messages: the assistant's `tool_use` block and a `user`-role `tool_result` carrying the bash output:

```jsonc
{
  "model": "claude-opus-4-6",
  "messages": [
    {
      "role": "user",
      "content": [{ "type": "text", "text": "show me the number of files in cwd" }]
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "tool_use",
          "id": "toolu_01GE7771KFZvGYeQhyLmbJqQ",
          "name": "Bash",
          "input": { "command": "ls -1 | wc -l" }
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "toolu_01GE7771KFZvGYeQhyLmbJqQ",
          "content": "      13\n"
        }
      ]
    }
  ]
}
```

Diffing `001-req.json` against `002-req.json` is the fastest way to see *exactly* how pi grew the conversation between turns — useful when debugging tool-result formatting or context bloat.

**`002-res.json`** — with the tool result in hand, the model now answers in plain text:

```jsonc
{
  "url": "https://api.anthropic.com/v1/messages",
  "status": 200,
  "body": "event: message_start\ndata: {...,\"usage\":{\"input_tokens\":1,\"cache_read_input_tokens\":6089,\"output_tokens\":1}}\n\nevent: content_block_start\ndata: {\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\nevent: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\"13\"}}\n\nevent: content_block_delta\ndata: {\"delta\":{\"type\":\"text_delta\",\"text\":\" files/directories in the current working directory.\"}}\n\nevent: message_delta\ndata: {\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":17}}\n\nevent: message_stop\ndata: {}\n\n"
}
```

This time:

- `stop_reason: "end_turn"` — the model is done, the agent loop exits.
- The streamed text deltas concatenate to `"13 files/directories in the current working directory."` — which is what you see in the pi UI.
- `cache_read_input_tokens: 6089` (vs `5996` on turn 1) — the prior turn's assistant + tool_result blocks were appended into the cache.

### What you learned from 4 files

By reading these 4 files in order you can answer questions like:

- *Did pi send my exact prompt?* → `001-req.json`
- *Why did the model choose Bash and what command did it pick?* → `001-res.json`
- *Was the tool result formatted correctly when sent back?* → `002-req.json`
- *Did the model actually generate the final answer, or did pi mangle it?* → `002-res.json`
- *How much of my context was cached vs fresh?* → `usage` blocks in either `-res.json`

No guessing, no "works on my machine" — just the bytes that crossed the wire.

## What you can debug

**Session health** — Read through the messages array to see how the conversation is growing. Spot runaway context, unexpected role ordering, or missing tool results that might confuse the model.

**Token usage** — Compare payloads across turns to see what's eating your context window. Identify large tool results or verbose system prompt sections that could be trimmed.

**System prompt drift** — Check whether injected context from extensions or skills is accumulating correctly, being duplicated, or getting dropped.

**Tool serialization** — Verify that tool definitions and arguments are serialized the way the provider expects, especially useful when debugging custom tools or provider-specific quirks.

**Compaction quality** — Compare the payload just before and just after a `/compact` to see what the summary replaced and whether important context was preserved.

**Response-side issues** — Inspect `<seq>-res.json` to see the raw SSE stream, tool-use blocks, stop reason, thinking blocks, cache hits, and token usage reported by the provider. Essential when the model does something surprising and you need to know whether it was the model, the parser, or pi itself.

## Tips

Add the debugging output to your `.gitignore` so it doesn't end up in version control:

```
.pi/pi-llm-debugging/
```

Use `jq` to quickly inspect a payload:

```bash
# See just the messages sent on the first turn
jq '.messages' .pi/pi-llm-debugging/<session_id>/001-req.json

# Inspect the decoded provider response (non-streamed)
jq '.parsedBody' .pi/pi-llm-debugging/<session_id>/001-res.json

# Replay a streamed SSE response to stdout
jq -r '.body' .pi/pi-llm-debugging/<session_id>/001-res.json

# Diff two consecutive request payloads to see what changed
diff \
  <(jq . .pi/pi-llm-debugging/<session_id>/001-req.json) \
  <(jq . .pi/pi-llm-debugging/<session_id>/002-req.json)
```

Since files are scoped per-project under `.pi/`, each project manages its own debugging output independently — nothing bleeds into other projects or your global `~/.pi` directory.
