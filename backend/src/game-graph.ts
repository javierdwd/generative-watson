import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import { END, START, StateGraph, StateSchema } from "@langchain/langgraph";
import { z } from "zod";
import type {
  ChatMessage,
  EvidenceId,
  GameAction,
  GameState,
  GameView,
  GeneratedCase,
  SuspectId,
} from "./types.js";
import { evidenceIds, GameActionError, suspectIds } from "./types.js";
import { log } from "./logging.js";

const GAME_SECONDS = 10 * 60;
const actionKinds = ["initialize", "start", "select", "message", "reveal", "accuse", "timeout"] as const;
let aiClient: OpenAI | undefined;
let typesafeClient: TypeSafeClient | undefined;

function openAI(): OpenAI {
  aiClient ??= new OpenAI({ timeout: 60_000, maxRetries: 0 });
  return aiClient;
}

function jev(): TypeSafeClient {
  typesafeClient ??= new TypeSafeClient({
    defaultModel: process.env.TYPESAFE_MODEL || "jev-latest",
    timeout: 60_000,
    logLevel: "info",
  });
  return typesafeClient;
}

const DialogueSchema = z.object({ text: z.string().min(1).max(1000) });

export function visibleAlibis(
  caseData: GeneratedCase,
  interviewedSuspectIds: readonly SuspectId[],
) {
  return caseData.suspects
    .filter(({ id }) => interviewedSuspectIds.includes(id))
    .map(({ name, publicAlibi }) => ({ name, publicAlibi }));
}

const TransitionState = new StateSchema({
  caseData: z.custom<GeneratedCase>(),
  game: z.custom<GameState | null>(),
  action: z.custom<GameAction>(),
  route: z.enum(actionKinds).default("initialize"),
});

type Transition = typeof TransitionState.State;

function requireGame(game: GameState | null): GameState {
  if (!game) throw new GameActionError("No active game session", 401);
  return game;
}

function requireInvestigation(game: GameState | null): GameState {
  const active = requireGame(game);
  if (active.status !== "investigating") {
    throw new GameActionError("Action is not available in this game state");
  }
  return active;
}

function newMessage(
  text: string,
  speaker: ChatMessage["speaker"],
  suspectId: SuspectId | null = null,
): ChatMessage {
  return { id: crypto.randomUUID(), speaker, suspectId, text };
}

function suspectEntry(caseData: GeneratedCase, suspectId: SuspectId): ChatMessage[] {
  const suspect = caseData.suspects.find((person) => person.id === suspectId);
  if (!suspect) throw new GameActionError("Suspect is not in this case");
  return [
    newMessage(`Now questioning: ${suspect.name}`, "system"),
    newMessage(`I had nothing to do with this. ${suspect.publicAlibi}`, "suspect", suspectId),
  ];
}

async function decideMessage(
  caseData: GeneratedCase,
  game: GameState,
  text: string,
  signal?: AbortSignal,
) {
  const hiddenEvidence = caseData.evidence.filter(
    (item) => !game.discoveredEvidenceIds.includes(item.id),
  );
  const questions = {
    speaker: choice(
      "Who should answer this detective message? Choose prosecutor for explicit Prosecutor requests or neutral questions about public case context. Choose suspect for interview questions or claims directed to the currently interviewed suspect.",
      { prosecutor: "Public case context or explicit Prosecutor request", suspect: "Question or claim directed to an interviewed suspect" },
    ),
    target: choice(
      "Does the detective explicitly ask to speak to another named suspect? Choose that suspect's ID, or none if there is no explicit request.",
      {
        none: "No explicit request to change suspect",
        ...Object.fromEntries(caseData.suspects.map((suspect) => [suspect.id, `Explicitly asks to speak with ${suspect.name}`])),
      },
    ),
    ...Object.fromEntries(hiddenEvidence.map((item) => [
      `unlock_${item.id}`,
      noul(
        "Does the message clearly and meaningfully refer to this specific evidence item or a close semantic equivalent? Do not count vague requests for clues, unrelated words, or mere speculation.",
        { true: `${item.name}: ${item.description}. Triggers: ${item.unlockTriggers.join("; ")}`, false: "Does not meaningfully identify this evidence item" },
      ),
    ])),
  };
  const started = Date.now();
  log.info({ caseId: caseData.caseId, stage: "routing" }, "Jev message decision started");
  const result = await jev().systemOne({
    model: process.env.TYPESAFE_MODEL || "jev-latest",
    state: {
      message: text,
      activeSuspectId: game.activeSuspectId,
      suspects: caseData.suspects.map(({ id, name }) => ({ id, name })),
      recentConversation: game.messages.slice(-12),
    },
    questions,
  }, { signal });
  log.info({ caseId: caseData.caseId, stage: "routing", elapsedMs: Date.now() - started }, "Jev message decision completed");
  return parseMessageDecision(caseData, hiddenEvidence.map(({ id }) => id), text, result.answers);
}

