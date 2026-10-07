import assert from "node:assert/strict";
import test from "node:test";
import OpenAI from "openai";
import { CaseGenerator } from "./case-generation.js";
import { sampleCase } from "./test-fixture.js";

function draft() {
  return { ...structuredClone(sampleCase), timeline: [
    { time: "7:45 PM", event: "Visitors left." },
    { time: "8:00 PM", event: "The map room closed." },
    { time: "8:10 PM", event: "The missing compass was reported." },
  ] };
}

function generator(respond: (stage: string, input: string, call: number) => unknown) {
  const calls: { stage: string; input: string }[] = [];
  const client = new OpenAI({ apiKey: "test-key", maxRetries: 0, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const stage = body.text.format.name as string;
    const input = body.input as string;
    calls.push({ stage, input });
    const payload = respond(stage, input, calls.length);
    return Response.json({
      id: "test-response", object: "response", status: "completed",
      output: [{ id: "model-message", type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(payload), annotations: [] }] }],
    });
  } });
  return { calls, generator: new CaseGenerator({ client, model: "fixture", chooseCrime: () => "robbery" }) };
}

function existing(input: string) {
  return JSON.parse(input.split("Existing case:\n")[1]!) as ReturnType<typeof draft>;
}

test("structural errors repair the same draft instead of generating another case", async () => {
  const { calls, generator: service } = generator((stage, input) => {
    if (stage === "generated_case") {
      const bad = draft();
      bad.evidence[1]!.id = "evidence_1";
      return bad;
    }
    if (stage === "corrected_case") {
      const corrected = existing(input);
      corrected.evidence[1]!.id = "evidence_2";
      return corrected;
    }
    return { valid: true, reason: "The case is consistent." };
  });
  const result = await service.generate();
  assert.deepEqual(calls.map(({ stage }) => stage), ["generated_case", "corrected_case", "case_verdict"]);
  assert.deepEqual(result.suspects, sampleCase.suspects);
  assert.equal(result.solution.motive, sampleCase.solution.motive);
  assert.notEqual(result.caseId, sampleCase.caseId);
});

test("corrections that replace the culprit or characters are repaired before acceptance", async () => {
  let corrections = 0;
  const original = draft();
  const { calls, generator: service } = generator((stage, input) => {
    if (stage === "generated_case") return original;
    if (stage === "case_verdict") return { valid: corrections > 0, reason: "Fix the discovery time." };
    corrections += 1;
    const corrected = existing(input);
    if (corrections === 1) {
      corrected.suspects[0]!.name = "Replacement character";
      return corrected;
    }
    return { ...original, caseId: corrected.caseId };
  });
  const result = await service.generate();
  assert.equal(corrections, 2);
  assert.equal(result.suspects[0]!.name, original.suspects[0]!.name);
  assert.equal(calls.filter(({ stage }) => stage === "generated_case").length, 1);
});

test("three material corrections exhaust the budget without a fresh case", async () => {
  const { calls, generator: service } = generator((stage, input) => {
    if (stage === "generated_case") return draft();
    if (stage === "corrected_case") return existing(input);
    return { valid: false, reason: "The timeline contradicts the discovery." };
  });
  await assert.rejects(service.generate(), /after three corrections/);
  assert.equal(calls.filter(({ stage }) => stage === "generated_case").length, 1);
  assert.equal(calls.filter(({ stage }) => stage === "corrected_case").length, 3);
  assert.equal(calls.filter(({ stage }) => stage === "case_verdict").length, 4);
});

test("suspect names in the initial report require a correction", async () => {
  const { calls, generator: service } = generator((stage, input) => {
    if (stage === "generated_case") return { ...draft(), incidentBriefing: "Mara Vale claims to be innocent." };
    if (stage === "corrected_case") return { ...existing(input), incidentBriefing: sampleCase.incidentBriefing };
    return { valid: true, reason: "Consistent." };
  });
  assert.equal((await service.generate()).incidentBriefing, sampleCase.incidentBriefing);
  assert.equal(calls[1]?.stage, "corrected_case");
});

test("authentication failures do not consume multiple generation requests", async () => {
  let calls = 0;
  const client = new OpenAI({ apiKey: "test-key", fetch: async () => {
    calls += 1;
    return Response.json({ error: { message: "Invalid key", type: "authentication_error" } }, { status: 401 });
  } });
  await assert.rejects(new CaseGenerator({ client }).generate(), /401/);
  assert.equal(calls, 1);
});
