import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "./logging.js";
import type { CrimeType, GeneratedCase } from "./types.js";

const SuspectId = z.enum(["suspect_1", "suspect_2", "suspect_3"]);
const EvidenceId = z.enum(["evidence_1", "evidence_2", "evidence_3"]);

const GeneratedCaseSchema = z.object({
  caseId: z.string().min(1),
  crimeType: z.enum(["homicide", "robbery"]),
  shortSynopsis: z.string().min(1),
  incidentBriefing: z.string().min(1),
  fullCase: z.string().min(1),
  timeline: z.array(z.object({ time: z.string().min(1), event: z.string().min(1) })).min(3).max(8),
  publicFacts: z.array(z.string().min(1)).min(2).max(4),
  suspects: z.array(z.object({
    id: SuspectId,
    name: z.string().min(1),
    emoji: z.string().min(1),
    publicAlibi: z.string().min(1),
    privateKnowledge: z.array(z.string().min(1)).min(1).max(4),
    behavior: z.string().min(1),
    isPerpetrator: z.boolean(),
  })).length(3),
  evidence: z.array(z.object({
    id: EvidenceId,
    emoji: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    unlockTriggers: z.array(z.string().min(1)).min(2).max(4),
    solutionRelevance: z.string().min(1),
  })).length(3),
  solution: z.object({
    perpetratorId: SuspectId,
    method: z.string().min(1),
    motive: z.string().min(1),
    alibiFlaws: z.array(z.string().min(1)).min(1),
    reasoning: z.string().min(1),
    playerFacingExplanation: z.string().min(1),
  }),
});

const VerdictSchema = z.object({
  valid: z.boolean(),
  reason: z.string().min(1),
});

const GENERATION_INSTRUCTIONS = `You write short, fair detective mysteries in English for a ten-minute game.

VARIETY IS REQUIRED. The user input specifies the crime type; use that exact type. The application chooses homicide and robbery with equal odds, so do not default to theft. Also vary setting, object or victim, motive, method, and clue types. Do not reuse the same combination from the examples.

Robbery object examples (choose or invent a similarly specific object): a signed first edition, a prototype wristwatch, an antique compass, a rare orchid, a hand-painted theater mask, a charity auction envelope, a museum sketch, a silver thimble, a cricket trophy, a family recipe notebook, a packet of rare seeds, an engraved key, a small meteorite, an old field recorder, a ledger page, a chess clock, or a miniature lighthouse model.

Robbery motive examples: urgent debt, covering a bookkeeping error, reclaiming an object believed stolen from one's family, preventing a public sale, selling a prototype, protecting a colleague, concealing a forgery, keeping a private letter from being read, professional envy, or panic after an accidental breakage. Do not make every theft about money.

Homicide examples should be non-graphic and easy to explain: a staged fall in a familiar room, a fatal dose substituted for ordinary medicine, a sabotaged piece of everyday equipment, or a simple poisoning using a known cup. Motives can include stopping blackmail, protecting someone, inheritance, fear of exposure, professional rivalry, jealousy, revenge, or panic. Keep method details non-instructional and avoid graphic description.

The case has exactly three suspects (suspect_1 through suspect_3), three evidence items (evidence_1 through evidence_3), and one culprit. Two innocent suspects tell the truth in their public alibis. The culprit tells one simple, material lie. One clue directly disproves that lie; the other two support opportunity, method, or motive. The solution must be explainable in two or three plain sentences.

Use one small location, one short timeline of four to six events, familiar objects, and direct cause and effect. Avoid secret passages, complex technology, medical intricacies, multiple timelines, hidden relationships, and clues that depend on specialist knowledge. Keep each field short. Make every time, event, alibi, clue, and explanation agree.

incidentBriefing is the initial report shown before interviews. Give three or four sentences about the crime itself: what happened, where and when, who was harmed or what went missing, how it was discovered, and what authorities know so far. Do not include suspect names or their alibis. Do not reveal the culprit, motive, or hidden clues. shortSynopsis is a one-sentence headline that also does not reveal the solution. publicFacts are neutral incident-level facts safe for the Prosecutor to repeat; never put suspect names, statements, or alibis in publicFacts. A suspect's public alibi is revealed only when that suspect is selected. Each clue needs two to four natural-language unlockTriggers. Return only the requested structure.`;

