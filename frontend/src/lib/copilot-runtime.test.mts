import assert from "node:assert/strict";
import test from "node:test";
import { HttpAgent, type RunAgentInput } from "@ag-ui/client";
import { createServer } from "../../../backend/src/server.ts";
import { transitionGame } from "../../../backend/src/game-graph.ts";
import { sampleCase } from "../../../backend/src/test-fixture.ts";
import { createGameCopilotHandler } from "./copilot-runtime.ts";

test("CopilotKit runtime connects intake, suspect selection, dialogue, Reveal, and debug with the session cookie", async (t) => {
  const app = createServer({
    caseGenerator: { model: "fixture", generate: async () => ({ ...structuredClone(sampleCase), caseId: crypto.randomUUID() }) },
    heatEvaluator: async () => 0.9,
    transition: async (caseData, game, action) => {
      if (action.kind !== "message") return transitionGame(caseData, game, action);
      assert.ok(game);
      // Keep external model calls out of this transport test. All other actions
      // execute the real LangGraph graph.
      return {
        ...game,
        messages: [...game.messages,
          { id: action.messageId ?? crypto.randomUUID(), speaker: "detective", suspectId: null, text: action.text },
          { id: crypto.randomUUID(), speaker: "suspect", suspectId: game.activeSuspectId, text: "I was at the front desk." },
        ],
      };
    },
  });
  t.after(() => app.close());
  const handler = createGameCopilotHandler("http://backend/agui", async (_url, init) => {
    const response = await app.inject({
      method: "POST", url: "/agui",
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: String(init?.body),
    });
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return new Response(response.rawPayload, { status: response.statusCode, headers });
  });

  const info = await handler(new Request("http://frontend/api/copilotkit", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "info" }),
  }));
  assert.equal(info.status, 200);
  assert.ok((await info.json()).agents.detective);

  let cookie = "";
  const client = new HttpAgent({
    url: "http://frontend/api/copilotkit",
    fetch: async (url, init) => {
      const input = JSON.parse(String(init.body)) as RunAgentInput;
      const response = await handler(new Request(url, {
        method: "POST", headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ method: "agent/run", params: { agentId: "detective" }, body: input }),
      }));
      const issued = response.headers.get("set-cookie");
      if (issued) {
        assert.match(issued, /HttpOnly/);
        cookie = issued.split(";")[0]!;
      }
      return response;
    },
  });
  let lastResult: any;
  client.subscribe({ onCustomEvent: ({ event }) => { if (event.name === "command_result") lastResult = event.value; } });
  async function run(command: Record<string, unknown>) {
    lastResult = undefined;
    await client.runAgent({ forwardedProps: { command } });
    assert.ok(lastResult);
    return lastResult;
  }
  const report = await run({ kind: "new_case" });
  assert.match(cookie, /^detective_session=/);
  assert.equal(client.state.briefing.caseId, report.caseId);
  client.threadId = report.caseId;
  await run({ kind: "start" });
  assert.equal(client.state.game.status, "investigating");
  await run({ kind: "select", suspectId: "suspect_1" });
  assert.equal(client.state.game.activeSuspectId, "suspect_1");
  assert.match(String(client.messages.at(-1)?.content), /front desk/);
  client.addMessage({ id: crypto.randomUUID(), role: "user", content: "Where were you?" });
  await run({ kind: "message", text: "Where were you?" });
  assert.equal(client.messages.filter((message) => message.role === "user").length, 1);
  assert.equal(client.messages.at(-1)?.content, "I was at the front desk.");
  await run({ kind: "reveal", slot: 2 });
  assert.equal(client.state.game.evidence[1].name, "Spare key");
  const stateBeforeDebug = structuredClone(client.state);
  const debug = await run({ kind: "solution" });
  assert.equal(debug.explanation, sampleCase.solution.playerFacingExplanation);
  assert.deepEqual(client.state, stateBeforeDebug);
  const heat = await run({ kind: "heat", text: "The key", version: 4 });
  assert.deepEqual(heat, { value: 0.9, version: 4 });
  assert.deepEqual(client.state, stateBeforeDebug);

  // A new case replaces the cookie and clears CopilotKit's previous transcript.
  const oldCookie = cookie;
  const oldCaseId = client.threadId;
  client.threadId = crypto.randomUUID();
  const replacement = await run({ kind: "new_case" });
  assert.notEqual(cookie, oldCookie);
  assert.notEqual(replacement.caseId, oldCaseId);
  assert.deepEqual(client.messages, []);
  assert.equal(client.state.game, null);
  client.threadId = replacement.caseId;
  assert.deepEqual(await run({ kind: "close" }), { closed: true });
  assert.deepEqual(client.state, { briefing: null, game: null });
  const closed = await app.inject({ method: "GET", url: "/sessions/current", headers: { cookie } });
  assert.equal(closed.statusCode, 401);
});
