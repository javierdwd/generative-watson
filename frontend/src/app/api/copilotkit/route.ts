import { createGameCopilotHandler } from "../../../lib/copilot-runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const origin = process.env.BACKEND_URL ?? process.env.AGENT_URL ?? "http://localhost:8123";
  return createGameCopilotHandler(new URL("/agui", origin).toString())(request);
}
