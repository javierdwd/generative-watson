import assert from "node:assert/strict";
import test from "node:test";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { EventSchemas } from "@ag-ui/core/schemas";
import { parseAgentRequest, type AgentCommand } from "./ag-ui.js";
import { createServer } from "./server.js";
import { sampleCase } from "./test-fixture.js";

function body(command: AgentCommand, threadId = "unbound"): RunAgentInput {
  return {
    threadId, runId: crypto.randomUUID(), messages: [], tools: [], context: [],
    state: { solution: "client-supplied solution", deadlineAt: "2000-01-01T00:00:00Z" },
    forwardedProps: { command },
  } satisfies RunAgentInput;
}

function events(payload: string): BaseEvent[] {
  return payload.split("\n").filter((line) => line.startsWith("data: ")).map((line) => {
    const event = JSON.parse(line.slice(6));
    EventSchemas.parse(event);
    return event;
  });
}

function result(items: BaseEvent[]) {
  return items.find((event) => event.type === EventType.CUSTOM && event.name === "command_result")?.value as Record<string, unknown>;
}

test("CopilotKit actions stream public game state, clues, and the explicit debug solution", async (t) => {
  const app = createServer({
    caseGenerator: { model: "fixture", generate: async () => structuredClone(sampleCase) },
    heatEvaluator: async () => 0.8,
  });
  t.after(() => app.close());
  const intake = await app.inject({ method: "POST", url: "/agui", payload: body({ kind: "new_case" }) });
  assert.equal(intake.statusCode, 200);
  assert.match(intake.headers["content-type"]!, /text\/event-stream/);
  const cookie = String(intake.headers["set-cookie"]).split(";")[0];
  assert.match(cookie, /^detective_session=/);
  const intakeEvents = events(intake.payload);
  assert.equal(intakeEvents[0]?.type, EventType.RUN_STARTED);
  assert.equal(intakeEvents.at(-1)?.type, EventType.RUN_FINISHED);
  assert.equal(result(intakeEvents).caseId, sampleCase.caseId);
  assert.equal(intake.payload.includes(sampleCase.fullCase), false);

  const briefingRead = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body({ kind: "read" }, sampleCase.caseId) });
  const briefingEvents = events(briefingRead.payload);
  const restored = briefingEvents.find((event) => event.type === EventType.STATE_SNAPSHOT);
  assert.ok(restored?.type === EventType.STATE_SNAPSHOT);
  assert.deepEqual(restored.snapshot, { briefing: result(intakeEvents), game: null });

  async function run(command: AgentCommand) {
    const response = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body(command, sampleCase.caseId) });
    assert.equal(response.statusCode, 200);
    const streamed = events(response.payload);
    assert.equal(streamed.at(-1)?.type, EventType.RUN_FINISHED);
    return { streamed, value: result(streamed), payload: response.payload };
  }
  const started = await run({ kind: "start" });
  assert.equal(started.value.status, "investigating");
  assert.equal(started.payload.includes(sampleCase.suspects[0]!.publicAlibi), false);
  assert.equal(started.payload.includes(sampleCase.solution.playerFacingExplanation), false);

  const selected = await run({ kind: "select", suspectId: "suspect_2" });
  assert.equal(selected.value.activeSuspectId, "suspect_2");
  assert.ok(selected.streamed.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && String(event.delta).includes(sampleCase.suspects[1]!.publicAlibi)));
  assert.equal(selected.payload.includes(sampleCase.suspects[0]!.privateKnowledge[0]!), false);

  const revealed = await run({ kind: "reveal", slot: 2 });
  const clues = revealed.value.evidence as { id: string | null }[];
  assert.deepEqual(clues.map((item) => item.id), [null, "evidence_2", null]);
  assert.equal(revealed.payload.includes(sampleCase.evidence[0]!.description), false);

  const debug = await run({ kind: "solution" });
  assert.equal(debug.value.explanation, sampleCase.solution.playerFacingExplanation);
  assert.equal(debug.streamed.some((event) => event.type === EventType.STATE_SNAPSHOT || event.type === EventType.TEXT_MESSAGE_CONTENT), false);
  const heat = await run({ kind: "heat", text: "Where was the spare key?", version: 12 });
  assert.deepEqual(heat.value, { value: 0.8, version: 12 });
  const stillPlaying = await run({ kind: "read" });
  assert.equal(stillPlaying.value.status, "investigating");
  assert.equal(stillPlaying.payload.includes(sampleCase.solution.playerFacingExplanation), false);

  const ended = await run({ kind: "accuse", suspectId: "suspect_1" });
  assert.equal(ended.value.status, "success");
  const closed = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body({ kind: "read" }, sampleCase.caseId) });
  assert.equal(closed.statusCode, 401);
});