export function parseMessageDecision(caseData: GeneratedCase, hiddenIds: readonly EvidenceId[], text: string, answers: unknown) {
  const choices = z.object({
    speaker: z.object({ choice: z.enum(["prosecutor", "suspect"]) }),
    target: z.object({ choice: z.enum(["none", ...suspectIds]) }),
  }).parse(answers);
  const requestedTarget = choices.target.choice;
  const targetSuspectId = requestedTarget === "none"
    ? null
    : suspectIds.find((id) => id === requestedTarget) ?? null;
  if (targetSuspectId && !caseData.suspects.some(({ id }) => id === targetSuspectId)) {
    throw new GameActionError("Invalid suspect decision", 502);
  }
  const answerMap = z.record(z.string(), z.unknown()).parse(answers);
  const unlocked = hiddenIds.filter((id) => {
    if (!caseData.evidence.some((item) => item.id === id)) throw new GameActionError("Invalid evidence decision", 502);
    const answer = z.object({ noul: z.number().min(0).max(1) }).parse(answerMap[`unlock_${id}`]);
    return answer.noul >= 0.75;
  });
  const explicitProsecutor = /^\s*prosecutor\b/i.test(text);
  return {
    speaker: explicitProsecutor ? "prosecutor" as const : choices.speaker.choice,
    targetSuspectId: explicitProsecutor ? null : targetSuspectId,
    unlocked,
  };
}

async function writeDialogue(
  caseData: GeneratedCase,
  speaker: "prosecutor" | "suspect",
  suspectId: SuspectId | null,
  knownSuspectIds: SuspectId[],
  discoveredIds: EvidenceId[],
  detectiveText: string,
  history: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const publicContext = {
    incidentBriefing: caseData.incidentBriefing,
    publicFacts: caseData.publicFacts,
    publicAlibis: visibleAlibis(caseData, knownSuspectIds),
    discoveredEvidence: caseData.evidence
      .filter((item) => discoveredIds.includes(item.id))
      .map(({ name, description }) => ({ name, description })),
  };
  let instructions = `Write one concise natural English reply (at most 80 words). Answer the detective's actual message first. Use only facts in the supplied case context. Do not invent people, objects, events, times, or evidence. Do not mention game mechanics or reveal the solution.`;
  let context: Record<string, unknown> = { publicCase: publicContext };

  if (speaker === "prosecutor") {
    instructions += ` You are the Prosecutor. Answer only from public facts, without suggesting leads, identifying contradictions, or assessing credibility. Report interviewed alibis and conversation statements as attributed claims, never established truths. If the answer is not established, say you cannot confirm it.`;
  } else {
    const suspect = caseData.suspects.find((person) => person.id === suspectId);
    if (!suspect) throw new GameActionError("No suspect is selected for this reply");
    instructions += ` You are ${suspect.name}. Speak in first person and match this behavior: ${suspect.behavior}. Never speak for another person.`;
    context = {
      ...context,
      yourPublicAlibi: suspect.publicAlibi,
      yourPrivateKnowledge: suspect.privateKnowledge,
    };
    if (suspect.isPerpetrator) {
      instructions += ` You are the culprit. You may deny, omit, minimize, or distort established facts, but do not confess before an accusation. Do not introduce new facts or reveal undiscovered evidence. Deflect contradictions.`;
      context = {
        ...context,
        canonicalCase: caseData.fullCase,
        timeline: caseData.timeline,
        solution: caseData.solution,
      };
    } else {
      instructions += ` Your account is truthful. Speak only from your alibi and private knowledge. Say when you do not know.`;
    }
  }

  const started = Date.now();
  log.info({ caseId: caseData.caseId, stage: "dialogue", speaker }, "Dialogue generation started");
  const response = await openAI().responses.parse({
    model: process.env.OPENAI_MODEL || "gpt-6.1-sol",
    instructions,
    input: JSON.stringify({ context, recentConversation: history.slice(-12), detectiveMessage: detectiveText }),
    reasoning: { effort: "low" },
    text: { format: zodTextFormat(DialogueSchema, "dialogue_line") },
    store: false,
  }, { signal });
  if (response.status !== "completed") throw new GameActionError("Dialogue response was incomplete", 502);
  log.info({ caseId: caseData.caseId, stage: "dialogue", elapsedMs: Date.now() - started }, "Dialogue generation completed");
  return DialogueSchema.parse(response.output_parsed).text;
}