const VALIDATION_INSTRUCTIONS = `Review this mystery for material errors only. The case is valid when its facts fit together, the correct culprit can be identified from the supplied clues, the two innocent public alibis are true, the culprit has a material false alibi directly contradicted by at least one clue, and the final explanation follows from facts in the case.

Reject only a concrete contradiction that affects the answer, a culprit not supported by the evidence, a materially false innocent alibi, or an explanation that relies on an absent fact. Do not reject for style, small ambiguities, missing detail that does not change the answer, or speculative alternatives that require inventing facts. This is an intentionally simple mystery. If it is reasonably coherent and solvable, mark it valid. If invalid, name one specific material issue in one short sentence. Return only the requested structure.`;

const CORRECTION_INSTRUCTIONS = `Correct the specific material issue in the existing case. Do not invent a new case or add plot complexity. Preserve caseId, crime, characters, culprit, motive, and all unaffected facts. Make the smallest necessary change and update only dependent details so the case becomes coherent. Preserve the crime type. Return the complete corrected case.`;

const MAX_CORRECTIONS = 3;
const MAX_REQUESTS = 3;
const GENERATION_TIMEOUT_MS = 3 * 60_000;

export class CaseGenerator {
  private client?: OpenAI;
  readonly model: string;

  constructor(options: { client?: OpenAI; model?: string; chooseCrime?: () => CrimeType } = {}) {
    this.client = options.client;
    this.model = options.model ?? process.env.OPENAI_GENERATION_MODEL ?? "gpt-6-luna";
    this.chooseCrime = options.chooseCrime ?? (() => randomInt(2) === 0 ? "homicide" : "robbery");
  }

  private readonly chooseCrime: () => CrimeType;

  async generate(): Promise<GeneratedCase> {
    const crimeType = this.chooseCrime();
    const caseId = randomUUID();
    const signal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    const logger = log.child({ component: "case-generation", model: this.model, crimeType });
    logger.info("Requesting initial case");
    let current = await this.request(GeneratedCaseSchema, "generated_case", GENERATION_INSTRUCTIONS,
      `Create one new case. Its caseId must be "${caseId}" and crimeType must be exactly "${crimeType}". Follow the variation lists for the remaining details.`, signal);
    if (current && typeof current === "object" && !Array.isArray(current)) current = { ...current, caseId };
    // Once a draft exists, both structural and narrative issues repair that draft.
    // Keep the original identity throughout all correction rounds.
    const identity = caseIdentity(current);
    for (let correction = 0; correction <= MAX_CORRECTIONS; correction += 1) {
      let candidate: GeneratedCase | undefined;
      let issue: string | undefined;
      try {
        candidate = GeneratedCaseSchema.parse(current);
        assertCaseInvariants(candidate);
        if (candidate.crimeType !== crimeType) throw new Error(`crimeType must be ${crimeType}`);
        assertSameCase(identity, candidate);
      } catch (error) {
        issue = error instanceof Error ? error.message : String(error);
      }
      if (!issue && candidate) {
        logger.info({ correction }, "Validating case consistency");
        const verdict = VerdictSchema.parse(await this.request(VerdictSchema, "case_verdict",
          VALIDATION_INSTRUCTIONS, JSON.stringify(candidate), signal));
        if (verdict.valid) {
          logger.info({ correction, caseId: candidate.caseId }, "Case validated");
          return candidate;
        }
        issue = verdict.reason;
      }
      if (correction === MAX_CORRECTIONS) {
        throw new Error(`Case could not be made consistent after three corrections: ${issue}`);
      }
      logger.warn({ correction: correction + 1, issue }, "Correcting existing case");
      current = await this.request(GeneratedCaseSchema, "corrected_case", CORRECTION_INSTRUCTIONS,
        `Issue to fix:\n${issue}\n\nRequired crimeType: ${crimeType}\nOriginal identity to preserve:\n${JSON.stringify(identity)}\n\nExisting case:\n${JSON.stringify(current)}`, signal);
    }
    throw new Error("Case generation ended without a valid case");
  }

