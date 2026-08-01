import * as acp from "@agentclientprotocol/sdk";
import type { AgentEventOf } from "agent-protocol";
import { nonempty, object, toolKind } from "./sigma-acp-event-content.js";
import type { ResolvedSession } from "./sigma-acp-shared.js";

interface SigmaStructuredQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

interface SigmaAskUserQuestionResponse {
  outcome?: unknown;
  answers?: unknown;
  annotations?: unknown;
}

function structuredQuestions(value: unknown): SigmaStructuredQuestion[] {
  const input = object(value);
  const declared = Array.isArray(input?.questions) ? input.questions : [];
  const questions = declared.flatMap((entry, index) => {
    const question = object(entry);
    const text = nonempty(question?.question);
    if (!text) return [];
    const options = Array.isArray(question?.options)
      ? question.options.flatMap((candidate) => {
          const option = object(candidate);
          const label = nonempty(option?.label);
          if (!label) return [];
          return [{ label, description: nonempty(option?.description) ?? label }];
        })
      : [];
    return [{
      id: nonempty(question?.id) ?? `question_${index + 1}`,
      header: nonempty(question?.header) ?? "Question",
      question: text,
      options,
      multiSelect: question?.multiSelect === true
    }];
  });
  if (questions.length > 0) return questions.slice(0, 3);
  const message = nonempty(input?.message);
  return message
    ? [{ id: "message", header: "Question", question: message, options: [], multiSelect: false }]
    : [];
}

function structuredAnswerText(
  response: SigmaAskUserQuestionResponse,
  questions: readonly SigmaStructuredQuestion[]
): string | undefined {
  if (response.outcome !== "accepted") return undefined;
  const answers = object(response.answers) ?? {};
  const annotations = object(response.annotations) ?? {};
  const answered = questions.map((question) => {
    const annotation = object(annotations[question.question]);
    const notes = nonempty(annotation?.notes);
    const rawAnswer = answers[question.question];
    const values = Array.isArray(rawAnswer)
      ? rawAnswer.flatMap((value: unknown) => {
          const text = nonempty(value);
          return text && text !== "Other" ? [text] : [];
        })
      : [];
    const answer = notes ?? (values.length > 0 ? values.join(", ") : "No answer provided");
    return { question: question.question, answer };
  });
  return answered.length === 1
    ? answered[0]!.answer
    : `User answers:\n${answered.map(({ question, answer }) =>
        `- ${question}: ${answer}`).join("\n")}`;
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Operation aborted."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function approvalDecision(
  response: acp.RequestPermissionResponse
): "allow" | "always_allow" | "deny" {
  if (response.outcome.outcome !== "selected") return "deny";
  if (response.outcome.optionId === "always_allow") return "always_allow";
  return response.outcome.optionId === "allow" ? "allow" : "deny";
}

export class SigmaAcpInteractionForwarder {
  async requestStructuredUserInput(
    resolved: ResolvedSession,
    event: AgentEventOf<"tool.requested">,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<boolean> {
    const questions = structuredQuestions(event.payload.arguments);
    if (questions.length === 0) return false;
    try {
      const response = await client.request<
        SigmaAskUserQuestionResponse,
        {
          sessionId: string;
          toolCallId: string;
          questions: SigmaStructuredQuestion[];
          mode: "default" | "plan";
        }
      >("_x.ai/ask_user_question", {
        sessionId: resolved.record.sessionId,
        toolCallId: event.payload.callId,
        questions,
        mode: resolved.record.mode === "analyze" ? "plan" : "default"
      }, { cancellationSignal: signal });
      const text = structuredAnswerText(response, questions);
      if (!text) return false;
      await resolved.handle.runtime.command({
        type: "follow_up",
        sessionId: resolved.record.runtimeSessionId,
        text
      });
      return true;
    } catch (error) {
      if (signal.aborted) throw error;
      // Clients without the optional extension retain the ordinary
      // needs_input outcome instead of failing the whole prompt.
      return false;
    }
  }

  async requestToolApproval(
    resolved: ResolvedSession,
    event: AgentEventOf<"tool.approval_requested">,
    client: acp.AgentContext,
    signal: AbortSignal
  ): Promise<void> {
    const effects = event.payload.effects;
    const request = client.request(acp.methods.client.session.requestPermission, {
      sessionId: resolved.record.sessionId,
      toolCall: {
        toolCallId: event.payload.callId,
        title: event.payload.toolName,
        name: event.payload.toolName,
        kind: toolKind(event.payload.toolName, effects),
        status: "pending",
        rawInput: event.payload.arguments
      },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "always_allow", name: "Always allow this tool", kind: "allow_always" },
        { optionId: "deny", name: "Deny", kind: "reject_once" }
      ]
    }, { cancellationSignal: signal });
    const permission = await abortable(request, signal);
    await resolved.handle.runtime.command({
      type: "approve",
      sessionId: resolved.record.runtimeSessionId,
      requestId: event.payload.requestId,
      decision: approvalDecision(permission)
    });
  }
}