function guard(state: Transition) {
  const { action, game } = state;
  if (action.kind === "initialize") {
    if (game) throw new GameActionError("Game already initialized");
    return { route: "initialize" as const };
  }
  if (action.kind === "start") {
    if (game?.status !== "briefing") throw new GameActionError("Game is not awaiting a start");
    return { route: "start" as const };
  }
  const active = requireInvestigation(game);
  const expired = !active.deadlineAt || Date.now() >= Date.parse(active.deadlineAt);
  if (action.kind === "timeout") {
    if (!expired) throw new GameActionError("The investigation has not timed out");
    return { route: "timeout" as const };
  }
  if (expired) return { route: "timeout" as const };
  if (action.kind === "select") return { route: "select" as const };
  if (action.kind === "message") return { route: "message" as const };
  if (action.kind === "reveal") return { route: "reveal" as const };
  if (action.kind === "accuse") return { route: "accuse" as const };
  throw new GameActionError("Unknown game action");
}

function initializeNode(): { game: GameState } {
  return {
    game: {
      status: "briefing",
      activeSuspectId: null,
      discoveredEvidenceIds: [],
      deadlineAt: null,
      messages: [],
      newEvidenceIds: [],
      ending: null,
    },
  };
}

function startNode(state: Transition): { game: GameState } {
  const deadlineAt = new Date(Date.now() + GAME_SECONDS * 1000).toISOString();
  const firstMessage = newMessage(state.caseData.incidentBriefing, "prosecutor");
  return {
    game: {
      status: "investigating",
      activeSuspectId: null,
      discoveredEvidenceIds: [],
      deadlineAt,
      messages: [firstMessage],
      newEvidenceIds: [],
      ending: null,
    },
  };
}

function selectNode(state: Transition): { game: GameState } {
  const game = requireInvestigation(state.game);
  if (state.action.kind !== "select" || !suspectIds.includes(state.action.suspectId as SuspectId)) {
    throw new GameActionError("Invalid suspect ID", 422);
  }
  const suspectId = state.action.suspectId as SuspectId;
  if (!state.caseData.suspects.some((person) => person.id === suspectId)) {
    throw new GameActionError("Suspect is not in this case", 422);
  }
  if (game.activeSuspectId === suspectId) return { game: { ...game, newEvidenceIds: [] } };
  return {
    game: {
      ...game,
      activeSuspectId: suspectId,
      messages: [...game.messages, ...suspectEntry(state.caseData, suspectId)],
      newEvidenceIds: [],
    },
  };
}

export type GameServices = {
  decideMessage: typeof decideMessage;
  writeDialogue: typeof writeDialogue;
};

function hasExpired(game: GameState) {
  return !game.deadlineAt || Date.now() >= Date.parse(game.deadlineAt);
}

