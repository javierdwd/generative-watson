"use client";

import { AnimatePresence, motion } from "motion/react";
import { useDetectiveAgent } from "../lib/use-detective-agent";
import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type Briefing = {
  caseId: string;
  crimeType: "homicide" | "robbery";
  shortSynopsis: string;
  incidentBriefing: string;
  status: "briefing";
};
type Suspect = { id: string; name: string; emoji: string };
type Evidence = {
  slot: number;
  discovered: boolean;
  label: string;
  id: string | null;
  emoji: string | null;
  name: string | null;
  description: string | null;
};
type ChatMessage = {
  id: string;
  speaker: "detective" | "prosecutor" | "suspect" | "system";
  suspectId: string | null;
  text: string;
};
type Game = {
  caseId: string;
  status: "investigating" | "success" | "failure" | "timeout";
  suspects: Suspect[];
  evidence: Evidence[];
  activeSuspectId: string | null;
  deadlineAt: string;
  messages: ChatMessage[];
  newEvidenceIds: string[];
  ending: {
    accusedSuspectId: string | null;
    perpetratorId: string;
    explanation: string;
  } | null;
};
type HeatResponse = { value: number; version: number };
type SolutionReveal = {
  caseId: string;
  perpetratorName: string;
  method: string;
  explanation: string;
};
type Screen = "loading" | "error" | "briefing" | "investigating" | "terminal";

function secondsLeft(deadlineAt: string, now: number) {
  return Math.max(0, Math.ceil((new Date(deadlineAt).getTime() - now) / 1000));
}

function formatTime(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return (
    String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
  );
}

function speakerLabel(message: ChatMessage, suspects: Suspect[]) {
  if (message.speaker === "detective") return "Detective";
  if (message.speaker === "prosecutor") return "Prosecutor";
  if (message.speaker === "system") return "Case note";
  return (
    suspects.find((suspect) => suspect.id === message.suspectId)?.name ??
    "Suspect"
  );
}

function speakerEmoji(message: ChatMessage, suspects: Suspect[]) {
  if (message.speaker === "detective") return "🕵️";
  if (message.speaker === "prosecutor") return "⚖️";
  return suspects.find((suspect) => suspect.id === message.suspectId)?.emoji ?? "👤";
}

