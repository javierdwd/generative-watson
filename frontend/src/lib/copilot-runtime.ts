import { HttpAgent } from "@ag-ui/client";
import {
  AgentRunner,
  CopilotRuntime,
  createCopilotRuntimeHandler,
  type AgentRunnerRunRequest,
} from "@copilotkit/runtime/v2";

// Fastify owns the ephemeral session and its history. A passthrough runner
// avoids retaining a second copy in CopilotKit's process-wide memory store.
class GameAgentRunner extends AgentRunner {
  run({ agent, input }: AgentRunnerRunRequest) {
    return agent.run(input);
  }
  connect(): never {
    throw new Error("Use the read command to retrieve the active cookie-bound case.");
  }
  async isRunning() { return false; }
  async stop() { return false; }
}

export function createGameCopilotHandler(
  backendUrl: string,
  backendFetch: typeof fetch = fetch,
) {
  return async (request: Request): Promise<Response> => {
    const envelope = await request.clone().json().catch(() => null) as { method?: string } | null;
    let resolveHeaders!: (cookie: string | null) => void;
    const backendHeaders = new Promise<string | null>((resolve) => { resolveHeaders = resolve; });
    const runtime = new CopilotRuntime({
      agents: {
        detective: new HttpAgent({
          url: backendUrl,
          headers: { cookie: request.headers.get("cookie") ?? "" },
          fetch: async (url, init) => {
            try {
              const response = await backendFetch(url, { ...init, cache: "no-store" });
              resolveHeaders(response.headers.get("set-cookie"));
              return response;
            } catch (error) {
              resolveHeaders(null);
              throw error;
            }
          },
        }),
      },
      runner: new GameAgentRunner(),
    });
    const handler = createCopilotRuntimeHandler({
      runtime,
      basePath: "/api/copilotkit",
      mode: "single-route",
    });
    const response = await handler(request);
    // AG-UI streams start immediately. Wait only for upstream headers, so the
    // HttpOnly session cookie is forwarded before streaming case generation.
    if (envelope?.method === "agent/run" && response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
      const cookie = await backendHeaders;
      if (cookie) {
        const secureCookie = new URL(request.url).protocol === "https:" && !/;\s*secure/i.test(cookie)
          ? cookie + "; Secure"
          : cookie;
        response.headers.set("set-cookie", secureCookie);
      }
    }
    response.headers.set("cache-control", "no-store, no-transform");
    return response;
  };
}