async function messageNode(state: Transition, services: Partial<GameServices>): Promise<{ game: GameState }> {
  const game = requireInvestigation(state.game);
  if (state.action.kind !== "message" || !state.action.text.trim()) {
    throw new GameActionError("Message cannot be empty", 422);
  }
  const text = state.action.text.trim();
  const messageId = state.action.messageId;
  if (messageId) {
    const existing = game.messages.find((message) => message.id === messageId);
    if (existing) {
      if (existing.speaker !== "detective" || existing.text !== text) {
        throw new GameActionError("Message ID is already in use", 409);
      }
      return { game: { ...game, newEvidenceIds: [] } };
    }
  }
  const signal = AbortSignal.timeout(Math.max(1, Date.parse(game.deadlineAt!) - Date.now()));
  try {
    const decision = await (services.decideMessage ?? decideMessage)(state.caseData, game, text, signal);
    if (hasExpired(game)) return timeoutNode(state);
    const target = decision.targetSuspectId;
    if (target && !state.caseData.suspects.some((person) => person.id === target)) {
      throw new GameActionError("Invalid suspect decision", 502);
    }
    const activeId = target ?? game.activeSuspectId;
    const requestedSpeaker = target ? "suspect" : decision.speaker;
    const speaker = requestedSpeaker === "suspect" && !activeId
      ? "prosecutor"
      : requestedSpeaker;
    const visible = [...game.discoveredEvidenceIds, ...decision.unlocked];
    const knownSuspectIds = new Set(
      game.messages
        .filter((message) => message.speaker === "suspect" && message.suspectId !== null)
        .map((message) => message.suspectId as SuspectId),
    );
    if (target) knownSuspectIds.add(target);
    const reply = await (services.writeDialogue ?? writeDialogue)(
      state.caseData,
      speaker,
      speaker === "suspect" ? activeId : null,
      [...knownSuspectIds],
      visible,
      text,
      game.messages,
      signal,
    );
    if (hasExpired(game)) return timeoutNode(state);
    const detectiveMessage = newMessage(text, "detective");
    if (messageId) detectiveMessage.id = messageId;
    const messages = [...game.messages, detectiveMessage];
    if (target && target !== game.activeSuspectId) messages.push(...suspectEntry(state.caseData, target));
    for (const evidenceId of decision.unlocked) {
      const item = state.caseData.evidence.find((entry) => entry.id === evidenceId);
      if (item) messages.push(newMessage(`New evidence discovered: ${item.emoji} ${item.name}.`, "system"));
    }
    messages.push(newMessage(reply, speaker, speaker === "suspect" ? activeId : null));
    return {
      game: {
        ...game,
        activeSuspectId: activeId,
        discoveredEvidenceIds: visible,
        messages,
        newEvidenceIds: decision.unlocked,
      },
    };
  } catch (error) {
    if (hasExpired(game)) return timeoutNode(state);
    throw error;
  }
}

function revealNode(state: Transition): { game: GameState } {
  const game = requireInvestigation(state.game);
  if (state.action.kind !== "reveal" || !Number.isInteger(state.action.slot)) {
    throw new GameActionError("Invalid evidence slot", 422);
  }
  const item = state.caseData.evidence[state.action.slot - 1];
  if (!item || state.action.slot < 1 || state.action.slot > 3) {
    throw new GameActionError("Evidence slot is not in this case", 404);
  }
  if (game.discoveredEvidenceIds.includes(item.id)) {
    return { game: { ...game, newEvidenceIds: [] } };
  }
  return {
    game: {
      ...game,
      discoveredEvidenceIds: [...game.discoveredEvidenceIds, item.id],
      newEvidenceIds: [item.id],
      messages: [...game.messages, newMessage(`Evidence revealed: ${item.emoji} ${item.name}.`, "system")],
    },
  };
}

function accuseNode(state: Transition): { game: GameState } {
  const game = requireInvestigation(state.game);
  if (state.action.kind !== "accuse" || !suspectIds.includes(state.action.suspectId as SuspectId)) {
    throw new GameActionError("Invalid suspect ID", 422);
  }
  const accused = state.action.suspectId as SuspectId;
  if (!state.caseData.suspects.some((person) => person.id === accused)) {
    throw new GameActionError("Suspect is not in this case", 422);
  }
  const correct = accused === state.caseData.solution.perpetratorId;
  return {
    game: {
      ...game,
      status: correct ? "success" : "failure",
      ending: {
        accusedSuspectId: accused,
        perpetratorId: state.caseData.solution.perpetratorId,
        explanation: state.caseData.solution.playerFacingExplanation,
      },
      newEvidenceIds: [],
    },
  };
}