function heatLabel(value: number) {
  if (value < 0.28) return "Cold";
  if (value > 0.72) return "Warm";
  return "In the room";
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [game, setGame] = useState<Game | null>(null);
  const [draft, setDraft] = useState("");
  const [heat, setHeat] = useState(0.5);
  const [busy, setBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  const [inlineError, setInlineError] = useState("");
  const [confirming, setConfirming] = useState<Suspect | null>(null);
  const [now, setNow] = useState(Date.now());
  const [loadingSeconds, setLoadingSeconds] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<"suspects" | "evidence">(
    "suspects",
  );
  const [revealingSlot, setRevealingSlot] = useState<number | null>(null);
  const [solution, setSolution] = useState<SolutionReveal | null>(null);
  const [solutionVisible, setSolutionVisible] = useState(false);
  const [solutionBusy, setSolutionBusy] = useState(false);
  const [solutionError, setSolutionError] = useState("");
  const bootStarted = useRef(false);
  const expiryStarted = useRef(false);
  const heatVersion = useRef(0);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activeCaseId = useRef<string | null>(null);
  const { agent, isReady, runCommand } = useDetectiveAgent(
    screen === "terminal" ? null : game?.caseId ?? briefing?.caseId ?? null,
  );

  useEffect(() => {
    if (confirming) {
      document.getElementById("keep-investigating")?.focus();
    }
  }, [confirming]);

  const startNewCase = useCallback(async () => {
    setScreen("loading");
    setLoadingSeconds(0);
    setBusy(false);
    setPageError("");
    setInlineError("");
    setBriefing(null);
    setGame(null);
    setDraft("");
    setHeat(0.5);
    heatVersion.current += 1;
    setConfirming(null);
    setRevealingSlot(null);
    setSolution(null);
    setSolutionVisible(false);
    setSolutionBusy(false);
    setSolutionError("");
    activeCaseId.current = null;
    expiryStarted.current = false;
    try {
      agent.threadId = crypto.randomUUID();
      agent.setMessages([]);
      agent.setState({});
      const nextBriefing = await runCommand<Briefing>({ kind: "new_case" });
      agent.threadId = nextBriefing.caseId;
      setBriefing(nextBriefing);
      setScreen("briefing");
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Could not prepare a case.",
      );
      setScreen("error");
    }
  }, [agent, runCommand]);

  useEffect(() => {
    if (bootStarted.current || !isReady) return;
    bootStarted.current = true;
    void startNewCase();
  }, [isReady, startNewCase]);

  useEffect(() => {
    if (isReady || bootStarted.current) return;
    const timer = window.setTimeout(() => {
      setPageError(
        "Could not connect to CopilotKit. Check that the frontend is running, then retry.",
      );
      setScreen("error");
    }, 15_000);
    return () => window.clearTimeout(timer);
  }, [isReady]);

  const remaining = useMemo(
    () => (game ? secondsLeft(game.deadlineAt, now) : 600),
    [game, now],
  );

  useEffect(() => {
    if (screen !== "investigating") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [screen]);

  useEffect(() => {
    if (screen !== "loading") return;
    const startedAt = Date.now();
    const timer = window.setInterval(
      () => setLoadingSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [screen]);

  const finishFromServer = useCallback((nextGame: Game) => {
    activeCaseId.current = nextGame.caseId;
    setGame(nextGame);
    setScreen(
      nextGame.status === "investigating" ? "investigating" : "terminal",
    );
    setBusy(false);
  }, []);

  useEffect(() => {
    const projectedGame = agent.state.game as Game | null | undefined;
    if (projectedGame) {
      activeCaseId.current = projectedGame.caseId;
      setGame(projectedGame);
      setScreen(projectedGame.status === "investigating" ? "investigating" : "terminal");
    }
  }, [agent.state]);

  const submitTimeout = useCallback(async () => {
    if (expiryStarted.current || busy || screen !== "investigating") return;
    expiryStarted.current = true;
    setBusy(true);
    try {
      finishFromServer(await runCommand<Game>({ kind: "timeout" }));
    } catch (error) {
      try {
        finishFromServer(await runCommand<Game>({ kind: "read" }));
      } catch (readError) {
        setInlineError(
          readError instanceof Error
            ? readError.message
            : error instanceof Error
              ? error.message
              : "The investigation could not be closed.",
        );
        expiryStarted.current = false;
        setBusy(false);
      }
    }
  }, [busy, finishFromServer, runCommand, screen]);

  useEffect(() => {
    if (screen === "investigating" && remaining === 0) void submitTimeout();
  }, [remaining, screen, submitTimeout]);

  useEffect(() => {
    if (!game || screen !== "investigating") return;
    const version = ++heatVersion.current;
    if (busy) {
      setHeat(0.5);
      return;
    }
    const text = draft.trim();
    if (!text) {
      setHeat(0.5);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const result = await runCommand<HeatResponse>({
          kind: "heat",
          text,
          version,
        });
        if (result.version === heatVersion.current) setHeat(result.value);
      } catch {
        // A heat failure does not interrupt the investigation.
      }
    }, 360);
    return () => window.clearTimeout(timer);
  }, [busy, draft, game?.caseId, runCommand, screen]);

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [game?.messages.length]);

  async function beginInvestigation() {
    setBusy(true);
    setPageError("");
    try {
      const nextGame = await runCommand<Game>({ kind: "start" });
      setNow(Date.now());
      finishFromServer(nextGame);
    } catch (error) {
      setPageError(
        error instanceof Error ? error.message : "Could not start the case.",
      );
      setBusy(false);
    }
  }

  async function postMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || screen !== "investigating") return;
    setBusy(true);
    setInlineError("");
    heatVersion.current += 1;
    setHeat(0.5);
    try {
      finishFromServer(await runCommand<Game>({ kind: "message", text }));
      setDraft("");
      composer.current?.focus();
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "Message could not be sent.",
      );
      setBusy(false);
    }
  }

  async function changeSuspect(suspect: Suspect) {
    if (!game || busy || suspect.id === game.activeSuspectId) return;
    setBusy(true);
    setInlineError("");
    try {
      finishFromServer(
        await runCommand<Game>({ kind: "select", suspectId: suspect.id }),
      );
    } catch (error) {
      setInlineError(
        error instanceof Error ? error.message : "Could not change suspect.",
      );
      setBusy(false);
    }
  }

  async function confirmAccusation() {
    if (!confirming || busy) return;
    setBusy(true);
    setInlineError("");
    try {
      setConfirming(null);
      finishFromServer(
        await runCommand<Game>({ kind: "accuse", suspectId: confirming.id }),
      );
    } catch (error) {
      setInlineError(
        error instanceof Error
          ? error.message
          : "The accusation could not be made.",
      );
      setBusy(false);
    }
  }

  async function revealEvidence(slot: number) {
    if (!game || busy || revealingSlot !== null) return;
    const requestedCaseId = game.caseId;
    setRevealingSlot(slot);
    setBusy(true);
    setInlineError("");
    try {
      const updated = await runCommand<Game>({ kind: "reveal", slot });
      if (activeCaseId.current === requestedCaseId) finishFromServer(updated);
    } catch (error) {
      if (activeCaseId.current === requestedCaseId) {
        setInlineError(
          error instanceof Error
            ? error.message
            : "Could not reveal this clue.",
        );
        setBusy(false);
      }
    } finally {
      setRevealingSlot(null);
    }
  }

  async function toggleSolution() {
    if (!game || solutionBusy) return;
    if (solution?.caseId === game.caseId) {
      setSolutionVisible((visible) => !visible);
      return;
    }
    const requestedCaseId = game.caseId;
    setSolutionBusy(true);
    setSolutionError("");
    try {
      const revealed = await runCommand<SolutionReveal>({ kind: "solution" });
      if (
        activeCaseId.current !== requestedCaseId ||
        revealed.caseId !== requestedCaseId
      )
        return;
      setSolution(revealed);
      setSolutionVisible(true);
    } catch (error) {
      if (activeCaseId.current === requestedCaseId) {
        setSolutionError(
          error instanceof Error
            ? error.message
            : "Could not display the solution.",
        );
      }
    } finally {
      if (activeCaseId.current === requestedCaseId) setSolutionBusy(false);
    }
  }

  function handleComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  if (screen === "loading") {
    return (
      <main className="app-shell loading-shell">
        <header className="topbar">
          <Brand />
        </header>
        <section className="loading-card" aria-live="polite">
          <span className="file-stamp">Case intake</span>
          <div className="loading-mark" aria-hidden="true">
            ◉
          </div>
          <h1>Preparing a new case</h1>
          <p>
            {loadingSeconds < 30
              ? "Checking the facts before the file reaches your desk."
              : loadingSeconds < 90
                ? "The case is still being written and checked. This can take about a minute."
                : "Final fact check in progress. Keep this tab open; the file will appear here when it’s ready."}
          </p>
          <div className="loading-rule">
            <span />
          </div>
        </section>
      </main>
    );
  }

  if (screen === "error") {
    return (
      <main className="app-shell loading-shell">
        <header className="topbar">
          <Brand />
          <span className="topbar-note">Case intake</span>
        </header>
        <section className="loading-card error-card" role="alert">
          <span className="file-stamp">File not ready</span>
          <h1>We couldn’t prepare this case.</h1>
          <p>{pageError || "The case service did not return a valid file."}</p>
          <button
            className="button button-primary"
            onClick={() => void startNewCase()}
          >
            Try again
          </button>
        </section>
      </main>
    );
  }

  if (screen === "briefing" && briefing) {
    return (
      <main className="app-shell briefing-shell">
        <header className="topbar">
          <Brand />
          <span className="topbar-note">Intake desk · Case pending</span>
        </header>
        <section className="briefing-layout">
          <div className="briefing-copy">
            <span className="file-stamp">
              Incident report · {briefing.crimeType}
            </span>
            <p className="briefing-kicker">The facts before the interviews</p>
            <h1>
              What happened
              <br />
              at the scene?
            </h1>
            <p className="incident-briefing">{briefing.incidentBriefing}</p>
            <p className="briefing-summary">{briefing.shortSynopsis}</p>
            <button
              className="button button-primary begin-button"
              onClick={() => void beginInvestigation()}
              disabled={busy}
            >
              {busy ? "Opening the file…" : "Investigate"}
              <span aria-hidden="true">↗</span>
            </button>
            {pageError && (
              <p className="form-error" role="alert">
                {pageError}
              </p>
            )}
            <p className="briefing-note">
              The ten-minute clock starts when you enter the room.
            </p>
          </div>
          <aside className="briefing-art" aria-label="Case folder illustration">
            <div className="folder-shadow" />
            <div className="folder">
              <div className="folder-tab">INTAKE</div>
              <div className="folder-paper">
                <div className="paper-line paper-line-short" />
                <div className="paper-line" />
                <div className="paper-line paper-line-medium" />
                <div className="paper-seal">?</div>
                <span>CONFIDENTIAL</span>
              </div>
              <div className="folder-mark">AD</div>
            </div>
            <div className="briefing-caption">
              Handle with care.
              <br />
              The facts are still settling.
            </div>
          </aside>
        </section>
        <footer className="briefing-footer">
          <span>AI Detective</span>
          <span>One case · One decision</span>
        </footer>
      </main>
    );
  }

  if (!game) return null;
  const activeSuspect = game.suspects.find(
    (person) => person.id === game.activeSuspectId,
  );
  const perpetrator = game.suspects.find(
    (person) => person.id === game.ending?.perpetratorId,
  );
  const accused = game.suspects.find(
    (person) => person.id === game.ending?.accusedSuspectId,
  );
  const timerClass = remaining <= 60 ? "timer timer-danger" : "timer";

  if (screen === "terminal") {
    const succeeded = game.status === "success";
    const timedOut = game.status === "timeout";
    return (
      <main className="app-shell terminal-shell">
        <header className="topbar">
          <Brand />
          <span className="topbar-note">Investigation closed</span>
        </header>
        <section className="resolution">
          <div
            className={"resolution-mark " + (succeeded ? "mark-success" : "")}
          >
            {succeeded ? "✓" : timedOut ? "◷" : "×"}
          </div>
          <span className="file-stamp">
            {succeeded
              ? "Correct accusation"
              : timedOut
                ? "Time expired"
                : "Wrong accusation"}
          </span>
          <h1>
            {succeeded
              ? "You solved the case."
              : timedOut
                ? "The room has gone quiet."
                : "The case remains unsolved."}
          </h1>
          <p className="resolution-lede">
            {succeeded
              ? (accused?.name ?? perpetrator?.name) + " was responsible."
              : timedOut
                ? "The investigation ran out of time."
                : (accused?.name ?? "Your suspect") +
                  " was not the perpetrator."}
          </p>
          <article className="explanation-sheet">
            <span>What happened</span>
            <p>{game.ending?.explanation}</p>
          </article>
          <button
            className="button button-primary"
            onClick={() => void startNewCase()}
            disabled={busy}
          >
            Open a new case
          </button>
        </section>
        <footer className="briefing-footer">
          <span>AI Detective</span>
          <span>Case closed</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="app-shell investigation-shell">
      <header className="topbar game-topbar">
        <Brand />
        <div
          className={timerClass}
          aria-label={formatTime(remaining) + " remaining"}
        >
          <span className="timer-glyph" aria-hidden="true">
            ◷
          </span>
          <span>{formatTime(remaining)}</span>
          <small>remaining</small>
        </div>
        <button
          className="quiet-button"
          onClick={() => void startNewCase()}
          disabled={busy}
        >
          New case
        </button>
      </header>

      <div className="investigation-grid">
        <aside
          className={
            "left-rail " + (mobilePanel === "suspects" ? "mobile-active" : "")
          }
        >
          <div className="rail-heading">
            <span className="file-stamp">Interview room</span>
            <h2>People in the file</h2>
            <p>Choose who is answering.</p>
          </div>
          <div className="suspect-list">
            {game.suspects.map((suspect) => {
              const active = suspect.id === game.activeSuspectId;
              return (
                <article
                  key={suspect.id}
                  className={"suspect-card " + (active ? "suspect-active" : "")}
                >
                  <button
                    className="suspect-select"
                    onClick={() => void changeSuspect(suspect)}
                    disabled={busy || active}
                    aria-pressed={active}
                  >
                    <span className="suspect-emoji" aria-hidden="true">
                      {suspect.emoji}
                    </span>
                    <span className="suspect-copy">
                      <strong>{suspect.name}</strong>
                      <small>
                        {active
                          ? "Currently questioning"
                          : "Select for interview"}
                      </small>
                    </span>
                    {active && (
                      <span
                        className="active-dot"
                        aria-label="Active suspect"
                      />
                    )}
                  </button>
                  <button
                    className="accuse-button"
                    onClick={() => setConfirming(suspect)}
                    disabled={busy}
                  >
                    Accuse
                  </button>
                </article>
              );
            })}
          </div>
          <div className="clock-note">
            <span className="clock-note-icon" aria-hidden="true">
              ⌁
            </span>
            <p>The clock keeps moving while you think.</p>
          </div>
        </aside>

        <section
          className="chat-column"
          aria-label="Investigation conversation"
        >
          <div className="case-strip">
            <div>
              <span className="case-strip-label">Investigation</span>
              <h1>
                {activeSuspect
                  ? "Questioning " + activeSuspect.name
                  : "The interview room"}
              </h1>
            </div>
            <div className="case-strip-actions">
              <span className="case-open-indicator">
                <i /> Active
              </span>
              <button
                className="solution-button"
                type="button"
                onClick={() => void toggleSolution()}
                disabled={solutionBusy}
                aria-expanded={
                  solutionVisible && solution?.caseId === game.caseId
                }
                aria-controls={
                  solutionVisible && solution?.caseId === game.caseId
                    ? "solution-reveal"
                    : undefined
                }
              >
                {solutionBusy
                  ? "Loading…"
                  : solutionVisible
                    ? "Hide solution"
                    : "Display solution"}
                <span>DEBUG</span>
              </button>
            </div>
          </div>

          {solutionError && (
            <p className="solution-error" role="alert">
              {solutionError}
            </p>
          )}
          {solutionVisible && solution?.caseId === game.caseId && (
            <aside
              id="solution-reveal"
              className="solution-reveal"
              aria-label="Debug case solution"
            >
              <span className="file-stamp">Debug · Case solution</span>
              <strong>{solution.perpetratorName}</strong>
              <p>
                <b>Method:</b> {solution.method}
              </p>
              <small>{solution.explanation}</small>
            </aside>
          )}

          <div
            className="mobile-panel-switch"
            role="tablist"
            aria-label="Investigation panels"
          >
            <button
              role="tab"
              aria-selected={mobilePanel === "suspects"}
              onClick={() => setMobilePanel("suspects")}
            >
              Suspects
            </button>
            <button
              role="tab"
              aria-selected={mobilePanel === "evidence"}
              onClick={() => setMobilePanel("evidence")}
            >
              Evidence{" "}
              <span>
                {game.evidence.filter((item) => item.discovered).length}/3
              </span>
            </button>
          </div>

          <div className="transcript" aria-live="polite">
            <div className="transcript-date">
              <span>Interview record</span>
            </div>
            {game.messages.map((message) => (
              <article
                key={message.id}
                className={"message message-" + message.speaker}
              >
                {message.speaker === "detective" ? (
                  <div className="message-meta">
                    <span><span aria-hidden="true">🕵️ </span>Detective</span>
                    <i />
                  </div>
                ) : message.speaker === "system" ? (
                  <div className="message-divider">
                    <span>{message.text}</span>
                  </div>
                ) : (
                  <>
                    <div className="message-meta">
                      <span><span aria-hidden="true">{speakerEmoji(message, game.suspects)} </span>{speakerLabel(message, game.suspects)}</span>
                      {message.speaker === "prosecutor" && (
                        <small>CASE CONTEXT</small>
                      )}
                    </div>
                    <p>{message.text}</p>
                  </>
                )}
                {message.speaker === "detective" && <p>{message.text}</p>}
              </article>
            ))}
            {busy && screen === "investigating" && (
              <div className="thinking-note" role="status">
                <span />
                <span />
                <span /> Reviewing the record
              </div>
            )}
            <div ref={transcriptEnd} />
          </div>

          {inlineError && (
            <p className="inline-error" role="alert">
              {inlineError}
            </p>
          )}
          <form className="composer" onSubmit={postMessage}>
            <label htmlFor="detective-message">
              Add to the interview record
            </label>
            <div className="composer-box">
              <textarea
                id="detective-message"
                ref={composer}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleComposerKey}
                placeholder="Ask a question, test a detail, or state a theory…"
                maxLength={4000}
                disabled={busy || remaining === 0}
                rows={2}
              />
              <div className="composer-tools">
                <span>Enter to send · Shift + Enter for a new line</span>
                <button
                  className="send-button"
                  type="submit"
                  disabled={!draft.trim() || busy || remaining === 0}
                  aria-label="Send message"
                >
                  <span>Send</span>
                  <span aria-hidden="true">↗</span>
                </button>
              </div>
            </div>
            <div
              className="heat-row"
              role="meter"
              aria-label={"Relevance: " + heatLabel(heat)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(heat * 100)}
              aria-valuetext={heatLabel(heat)}
            >
              <span>Relevance</span>
              <div className="heat-gauge" aria-hidden="true">
                <span>🔥</span>
                <div className="heat-track">
                  <i style={{ bottom: Math.round(heat * 100) + "%" }} />
                </div>
                <span>🧊</span>
              </div>
              <span
                className={"heat-value " + (heat > 0.72 ? "heat-warm" : "")}
              >
                {heatLabel(heat)}
              </span>
            </div>
          </form>
        </section>

        <aside
          className={
            "right-rail " + (mobilePanel === "evidence" ? "mobile-active" : "")
          }
        >
          <div className="rail-heading evidence-heading">
            <span className="file-stamp">Evidence ledger</span>
            <h2>What the room holds</h2>
            <p>Three traces. No conclusions.</p>
          </div>
          <div className="evidence-list">
            <AnimatePresence initial={false}>
              {game.evidence.map((item) => {
                const justFound = Boolean(
                  item.id && game.newEvidenceIds.includes(item.id),
                );
                return (
                  <motion.article
                    key={item.slot}
                    className={
                      "evidence-card " +
                      (item.discovered
                        ? "evidence-found "
                        : "evidence-hidden ") +
                      (justFound ? "evidence-new" : "")
                    }
                    initial={justFound ? { opacity: 0, y: 8 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.24 }}
                  >
                    {item.discovered ? (
                      <>
                        <div className="evidence-topline">
                          <span className="evidence-icon" aria-hidden="true">
                            {item.emoji}
                          </span>
                          <span>Found</span>
                        </div>
                        <h3>{item.name}</h3>
                        <p>{item.description}</p>
                      </>
                    ) : (
                      <>
                        <div className="unknown-mark" aria-hidden="true">
                          ?
                        </div>
                        <p className="unknown-label">Unknown evidence</p>
                        <span className="evidence-slot">
                          Trace {String(item.slot).padStart(2, "0")}
                        </span>
                        <button
                          className="evidence-reveal-button"
                          onClick={() => void revealEvidence(item.slot)}
                          disabled={busy || revealingSlot !== null}
                          aria-label={`Reveal clue ${item.slot}`}
                        >
                          {revealingSlot === item.slot
                            ? "Revealing…"
                            : "Reveal"}
                        </button>
                      </>
                    )}
                  </motion.article>
                );
              })}
            </AnimatePresence>
          </div>
          <div className="evidence-tip">
            <span aria-hidden="true">✳</span>
            <p>Describe what you noticed. The evidence will meet you there.</p>
          </div>
        </aside>
      </div>

      <footer className="game-footer">
        <span>
          AI Detective <i>/</i> Active file
        </span>
        <span>
          {game.evidence.filter((item) => item.discovered).length} of 3 traces
          recorded
        </span>
      </footer>

      <AnimatePresence>
        {confirming && (
          <motion.div
            className="modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !busy)
                setConfirming(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setConfirming(null);
            }}
          >
            <motion.section
              className="accusation-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="accusation-title"
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
            >
              <span className="file-stamp">Final decision</span>
              <div className="dialog-person" aria-hidden="true">
                {confirming.emoji}
              </div>
              <h2 id="accusation-title">Accuse {confirming.name}?</h2>
              <p>
                This ends the investigation. Make sure the record supports your
                call.
              </p>
              <div className="dialog-actions">
                <button
                  id="keep-investigating"
                  className="button button-secondary"
                  onClick={() => setConfirming(null)}
                  disabled={busy}
                >
                  Keep investigating
                </button>
                <button
                  className="button button-accuse"
                  onClick={() => void confirmAccusation()}
                  disabled={busy}
                >
                  {busy ? "Closing the case…" : "Confirm accusation"}
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function Brand() {
  return (
    <div className="brand-lockup">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>AI Detective</span>
    </div>
  );
}
