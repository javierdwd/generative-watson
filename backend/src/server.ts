import { EventType } from "@ag-ui/core";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI, { OpenAIError } from "openai";
import { TypeSafeError } from "@typesafe-ai/sdk";
import { z } from "zod";
import { CaseGenerator } from "./case-generation.js";
import { log } from "./logging.js";
import { emitGame, parseAgentRequest, streamAgentRun } from "./ag-ui.js";
import { evaluateHeat, toGameView, transitionGame } from "./game-graph.js";
import type { GameAction, GameSession, GameState, GameView, GeneratedCase } from "./types.js";

export function createServer(options: {
  caseGenerator?: Pick<CaseGenerator, "generate" | "model">;
  heatEvaluator?: typeof evaluateHeat;
  transition?: typeof transitionGame;
} = {}) {
  const app = Fastify({ loggerInstance: log });
  const sessions = new Map<string, GameSession>();
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const SESSION_COOKIE = "detective_session";
  const caseGenerator = options.caseGenerator ?? new CaseGenerator();

  class ApiError extends Error {
    constructor(message: string, readonly statusCode: number) {
      super(message);
      this.name = "ApiError";
    }
  }

  function cookieValue(request: FastifyRequest, name: string): string | null {
    const header = request.headers.cookie;
    if (!header) return null;
    for (const entry of header.split(";")) {
      const [key, ...value] = entry.trim().split("=");
      if (key === name) {
        try {
          return decodeURIComponent(value.join("="));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function requestBody<TSchema extends z.ZodType>(schema: TSchema, body: unknown): z.infer<TSchema> {
    try {
      return schema.parse(body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new ApiError(error.issues.map((issue) => issue.message).join("; "), 400);
      }
      throw error;
    }
  }

  function getSession(request: FastifyRequest): GameSession {
    const sessionId = cookieValue(request, SESSION_COOKIE);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) throw new ApiError("No active game session", 401);
    if (Date.now() - session.lastActivity > SESSION_TTL_MS) {
      sessions.delete(session.sessionId);
      throw new ApiError("Game session expired", 401);
    }
    session.lastActivity = Date.now();
    return session;
  }

  async function withSessionLock<T>(session: GameSession, work: () => Promise<T>): Promise<T> {
    const previous = session.lock;
    let release!: () => void;
    session.lock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (!sessions.has(session.sessionId)) throw new ApiError("No active game session", 401);
      session.lastActivity = Date.now();
      return await work();
    } finally {
      release();
    }
  }

  async function runAction(session: GameSession, action: GameAction): Promise<GameState> {
    const next = await (options.transition ?? transitionGame)(session.case, session.game, action);
    session.game = next;
    session.lastActivity = Date.now();
    return next;
  }

  async function executeAction(session: GameSession, action: GameAction): Promise<GameView> {
    return withSessionLock(session, async () => {
      const game = await runAction(session, action);
      const view = publicGame(session, game);
      if (["success", "failure", "timeout"].includes(game.status)) {
        sessions.delete(session.sessionId);
      }
      return view;
    });
  }

  function briefing(session: GameSession) {
    return {
      caseId: session.case.caseId,
      crimeType: session.case.crimeType,
      shortSynopsis: session.case.shortSynopsis,
      incidentBriefing: session.case.incidentBriefing,
      status: "briefing" as const,
    };
  }

  function publicGame(session: GameSession, game: GameState): GameView {
    return toGameView(session.case, game);
  }

  function setSessionCookie(reply: FastifyReply, request: FastifyRequest, value: string) {
    const secure = request.protocol === "https" ? "; Secure" : "";
    reply.header(
      "set-cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800${secure}`,
    );
  }

  app.setErrorHandler((error, _request, reply) => {
    const errorStatus = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
    let statusCode = errorStatus ?? 500;
    if (error instanceof ApiError) statusCode = error.statusCode;
    else if (error instanceof TypeSafeError || error instanceof OpenAIError || error instanceof z.ZodError) {
      statusCode = 502;
    }
    app.log.error({ err: error }, "API request failed");
    const message = error instanceof Error ? error.message : String(error);
    reply.status(statusCode).send({ detail: statusCode >= 500 ? "Game service unavailable. Retry." : message });
  });

  app.get("/health", async () => ({ status: "ok" }));

  async function createSession(request: FastifyRequest, reply: FastifyReply, issuedId?: string) {
    const previousId = cookieValue(request, SESSION_COOKIE);
    const previous = previousId ? sessions.get(previousId) : undefined;
    if (previous) {
      await withSessionLock(previous, async () => {
        sessions.delete(previous.sessionId);
      });
    }
    app.log.info("Case generation started");
    let generated: GeneratedCase;
    try {
      generated = await caseGenerator.generate();
    } catch (error) {
      app.log.error({ err: error }, "Case generation failed");
      throw new ApiError("Case generation failed. Try again.", 503);
    }
    const sessionId = issuedId ?? randomBytes(32).toString("base64url");
    const initialGame = await (options.transition ?? transitionGame)(generated, null, { kind: "initialize" });
    const session: GameSession = {
      sessionId,
      case: generated,
      game: initialGame,
      lastActivity: Date.now(),
      lock: Promise.resolve(),
    };
    sessions.set(sessionId, session);
    if (!issuedId) setSessionCookie(reply, request, sessionId);
    app.log.info({ caseId: generated.caseId, model: caseGenerator.model }, "Case ready");
    return briefing(session);
  }

  app.post("/sessions", async (request, reply) => createSession(request, reply));

  app.get("/sessions/current", async (request) => briefing(getSession(request)));

  app.delete("/sessions/current", async (request, reply) => {
    const sessionId = cookieValue(request, SESSION_COOKIE);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) {
      await withSessionLock(session, async () => {
        sessions.delete(session.sessionId);
      });
    }
    reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.code(204).send();
  });

  app.post("/game/start", async (request) => {
    const session = getSession(request);
    return executeAction(session, { kind: "start" });
  });

  app.get("/game", async (request) => {
    const session = getSession(request);
    return withSessionLock(session, async () => {
      const game = session.game;
      if (game.status !== "investigating") {
        throw new ApiError("Investigation has not started", 409);
      }
      if (!game.deadlineAt || Date.now() >= Date.parse(game.deadlineAt)) {
        const timedOut = await runAction(session, { kind: "timeout" });
        const view = publicGame(session, timedOut);
        sessions.delete(session.sessionId);
        return view;
      }
      return publicGame(session, game);
    });
  });

  async function revealSolution(request: FastifyRequest) {
    const session = getSession(request);
    return withSessionLock(session, async () => {
      if (session.game.status !== "investigating") {
        throw new ApiError("Investigation has not started", 409);
      }
      if (!session.game.deadlineAt || Date.now() >= Date.parse(session.game.deadlineAt)) {
        throw new ApiError("Investigation has ended", 409);
      }
      const culprit = session.case.suspects.find(
        (suspect) => suspect.id === session.case.solution.perpetratorId,
      );
      if (!culprit) throw new ApiError("Solution is unavailable", 500);
      return {
        caseId: session.case.caseId,
        perpetratorName: culprit.name,
        method: session.case.solution.method,
        explanation: session.case.solution.playerFacingExplanation,
      };
    });
  }

  app.get("/game/solution", async (request) => revealSolution(request));

  app.post("/game/message", async (request) => {
    const body = requestBody(z.object({ text: z.string().trim().min(1).max(4000) }), request.body);
    const session = getSession(request);
    return executeAction(session, { kind: "message", text: body.text });
  });

  app.post("/game/suspect", async (request) => {
    const body = requestBody(z.object({ suspectId: z.enum(["suspect_1", "suspect_2", "suspect_3"]) }), request.body);
    const session = getSession(request);
    return executeAction(session, { kind: "select", suspectId: body.suspectId });
  });

  app.post("/game/evidence/reveal", async (request) => {
    const body = requestBody(z.object({ slot: z.number().int().min(1).max(3) }), request.body);
    const session = getSession(request);
    return executeAction(session, { kind: "reveal", slot: body.slot });
  });

  app.post("/game/accuse", async (request) => {
    const body = requestBody(z.object({ suspectId: z.enum(["suspect_1", "suspect_2", "suspect_3"]) }), request.body);
    const session = getSession(request);
    return executeAction(session, { kind: "accuse", suspectId: body.suspectId });
  });

  app.post("/game/timeout", async (request) => {
    const session = getSession(request);
    return executeAction(session, { kind: "timeout" });
  });

  async function gameHeat(request: FastifyRequest, body: { text: string; version: number }) {
    const session = getSession(request);
    const caseData = await withSessionLock(session, async () => {
      if (session.game.status !== "investigating") {
        throw new ApiError("Investigation has not started", 409);
      }
      if (!session.game.deadlineAt || Date.now() >= Date.parse(session.game.deadlineAt)) {
        throw new ApiError("Investigation has ended", 409);
      }
      return session.case;
    });
    const value = await (options.heatEvaluator ?? evaluateHeat)(caseData, body.text);
    return { value, version: body.version };
  }

  app.post("/game/heat", async (request) => {
    const body = requestBody(z.object({ text: z.string().max(4000), version: z.number().int().min(0) }), request.body);
    return gameHeat(request, body);
  });

  app.post("/agui", async (request, reply) => {
    let parsed: ReturnType<typeof parseAgentRequest>;
    try {
      parsed = parseAgentRequest(request.body);
    } catch (error) {
      throw new ApiError(error instanceof Error ? error.message : "Invalid agent request", 400);
    }
    const { input, command } = parsed;
    // Bind all runs to the cookie-owned case. Client state, history, tools, and
    // context never replace canonical game state or grant access to another case.
    const session = command.kind === "new_case" ? null : getSession(request);
    if (session && input.threadId !== session.case.caseId) {
      throw new ApiError("This agent thread does not belong to the active case", 403);
    }
    const issuedId = command.kind === "new_case" ? randomBytes(32).toString("base64url") : undefined;
    if (issuedId) setSessionCookie(reply, request, issuedId);

    await streamAgentRun(request, reply, input, command, async (send) => {
      if (command.kind === "new_case") {
        const report = await createSession(request, reply, issuedId);
        send({ type: EventType.STATE_SNAPSHOT, snapshot: { briefing: report, game: null } });
        send({ type: EventType.MESSAGES_SNAPSHOT, messages: [] });
        return report;
      }
      if (command.kind === "heat") return gameHeat(request, command);
      // Debug data is returned only by this explicit command, never in normal
      // shared state or chat messages.
      if (command.kind === "solution") return revealSolution(request);
      if (!session) throw new ApiError("No active game session", 401);
      if (command.kind === "close") {
        return withSessionLock(session, async () => {
          sessions.delete(session.sessionId);
          send({ type: EventType.STATE_SNAPSHOT, snapshot: { briefing: null, game: null } });
          send({ type: EventType.MESSAGES_SNAPSHOT, messages: [] });
          return { closed: true };
        });
      }
      return withSessionLock(session, async () => {
        const previousMessages = session.game.messages;
        let game = session.game;
        if (command.kind === "read") {
          if (game.status === "briefing") {
            const report = briefing(session);
            send({ type: EventType.STATE_SNAPSHOT, snapshot: { briefing: report, game: null } });
            send({ type: EventType.MESSAGES_SNAPSHOT, messages: [] });
            return report;
          }
          if (!game.deadlineAt || Date.now() >= Date.parse(game.deadlineAt)) {
            game = await runAction(session, { kind: "timeout" });
          }
        } else {
          const userMessage = [...input.messages].reverse().find((message) => message.role === "user");
          const action = command.kind === "message" && typeof userMessage?.content === "string" && userMessage.content.trim() === command.text
            ? { ...command, messageId: userMessage.id }
            : command;
          game = await runAction(session, action);
        }
        const view = publicGame(session, game);
        emitGame(send, view, previousMessages);
        if (["success", "failure", "timeout"].includes(game.status)) {
          sessions.delete(session.sessionId);
        }
        return view;
      });
    });
  });

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of sessions) {
      if (session.lastActivity < cutoff) sessions.delete(id);
    }
  }, 60_000);
  cleanupTimer.unref();
  app.addHook("onClose", async () => { clearInterval(cleanupTimer); });
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createServer();
  const port = Number(process.env.PORT || 8123);
  await app.listen({ port, host: process.env.HOST || "0.0.0.0" });
  app.log.info(`AI Detective TypeScript API listening on port ${port}`);
}