  private openAI(): OpenAI {
    // The request loop owns retries; do not multiply them with SDK retries.
    this.client ??= new OpenAI({ timeout: 90_000, maxRetries: 0 });
    return this.client;
  }

  private async request(schema: z.ZodType, name: string, instructions: string, input: string, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 1; attempt <= MAX_REQUESTS; attempt += 1) {
      const started = Date.now();
      try {
        log.info({ component: "case-generation", stage: name, attempt, model: this.model }, "Model request started");
        const response = await this.openAI().responses.create({
          model: this.model, instructions, input,
          reasoning: { effort: "low" },
          text: { format: zodTextFormat(schema, name) }, store: false,
        }, { maxRetries: 0, signal });
        if (response.status !== "completed") throw new Error(`Model response was ${response.status}`);
        if (!response.output_text) throw new Error("Model did not return a case response");
        const payload: unknown = JSON.parse(response.output_text);
        log.info({ component: "case-generation", stage: name, elapsedMs: Date.now() - started }, "Model response received");
        return payload;
      } catch (error) {
        log.warn({ err: error, component: "case-generation", stage: name, attempt, elapsedMs: Date.now() - started }, "Model request failed");
        if (signal.aborted) throw new Error("Case generation exceeded three minutes", { cause: error });
        // Configuration/authentication errors are not recoverable by retrying.
        if (error instanceof OpenAI.APIError && error.status && error.status < 500 && ![408, 409, 429].includes(error.status)) throw error;
        if (attempt === MAX_REQUESTS) throw error;
      }
    }
    throw new Error("Model request failed");
  }
}

function assertCaseInvariants(candidate: GeneratedCase): void {
  if (new Set(candidate.suspects.map((suspect) => suspect.id)).size !== 3) throw new Error("Case must contain three unique suspect IDs");
  if (new Set(candidate.evidence.map((item) => item.id)).size !== 3) throw new Error("Case must contain three unique evidence IDs");
  const perpetrators = candidate.suspects.filter((suspect) => suspect.isPerpetrator);
  if (perpetrators.length !== 1 || perpetrators[0]?.id !== candidate.solution.perpetratorId) throw new Error("Exactly one suspect must match the solution");
  if (new Set(candidate.suspects.map(({ name }) => name.trim().toLowerCase())).size !== 3) throw new Error("Suspect names must be distinct");
  const opening = [candidate.shortSynopsis, candidate.incidentBriefing, ...candidate.publicFacts].join(" ").toLowerCase();
  for (const { name } of candidate.suspects) {
    if (opening.includes(name.trim().toLowerCase())) throw new Error("Opening report and public facts must not name suspects");
  }
}

function caseIdentity(payload: unknown) {
  const parsed = z.object({
    caseId: z.string().min(1),
    suspects: z.array(z.object({ id: z.string(), name: z.string() })),
    solution: z.object({ perpetratorId: z.string(), motive: z.string() }),
  }).safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function assertSameCase(identity: ReturnType<typeof caseIdentity>, candidate: GeneratedCase) {
  if (!identity) return;
  if (candidate.caseId !== identity.caseId || candidate.solution.perpetratorId !== identity.solution.perpetratorId ||
      candidate.solution.motive !== identity.solution.motive ||
      (new Set(identity.suspects.map(({ name }) => name)).size === 3 &&
       identity.suspects.some(({ name }) => !candidate.suspects.some((suspect) => suspect.name === name)))) {
    throw new Error("Correction changed the original case ID, characters, culprit, or motive");
  }
}
