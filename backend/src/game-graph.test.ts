import assert from "node:assert/strict";
import test from "node:test";
import { createGameGraph, parseMessageDecision, toGameView, transitionGame, visibleAlibis } from "./game-graph.js";
import { sampleCase } from "./test-fixture.js";



test("opening briefing describes the crime before an interview reveals alibis", async () => {
  const initialized = await transitionGame(sampleCase, null, { kind: "initialize" });
  const started = await transitionGame(sampleCase, initialized, { kind: "start" });

  assert.equal(started.activeSuspectId, null);
  assert.equal(started.messages[0]?.text, sampleCase.incidentBriefing);
  assert.equal(started.messages.some((message) => message.text.includes("Mara Vale")), false);

  const interviewed = await transitionGame(sampleCase, started, { kind: "select", suspectId: "suspect_1" });
  assert.equal(interviewed.messages.at(-1)?.text, "I had nothing to do with this. I was at the front desk.");
});

test("Jev decisions must include valid choices and every hidden evidence result", () => {
  const valid = { speaker: { choice: "suspect" }, target: { choice: "suspect_2" }, unlock_evidence_1: { noul: 0.8 } };
  assert.deepEqual(parseMessageDecision(sampleCase, ["evidence_1"], "Where was the glove?", valid), {
    speaker: "suspect", targetSuspectId: "suspect_2", unlocked: ["evidence_1"],
  });
  assert.equal(parseMessageDecision(sampleCase, ["evidence_1"], "Prosecutor, where was the glove?", valid).targetSuspectId, null);
  assert.throws(() => parseMessageDecision(sampleCase, ["evidence_2"], "Question", valid));
  assert.throws(() => parseMessageDecision(sampleCase, [], "Question", { ...valid, target: { choice: "intruder" } }));
  assert.throws(() => parseMessageDecision(sampleCase, ["evidence_1"], "Question", { ...valid, unlock_evidence_1: { noul: NaN } }));
});

test("a message that runs past the deadline times out without publishing late clues or replies", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const initial = await transitionGame(sampleCase, null, { kind: "initialize" });
  const game = await transitionGame(sampleCase, initial, { kind: "start" });
  const graph = createGameGraph({
    decideMessage: async () => ({ speaker: "prosecutor", targetSuspectId: null, unlocked: ["evidence_1"] }),
    writeDialogue: async () => { now = Date.parse(game.deadlineAt!) + 1; return "Late reply"; },
  });
  const result = await graph.invoke({ caseData: sampleCase, game, action: { kind: "message", text: "Question" } });
  assert.equal(result.game?.status, "timeout");
  assert.deepEqual(result.game?.discoveredEvidenceIds, []);
  assert.deepEqual(result.game?.messages, game.messages);
});

test("a deadline reached during Jev skips dialogue, including when the provider fails", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const initial = await transitionGame(sampleCase, null, { kind: "initialize" });
  const game = await transitionGame(sampleCase, initial, { kind: "start" });
  let replies = 0;
  for (const fails of [false, true]) {
    now = Date.parse(game.deadlineAt!) - 100;
    const graph = createGameGraph({
      decideMessage: async () => {
        now = Date.parse(game.deadlineAt!) + 1;
        if (fails) throw new Error("Provider aborted");
        return { speaker: "prosecutor", targetSuspectId: null, unlocked: [] };
      },
      writeDialogue: async () => { replies += 1; return "Reply"; },
    });
    const result = await graph.invoke({ caseData: sampleCase, game, action: { kind: "message", text: "Question" } });
    assert.equal(result.game?.status, "timeout");
  }
  assert.equal(replies, 0);
});

test("failed dialogue leaves the transcript and hidden evidence unchanged for retry", async () => {
  const initial = await transitionGame(sampleCase, null, { kind: "initialize" });
  const game = await transitionGame(sampleCase, initial, { kind: "start" });
  const prior = structuredClone(game);
  const graph = createGameGraph({
    decideMessage: async () => ({ speaker: "prosecutor", targetSuspectId: null, unlocked: ["evidence_1"] }),
    writeDialogue: async () => { throw new Error("Dialogue provider failed"); },
  });
  await assert.rejects(graph.invoke({ caseData: sampleCase, game, action: { kind: "message", text: "Question" } }), /Dialogue provider failed/);
  assert.deepEqual(game, prior);
});

test("dialogue context includes only alibis from suspects already interviewed", () => {
  assert.deepEqual(visibleAlibis(sampleCase, []), []);
  assert.deepEqual(visibleAlibis(sampleCase, ["suspect_2"]), [
    { name: "Noor Ellis", publicAlibi: "I was in the archive." },
  ]);
});

test("Reveal uncovers only the selected clue in the public game view", async () => {
  const initialized = await transitionGame(sampleCase, null, { kind: "initialize" });
  const started = await transitionGame(sampleCase, initialized, { kind: "start" });
  const revealed = await transitionGame(sampleCase, started, { kind: "reveal", slot: 2 });
  const view = toGameView(sampleCase, revealed);

  assert.equal(view.evidence[1]?.id, "evidence_2");
  assert.equal(view.evidence[1]?.name, "Spare key");
  assert.equal(view.evidence[0]?.id, null);
  assert.equal(view.ending, null);
  assert.deepEqual(view.newEvidenceIds, ["evidence_2"]);
});

test("replaying a CopilotKit message ID does not generate a second response", async () => {
  const initialized = await transitionGame(sampleCase, null, { kind: "initialize" });
  const started = await transitionGame(sampleCase, initialized, { kind: "start" });
  const text = "Where were you?";
  started.messages.push({ id: "client-question", speaker: "detective", suspectId: null, text });
  const replayed = await transitionGame(sampleCase, started, { kind: "message", text, messageId: "client-question" });
  assert.deepEqual(replayed.messages, started.messages);
  await assert.rejects(
    transitionGame(sampleCase, started, { kind: "message", text: "Changed question", messageId: "client-question" }),
    /Message ID is already in use/,
  );
});
