import type { GeneratedCase } from "./types.js";

export const sampleCase: GeneratedCase = {
  caseId: "sample-case",
  crimeType: "robbery",
  shortSynopsis: "A rare compass disappeared from a small museum.",
  incidentBriefing: "A rare compass disappeared from the museum map room at closing time.",
  fullCase: "A short private account of the case.",
  timeline: [{ time: "8:00 PM", event: "The map room closed." }],
  publicFacts: ["The museum closes at eight.", "The map room is on the ground floor."],
  suspects: [
    { id: "suspect_1", name: "Mara Vale", emoji: "🧭", publicAlibi: "I was at the front desk.", privateKnowledge: ["I logged the visitors."], behavior: "Calm", isPerpetrator: true },
    { id: "suspect_2", name: "Noor Ellis", emoji: "📚", publicAlibi: "I was in the archive.", privateKnowledge: ["I shelved two books."], behavior: "Careful", isPerpetrator: false },
    { id: "suspect_3", name: "Theo Marsh", emoji: "🕰️", publicAlibi: "I was in the courtyard.", privateKnowledge: ["I heard the bell."], behavior: "Warm", isPerpetrator: false },
  ],
  evidence: [
    { id: "evidence_1", emoji: "🧤", name: "Blue glove", description: "A blue glove rests beside the empty display.", unlockTriggers: ["glove", "display"], solutionRelevance: "Places the culprit at the display." },
    { id: "evidence_2", emoji: "🗝️", name: "Spare key", description: "The spare key has fresh dust marks.", unlockTriggers: ["key", "dust"], solutionRelevance: "Explains access to the room." },
    { id: "evidence_3", emoji: "🧾", name: "Visitor log", description: "One entry was changed after closing.", unlockTriggers: ["log", "visitor"], solutionRelevance: "Contradicts the culprit's alibi." },
  ],
  solution: {
    perpetratorId: "suspect_1",
    method: "Used the spare key to enter the map room.",
    motive: "Mara planned to sell the compass to cover a debt.",
    alibiFlaws: ["The visitor log shows Mara returned after closing."],
    reasoning: "The changed visitor log and glove place Mara by the display.",
    playerFacingExplanation: "Mara used the spare key and changed the log to hide her return.",
  },
};
