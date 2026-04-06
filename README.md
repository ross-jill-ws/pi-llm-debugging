# pi-llm-debugging

A [pi](https://shittycodingagent.ai) extension that captures the full LLM provider request payload to disk before each call — letting you inspect exactly what gets sent to the model, turn by turn.

## Install

```bash
pi install npm:pi-llm-debugging
```

To uninstall:

```bash
pi remove npm:pi-llm-debugging
```

## How it works

Every time pi is about to call the LLM, the extension intercepts the raw provider payload and writes it as a JSON file into your project's local `.pi` directory:

```
.pi/pi-llm-debugging/<session_id>/<seq>.json
```

- **`session_id`** — the current pi session identifier (visible in the footer bar). Resets on `/new`, `/resume`, and `/fork`.
- **`seq`** — a zero-padded sequence number (`001`, `002`, ...) that increments with each LLM call within the session.

For example, a session might produce:

```
.pi/pi-llm-debugging/
└── abc123def/
    ├── 001.json   ← first turn
    ├── 002.json   ← second turn (after a tool call loops back)
    └── 003.json
```

Each file is the exact payload the provider receives: the full message history, system prompt, tool definitions, model parameters, and any cache hints.

## What you can debug

**Session health** — Read through the messages array to see how the conversation is growing. Spot runaway context, unexpected role ordering, or missing tool results that might confuse the model.

**Token usage** — Compare payloads across turns to see what's eating your context window. Identify large tool results or verbose system prompt sections that could be trimmed.

**System prompt drift** — Check whether injected context from extensions or skills is accumulating correctly, being duplicated, or getting dropped.

**Tool serialization** — Verify that tool definitions and arguments are serialized the way the provider expects, especially useful when debugging custom tools or provider-specific quirks.

**Compaction quality** — Compare the payload just before and just after a `/compact` to see what the summary replaced and whether important context was preserved.

## Tips

Add the debugging output to your `.gitignore` so it doesn't end up in version control:

```
.pi/pi-llm-debugging/
```

Use `jq` to quickly inspect a payload:

```bash
# See just the messages
jq '.messages' .pi/pi-llm-debugging/<session_id>/001.json

# Count tokens approximation: check message content lengths
jq '[.messages[].content | .. | strings | length] | add' .pi/pi-llm-debugging/<session_id>/001.json

# Diff two consecutive turns to see what changed
diff \
  <(jq . .pi/pi-llm-debugging/<session_id>/001.json) \
  <(jq . .pi/pi-llm-debugging/<session_id>/002.json)
```

Since files are scoped per-project under `.pi/`, each project manages its own debugging output independently — nothing bleeds into other projects or your global `~/.pi` directory.