test("agent history, state, and thread IDs cannot bypass the cookie-bound session", async (t) => {
  const app = createServer({ caseGenerator: { model: "fixture", generate: async () => ({ ...structuredClone(sampleCase), caseId: crypto.randomUUID() }) } });
  t.after(() => app.close());
  const first = await app.inject({ method: "POST", url: "/agui", payload: body({ kind: "new_case" }) });
  const second = await app.inject({ method: "POST", url: "/agui", payload: body({ kind: "new_case" }) });
  const firstCaseId = result(events(first.payload)).caseId as string;
  const secondCookie = String(second.headers["set-cookie"]).split(";")[0];
  const noCookie = await app.inject({ method: "POST", url: "/agui", payload: body({ kind: "read" }, firstCaseId) });
  assert.equal(noCookie.statusCode, 401);
  const wrongCase = await app.inject({ method: "POST", url: "/agui", headers: { cookie: secondCookie }, payload: body({ kind: "read" }, firstCaseId) });
  assert.equal(wrongCase.statusCode, 403);
  const malformed = await app.inject({ method: "POST", url: "/agui", payload: {
    ...body({ kind: "read" }), forwardedProps: { command: { kind: "select", suspectId: "unknown" } },
  } });
  assert.equal(malformed.statusCode, 400);
});

test("a failed streamed run ends with RUN_ERROR and leaves the game available", async (t) => {
  const app = createServer({ caseGenerator: { model: "fixture", generate: async () => structuredClone(sampleCase) } });
  t.after(() => app.close());
  const intake = await app.inject({ method: "POST", url: "/agui", payload: body({ kind: "new_case" }) });
  const cookie = String(intake.headers["set-cookie"]).split(";")[0];
  const failed = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body({ kind: "select", suspectId: "suspect_1" }, sampleCase.caseId) });
  const streamed = events(failed.payload);
  assert.equal(streamed.at(-1)?.type, EventType.RUN_ERROR);
  assert.equal(streamed.at(-1)?.code, "409");
  const retry = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body({ kind: "start" }, sampleCase.caseId) });
  assert.equal(result(events(retry.payload)).status, "investigating");
});

test("ordinary CopilotChat messages are accepted without a button command", () => {
  const input = body({ kind: "read" });
  input.messages = [{ id: "user-question", role: "user", content: "Where were you?" }];
  const { command } = parseAgentRequest({ ...input, forwardedProps: {} });
  assert.deepEqual(command, { kind: "message", text: "Where were you?" });
});

test("the server ends expired investigations and deletes their cookie-owned session", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const app = createServer({ caseGenerator: { model: "fixture", generate: async () => structuredClone(sampleCase) } });
  t.after(() => app.close());
  const intake = await app.inject({ method: "POST", url: "/sessions" });
  const cookie = String(intake.headers["set-cookie"]).split(";")[0];
  const started = await app.inject({ method: "POST", url: "/game/start", headers: { cookie } });
  now = Date.parse(started.json().deadlineAt) + 1;
  const expired = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body({ kind: "accuse", suspectId: "suspect_1" }, sampleCase.caseId) });
  assert.equal(result(events(expired.payload)).status, "timeout");
  const deleted = await app.inject({ method: "GET", url: "/sessions/current", headers: { cookie } });
  assert.equal(deleted.statusCode, 401);
});

test("closing a case through CopilotKit clears shared state and removes the session", async (t) => {
  const app = createServer({ caseGenerator: { model: "fixture", generate: async () => structuredClone(sampleCase) } });
  t.after(() => app.close());
  const intake = await app.inject({ method: "POST", url: "/agui", payload: body({ kind: "new_case" }) });
  const cookie = String(intake.headers["set-cookie"]).split(";")[0];
  const closed = await app.inject({ method: "POST", url: "/agui", headers: { cookie }, payload: body({ kind: "close" }, sampleCase.caseId) });
  const items = events(closed.payload);
  assert.deepEqual(result(items), { closed: true });
  const snapshot = items.find((event) => event.type === EventType.STATE_SNAPSHOT);
  assert.ok(snapshot?.type === EventType.STATE_SNAPSHOT);
  assert.deepEqual(snapshot.snapshot, { briefing: null, game: null });
  const missing = await app.inject({ method: "GET", url: "/sessions/current", headers: { cookie } });
  assert.equal(missing.statusCode, 401);
});
