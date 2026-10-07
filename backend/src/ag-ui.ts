import { EventType, type BaseEvent, type Message, type RunAgentInput } from "@ag-ui/core";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { EventEncoder } from "@ag-ui/encoder";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ChatMessage, GameView } from "./types.js";

const suspectId = z.enum(["suspect_1", "suspect_2", "suspect_3"]);
export const AgentCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("new_case") }),
  z.object({ kind: z.literal("start") }),
  z.object({ kind: z.literal("select"), suspectId }),
  z.object({ kind: z.literal("message"), text: z.string().trim().min(1).max(4000) }),
  z.object({ kind: z.literal("reveal"), slot: z.number().int().min(1).max(3) }),
  z.object({ kind: z.literal("accuse"), suspectId }),
  z.object({ kind: z.literal("timeout") }),
  z.object({ kind: z.literal("read") }),
  z.object({ kind: z.literal("close") }),
  z.object({ kind: z.literal("solution") }),
  z.object({ kind: z.literal("heat"), text: z.string().max(4000), version: z.number().int().min(0) }),
]);
export type AgentCommand = z.infer<typeof AgentCommandSchema>;
export type SendEvent = (event: BaseEvent) => void;

export function parseAgentRequest(body: unknown): { input: RunAgentInput; command: AgentCommand } {
  const input = RunAgentInputSchema.parse(body);
  const props = input.forwardedProps as Record<string, unknown> | undefined;
  // A standard CopilotChat message works too; buttons use explicit commands.
  const latest = [...input.messages].reverse().find((message) => message.role === "user");
  const command = AgentCommandSchema.parse(props?.command ?? {
    kind: "message",
    text: latest?.content,
  });
  return { input, command };
}

function publicMessages(game: GameView): Message[] {
  return game.messages.map((message) => ({
    id: message.id,
    role: message.speaker === "detective" ? "user" as const : "assistant" as const,
    content: message.text,
    name: message.speaker === "suspect"
      ? game.suspects.find((suspect) => suspect.id === message.suspectId)?.name
      : message.speaker,
  }));
}

export function emitGame(send: SendEvent, game: GameView, previousMessages: readonly ChatMessage[]) {
  const previousIds = new Set(previousMessages.map(({ id }) => id));
  for (const message of game.messages) {
    if (previousIds.has(message.id) || message.speaker === "detective") continue;
    send({ type: EventType.TEXT_MESSAGE_START, messageId: message.id, role: "assistant" });
    send({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: message.id, delta: message.text });
    send({ type: EventType.TEXT_MESSAGE_END, messageId: message.id });
  }
  // Only the explicit public projection crosses the AG-UI boundary. Graph state
  // contains the canonical case and must never be emitted as a state snapshot.
  send({ type: EventType.STATE_SNAPSHOT, snapshot: { briefing: null, game } });
  send({ type: EventType.MESSAGES_SNAPSHOT, messages: publicMessages(game) });
}

export async function streamAgentRun(
  request: FastifyRequest,
  reply: FastifyReply,
  input: RunAgentInput,
  command: AgentCommand,
  execute: (send: SendEvent) => Promise<unknown>,
) {
  const encoder = new EventEncoder();
  reply.hijack();
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) reply.raw.setHeader(name, value);
  }
  reply.raw.setHeader("content-type", encoder.getContentType());
  reply.raw.setHeader("cache-control", "no-cache, no-transform");
  reply.raw.setHeader("x-accel-buffering", "no");
  reply.raw.writeHead(200);
  const send: SendEvent = (event) => {
    if (!reply.raw.destroyed) reply.raw.write(encoder.encode(event));
  };
  const startedAt = Date.now();
  const heartbeat = setInterval(() => {
    if (!reply.raw.destroyed) reply.raw.write(": keep-alive\n\n");
  }, 15_000);
  request.log.info({ command: command.kind, runId: input.runId }, "AG-UI run started");
  send({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId });
  send({ type: EventType.STEP_STARTED, stepName: command.kind });
  try {
    const result = await execute(send);
    send({ type: EventType.CUSTOM, name: "command_result", value: result });
    send({ type: EventType.STEP_FINISHED, stepName: command.kind });
    send({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId });
    request.log.info({ command: command.kind, elapsedMs: Date.now() - startedAt }, "AG-UI run completed");
  } catch (error) {
    request.log.error({ err: error, command: command.kind }, "AG-UI run failed");
    const statusCode = error instanceof Error && "statusCode" in error ? error.statusCode : 500;
    send({
      type: EventType.RUN_ERROR,
      message: typeof statusCode === "number" && statusCode < 500 && error instanceof Error
        ? error.message
        : "Game service unavailable. Retry.",
      code: String(statusCode),
    });
  } finally {
    clearInterval(heartbeat);
    reply.raw.end();
  }
}
