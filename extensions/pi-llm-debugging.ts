/**
 * Pi LLM Debugging — Saves the full provider request payload to disk before each LLM call.
 *
 * Files are written to <project>/.pi/pi-llm-debugging/<pi_session_id>/<sequence>.json
 * where <sequence> is a zero-padded counter (001, 002, ...).
 *
 * Unlike the global save-llm-prompt extension, each project manages its own debugging
 * files under its local .pi directory, making it easy to review, diff, and gitignore
 * per-project LLM traffic.
 *
 * The current Pi session ID is shown in the footer bar and updates on /new, /resume, and /fork.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  let outDir = "";
  let sequence = 0;

  function initSession(ctx: {
    cwd: string;
    sessionManager: { getSessionId(): string };
    ui: { setStatus(key: string, value: string | undefined): void };
  }) {
    const sessionId = ctx.sessionManager.getSessionId();
    outDir = join(ctx.cwd, ".pi", "pi-llm-debugging", sessionId);
    sequence = 0;
    mkdirSync(outDir, { recursive: true });
    ctx.ui.setStatus("llm-debugging", `🐛 ${sessionId}`);
  }

  pi.on("session_start", async (_event, ctx) => {
    initSession(ctx);
  });

  pi.on("session_switch", async (_event, ctx) => {
    initSession(ctx);
  });

  pi.on("session_fork", async (_event, ctx) => {
    initSession(ctx);
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (!outDir) initSession(ctx);
    sequence++;
    const filename = `${String(sequence).padStart(3, "0")}.json`;
    const filepath = join(outDir, filename);
    writeFileSync(filepath, JSON.stringify(_event.payload, null, 2), "utf-8");
  });
}
