/**
 * Pi LLM Debugging — Saves the full provider request AND the raw provider response
 * to disk for each LLM call.
 *
 * For every LLM turn, two files are written:
 *   <project>/.pi/pi-llm-debugging/<pi_session_id>/<seq>-req.json
 *   <project>/.pi/pi-llm-debugging/<pi_session_id>/<seq>-res.json
 *
 * - <seq> is a zero-padded counter (001, 002, ...).
 * - <seq>-req.json contains the exact payload handed to the provider SDK
 *   (captured via pi's `before_provider_request` event).
 * - <seq>-res.json contains the direct HTTP response from the LLM provider
 *   (captured by monkey-patching globalThis.fetch and teeing the response
 *   body for known provider hosts). For streaming SSE responses the raw SSE
 *   text is preserved verbatim inside the `body` field.
 *
 * Unlike pi's global save-llm-prompt extension, files are scoped to the
 * current project's local .pi directory so each project manages its own
 * debugging output (easy to gitignore, diff, and review).
 *
 * The current Pi session ID is shown in the footer bar and updates on
 * /new, /resume, and /fork.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Hostnames we consider "LLM provider" traffic worth capturing.
const PROVIDER_HOST_PATTERNS: RegExp[] = [
  /(^|\.)anthropic\.com$/i,
  /(^|\.)openai\.com$/i,
  /(^|\.)openai\.azure\.com$/i,
  /(^|\.)googleapis\.com$/i, // gemini / vertex
  /(^|\.)generativelanguage\.googleapis\.com$/i,
  /(^|\.)mistral\.ai$/i,
  /(^|\.)groq\.com$/i,
  /(^|\.)deepseek\.com$/i,
  /(^|\.)x\.ai$/i,
  /(^|\.)together\.xyz$/i,
  /(^|\.)fireworks\.ai$/i,
  /(^|\.)cohere\.(com|ai)$/i,
  /(^|\.)perplexity\.ai$/i,
  /(^|\.)openrouter\.ai$/i,
];

function isProviderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return PROVIDER_HOST_PATTERNS.some((re) => re.test(host));
  } catch {
    return false;
  }
}

// Install the fetch interceptor exactly once per Node process. Multiple
// pi sessions (or extension re-inits) share the same hook and use a
// module-level "current target" to decide where to write the next response.
type ResponseTarget = { outDir: string; sequence: number } | null;
let currentTarget: ResponseTarget = null;
let fetchPatched = false;

function installFetchInterceptor() {
  if (fetchPatched) return;
  fetchPatched = true;

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") return;

  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    const response = await originalFetch(input as any, init as any);

    // Only intercept known provider traffic, and only if we have a
    // request that hasn't been paired with a response yet.
    if (!currentTarget || !isProviderUrl(url)) {
      return response;
    }

    const target = currentTarget;
    // One response per request: clear immediately so subsequent fetches
    // (retries, unrelated calls) don't clobber this slot.
    currentTarget = null;

    const filename = `${String(target.sequence).padStart(3, "0")}-res.json`;
    const filepath = join(target.outDir, filename);

    // Tee the body so the caller still gets a fully readable response.
    // For non-streamed JSON responses, .clone() + .text() is enough.
    // For SSE streams, clone() also works: both branches can be
    // consumed independently by the WHATWG fetch implementation.
    const cloned = response.clone();

    // Fire-and-forget: never block the real request on disk IO.
    void (async () => {
      try {
        const headers: Record<string, string> = {};
        cloned.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const bodyText = await cloned.text();

        const contentType = headers["content-type"] || "";
        let parsedBody: unknown = undefined;
        if (contentType.includes("application/json")) {
          try {
            parsedBody = JSON.parse(bodyText);
          } catch {
            // keep raw text only
          }
        }

        const record = {
          url,
          method: (init?.method || (typeof input !== "string" && !(input instanceof URL) ? (input as Request).method : "GET")).toUpperCase(),
          status: response.status,
          statusText: response.statusText,
          headers,
          // For SSE / text responses, `body` holds the raw stream text.
          // For JSON responses, `parsedBody` holds the decoded object and
          // `body` still holds the exact bytes for fidelity.
          body: bodyText,
          parsedBody,
        };

        writeFileSync(filepath, JSON.stringify(record, null, 2), "utf-8");
      } catch (err) {
        try {
          writeFileSync(
            filepath,
            JSON.stringify(
              { url, error: (err as Error)?.message || String(err) },
              null,
              2,
            ),
            "utf-8",
          );
        } catch {
          // give up silently — debugging must never break the session
        }
      }
    })();

    return response;
  }) as typeof fetch;
}

export default function (pi: ExtensionAPI) {
  installFetchInterceptor();

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

    const seqStr = String(sequence).padStart(3, "0");
    const reqPath = join(outDir, `${seqStr}-req.json`);
    writeFileSync(reqPath, JSON.stringify(_event.payload, null, 2), "utf-8");

    // Arm the fetch interceptor to route the very next provider-bound
    // HTTP response into <seq>-res.json.
    currentTarget = { outDir, sequence };
  });
}
