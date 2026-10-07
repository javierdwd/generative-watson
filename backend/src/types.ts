export const suspectIds = ["suspect_1", "suspect_2", "suspect_3"] as const;
export const evidenceIds = ["evidence_1", "evidence_2", "evidence_3"] as const;

export type SuspectId = (typeof suspectIds)[number];
export type EvidenceId = (typeof evidenceIds)[number];
export type CrimeType = "homicide" | "robbery";
export type Speaker = "detective" | "prosecutor" | "suspect" | "system";
export type GameStatus = "briefing" | "investigating" | "success" | "failure" | "timeout";

export type TimelineEvent = { time: string; event: string };
export type Suspect = {
  id: SuspectId;
  name: string;
  emoji: string;
  publicAlibi: string;
  privateKnowledge: string[];
  behavior: string;
  isPerpetrator: boolean;
};
export type Evidence = {
  id: EvidenceId;
  emoji: string;
  name: string;
  description: string;
  unlockTriggers: string[];
  solutionRelevance: string;
};
export type GeneratedCase = {
  caseId: string;
  crimeType: CrimeType;
  shortSynopsis: string;
  incidentBriefing: string;
  fullCase: string;
  timeline: TimelineEvent[];
  publicFacts: string[];
  suspects: Suspect[];
  evidence: Evidence[];
  solution: {
    perpetratorId: SuspectId;
    method: string;
    motive: string;
    alibiFlaws: string[];
    reasoning: string;
    playerFacingExplanation: string;
  };
};

export type ChatMessage = {
  id: string;
  speaker: Speaker;
  suspectId: SuspectId | null;
  text: string;
};
export type Ending = {
  accusedSuspectId: SuspectId | null;
  perpetratorId: SuspectId;
  explanation: string;
};
export type GameState = {
  status: GameStatus;
  activeSuspectId: SuspectId | null;
  discoveredEvidenceIds: EvidenceId[];
  deadlineAt: string | null;
  messages: ChatMessage[];
  newEvidenceIds: EvidenceId[];
  ending: Ending | null;
};
export type GameSession = {
  sessionId: string;
  case: GeneratedCase;
  game: GameState;
  lastActivity: number;
  lock: Promise<void>;
};

export type GameAction =
  | { kind: "initialize" }
  | { kind: "start" }
  | { kind: "select"; suspectId: string }
  | { kind: "message"; text: string; messageId?: string }
  | { kind: "reveal"; slot: number }
  | { kind: "accuse"; suspectId: string }
  | { kind: "timeout" };

export type EvidenceView = {
  slot: number;
  discovered: boolean;
  label: string;
  id: EvidenceId | null;
  emoji: string | null;
  name: string | null;
  description: string | null;
};
export type GameView = {
  caseId: string;
  status: Exclude<GameStatus, "briefing">;
  suspects: Pick<Suspect, "id" | "name" | "emoji">[];
  evidence: EvidenceView[];
  activeSuspectId: SuspectId | null;
  deadlineAt: string;
  messages: ChatMessage[];
  newEvidenceIds: EvidenceId[];
  ending: Ending | null;
};

export class GameActionError extends Error {
  constructor(
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
    this.name = "GameActionError";
  }
}
