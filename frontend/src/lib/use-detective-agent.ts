"use client";

import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import { HttpAgent } from "@ag-ui/client";
import { useCallback, useEffect, useRef } from "react";

export type DetectiveCommand =
  | { kind: "new_case" | "start" | "timeout" | "read" | "solution" | "close" }
  | { kind: "select" | "accuse"; suspectId: string }
  | { kind: "message"; text: string }
  | { kind: "reveal"; slot: number }
  | { kind: "heat"; text: string; version: number };

export function useDetectiveAgent(caseId: string | null) {
  const { copilotkit } = useCopilotKit();
  const { agent, isReady } = useAgent({ agentId: "detective" });
  // Advisory requests can finish while the interview agent is answering.
  const { agent: heatAgent } = useAgent({
    agentId: "detective-relevance",
    runtimeAgentId: "detective",
    threadId: caseId ?? "pending-relevance",
  });
  const { agent: debugAgent } = useAgent({
    agentId: "detective-debug",
    runtimeAgentId: "detective",
    threadId: caseId ?? "pending-debug",
  });
  const { agent: lifecycleAgent } = useAgent({
    agentId: "detective-lifecycle",
    runtimeAgentId: "detective",
    threadId: caseId ?? "pending-lifecycle",
  });
  const heatQueue = useRef<Promise<unknown>>(Promise.resolve());
  const heatGeneration = useRef(0);

  useEffect(() => {
    if (!(lifecycleAgent instanceof HttpAgent)) return;
    const agentFetch = lifecycleAgent.fetch;
    lifecycleAgent.fetch = (url, init) => agentFetch(url, { ...init, keepalive: true });
    return () => { lifecycleAgent.fetch = agentFetch; };
  }, [lifecycleAgent]);

  const runCommand = useCallback(async <T,>(command: DetectiveCommand): Promise<T> => {
    if (!isReady) throw new Error("CopilotKit is still connecting. Please retry.");
    const target = command.kind === "heat" ? heatAgent : command.kind === "solution" ? debugAgent : command.kind === "close" ? lifecycleAgent : agent;
    if (command.kind !== "heat" && command.kind !== "solution") heatGeneration.current += 1;
    const execute = async (): Promise<T> => {
      const runId = crypto.randomUUID();
      let result: T | undefined;
      let receivedResult = false;
      let runError: Error | null = null;
      const previousMessages = [...target.messages];
      const subscription = target.subscribe({
        onCustomEvent: ({ event, input }) => {
          if (input.runId === runId && event.name === "command_result") {
            result = event.value as T;
            receivedResult = true;
          }
        },
        onRunErrorEvent: ({ event, input }) => {
          if (input.runId === runId) runError = new Error(event.message);
        },
      });
      if (command.kind === "message") {
        target.addMessage({ id: crypto.randomUUID(), role: "user", content: command.text });
      }
      try {
        await copilotkit.runAgent({ agent: target, runId, forwardedProps: { command } });
        if (runError) throw runError;
        if (!receivedResult) throw new Error("The detective agent did not return a result. Please retry.");
        return result as T;
      } catch (error) {
        target.setMessages(previousMessages);
        throw error;
      } finally {
        subscription.unsubscribe();
      }
    };
    if (command.kind === "heat") {
      const generation = ++heatGeneration.current;
      const queued = heatQueue.current.catch(() => undefined).then(() => {
        if (generation !== heatGeneration.current) throw new Error("Relevance draft was superseded.");
        return execute();
      });
      heatQueue.current = queued;
      return queued;
    }
    return execute();
  }, [agent, copilotkit, debugAgent, heatAgent, isReady, lifecycleAgent]);

  useEffect(() => {
    if (!caseId || !isReady) return;
    const close = () => {
      // Best effort: the browser may stop this request while closing. The server
      // inactivity TTL still removes abandoned sessions if it cannot arrive.
      void runCommand({ kind: "close" }).catch(() => undefined);
    };
    window.addEventListener("pagehide", close);
    return () => window.removeEventListener("pagehide", close);
  }, [caseId, isReady, runCommand]);

  return { agent, isReady, runCommand };
}