function timeoutNode(state: Transition): { game: GameState } {
  const game = requireGame(state.game);
  return {
    game: {
      ...game,
      status: "timeout",
      ending: {
        accusedSuspectId: null,
        perpetratorId: state.caseData.solution.perpetratorId,
        explanation: state.caseData.solution.playerFacingExplanation,
      },
      newEvidenceIds: [],
    },
  };
}

export function createGameGraph(services: Partial<GameServices> = {}) {
  return new StateGraph(TransitionState)
    .addNode("guard", guard)
    .addNode("initialize", initializeNode)
    .addNode("start", startNode)
    .addNode("select", selectNode)
    .addNode("message", (state) => messageNode(state, services))
    .addNode("reveal", revealNode)
    .addNode("accuse", accuseNode)
    .addNode("timeout", timeoutNode)
    .addEdge(START, "guard")
    .addConditionalEdges("guard", (state) => state.route, ["initialize", "start", "select", "message", "reveal", "accuse", "timeout"])
    .addEdge("initialize", END)
    .addEdge("start", END)
    .addEdge("select", END)
    .addEdge("message", END)
    .addEdge("reveal", END)
    .addEdge("accuse", END)
    .addEdge("timeout", END)
    .compile();
}

export const gameGraph = createGameGraph();

export async function transitionGame(
  caseData: GeneratedCase,
  game: GameState | null,
  action: GameAction,
): Promise<GameState> {
  const result = await gameGraph.invoke({ caseData, game, action });
  if (!result.game) throw new GameActionError("Graph did not return game state", 500);
  return result.game;
}

export function toGameView(caseData: GeneratedCase, game: GameState): GameView {
  if (!game.deadlineAt) throw new GameActionError("Investigation has not started");
  return {
    caseId: caseData.caseId,
    status: game.status as GameView["status"],
    suspects: caseData.suspects.map(({ id, name, emoji }) => ({ id, name, emoji })),
    evidence: caseData.evidence.map((item, index) => {
      const discovered = game.discoveredEvidenceIds.includes(item.id);
      return {
        slot: index + 1,
        discovered,
        label: discovered ? item.name : "❓ Unknown evidence",
        id: discovered ? item.id : null,
        emoji: discovered ? item.emoji : null,
        name: discovered ? item.name : null,
        description: discovered ? item.description : null,
      };
    }),
    activeSuspectId: game.activeSuspectId,
    deadlineAt: game.deadlineAt,
    messages: game.messages,
    newEvidenceIds: game.newEvidenceIds,
    ending: game.ending,
  };
}

export async function evaluateHeat(caseData: GeneratedCase, text: string): Promise<number> {
  if (!text.trim()) return 0.5;
  const started = Date.now();
  log.info({ caseId: caseData.caseId, stage: "relevance" }, "Jev relevance evaluation started");
  const result = await jev().systemOne({
    model: process.env.TYPESAFE_MODEL || "jev-latest",
    state: {
      draft: text,
      evidence: caseData.evidence.map(({ name, description, solutionRelevance }) => ({ name, description, solutionRelevance })),
      solution: caseData.solution.reasoning,
    },
    questions: {
      heat: score(
        "Rate how relevant the entire draft question, claim, or theory is to the case evidence and true solution. Do not require an exact evidence name. This is advisory only.",
        [
          "Unrelated to the mystery",
          "Touches broad case context only",
          "Related to a possible clue or timeline fact",
          "Closely examines a real clue or alibi inconsistency",
          "Strongly connects evidence to the actual solution",
        ],
      ),
    },
  });
  const value = z.number().min(0).max(4).parse(result.answers.heat.score) / 4;
  log.info({ caseId: caseData.caseId, stage: "relevance", elapsedMs: Date.now() - started }, "Jev relevance evaluation completed");
  return value;
}
