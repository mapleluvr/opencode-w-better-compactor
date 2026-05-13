import { Context, Cause, DateTime, Effect, Exit, Layer } from "effect"
import type { ModelMessage } from "ai"
import { Config } from "@/config/config"
import { Provider } from "@/provider/provider"
import { Agent } from "@/agent/agent"
import { SecretaryState } from "./secretary-state"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { Token } from "@/util/token"
import { EventV2 } from "@/v2/event"
import { SessionEvent } from "@/v2/session-event"
import * as Stream from "effect/Stream"
import * as Session from "./session"
import { MessageID, PartID, type SessionID } from "./schema"
import { type ProviderID, type ModelID } from "@/provider/schema"
import { usable } from "./overflow"

export const DEFAULT_DIFF_TOKEN_THRESHOLD = 100_000
export const DEFAULT_DIFF_TURN_THRESHOLD = 20
export const DEFAULT_COMPACT_WAIT_TIMEOUT = 60_000

const SECRETARY_SYSTEM_PROMPT = `You are a non-coding summary-maintenance agent. You are NOT the active coding assistant. Your only role is to create and maintain concise, factual summaries of conversation history.

You do NOT write code, make decisions, answer user questions, or perform any task beyond summary maintenance.

When a previous summary is provided, you MUST:
1. Understand and preserve all accurate information from it
2. Verify how the Previous Diff is represented in the previous summary
3. Integrate the New Diff into the existing summary
4. Output ONLY the updated summary text — no explanations, no preambles, no markdown headings`

function formatModelMessagesAsText(msgs: Array<{ role: string; content: unknown }>): string {
  return msgs
    .map((msg) => {
      const role = msg.role === "assistant" ? "Assistant" : "User"
      const content = Array.isArray(msg.content)
        ? msg.content
            .map((c) => {
              if (typeof c === "object" && c !== null && "text" in c) return (c as { text: string }).text
              if (typeof c === "string") return c
              return ""
            })
            .filter(Boolean)
            .join("\n\n")
        : String(msg.content ?? "")
      return `## ${role}\n${content}`
    })
    .join("\n\n")
}

function compactMessageText(msg: ModelMessage) {
  const content = Array.isArray(msg.content)
    ? msg.content
        .map((part) => {
          if (typeof part === "string") return part
          if (typeof part === "object" && part !== null && "text" in part && typeof part.text === "string") return part.text
          if (typeof part === "object" && part !== null && "type" in part && part.type === "file") return "[Attached file]"
          return ""
        })
        .filter(Boolean)
        .join("\n\n")
    : typeof msg.content === "string"
      ? msg.content
      : String(msg.content ?? "")
  return content.trim()
}

function formatCompactMessages(input: { title: string; messages: ModelMessage[]; trimmed?: boolean }) {
  if (input.trimmed) return `${input.title}\nPrevious Diff trimmed because the compact payload exceeded the target context.`
  const text = input.messages
    .map((msg) => {
      const role = msg.role === "assistant" ? "Assistant" : msg.role === "system" ? "System" : "User"
      return `## ${role}\n${compactMessageText(msg)}`
    })
    .filter((text) => text.trim() !== "")
    .join("\n\n")
  return text ? `${input.title}\n${text}` : `${input.title}\n(none)`
}

export interface Interface {
  readonly afterAssistantComplete: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
    assistant: MessageV2.Assistant
    user: MessageV2.User
  }) => Effect.Effect<void>
  readonly beforeModelSend: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
    user: MessageV2.User
    model: Provider.Model
  }) => Effect.Effect<{ type: "continue" } | { type: "switched"; sessionID: SessionID }>
  readonly manualCompact: (input: {
    sessionID: SessionID
    messages: MessageV2.WithParts[]
    user: MessageV2.User
    model: Provider.Model
  }) => Effect.Effect<{ type: "continue" } | { type: "switched"; sessionID: SessionID }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SecretaryCompaction") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const state = yield* SecretaryState.Service
    const provider = yield* Provider.Service
    const agent = yield* Agent.Service
    const llm = yield* LLM.Service
    const session = yield* Session.Service

    const runActionBlocking = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messages: MessageV2.WithParts[]
      user: MessageV2.User
      diffMessages: MessageV2.WithParts[]
      diffStart?: MessageID
      diffEnd: MessageID
      model: Provider.Model
      compactionAgent: Agent.Info
      frozenStart?: MessageID
      frozenEnd: MessageID
      state: SecretaryState.Info
      diffTokenCount?: number
      diffTurnCount?: number
    }) {
      EventV2.run(SessionEvent.Secretary.Started.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        status: "running",
        retry_count: 0,
        diff_token_count: input.diffTokenCount,
        diff_turn_count: input.diffTurnCount,
        running_snapshot_start: input.frozenStart,
        running_snapshot_end: input.frozenEnd,
        previous_diff_start: input.state.previousDiffStart,
        previous_diff_end: input.state.previousDiffEnd,
        summary_up_to: input.state.summaryUpTo,
      })

      const previousSummary = input.state.summary
      const previousMessages = input.state.previousDiffStart && input.state.previousDiffEnd
        ? MessageV2.secretaryRange({
            messages: input.messages,
            start: input.state.previousDiffStart,
            end: input.state.previousDiffEnd,
          })
        : []

      const diffModelMsgs = yield* MessageV2.toModelMessagesEffect(input.diffMessages, input.model, { stripMedia: true })
      const diffText = formatModelMessagesAsText(diffModelMsgs)

      const previousModelMsgs = previousMessages.length
        ? yield* MessageV2.toModelMessagesEffect(previousMessages, input.model, { stripMedia: true })
        : []
      const previousText = previousModelMsgs.length ? formatModelMessagesAsText(previousModelMsgs) : ""

      let systemParts: ModelMessage[] = [
        {
          role: "system" as const,
          content: SECRETARY_SYSTEM_PROMPT,
        },
      ]

      if (previousSummary) {
        systemParts = [
          ...systemParts,
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: `Previous Summary:\n${previousSummary}\n\nPlease confirm you understand the previous summary above and verify how the Previous Diff (below) is represented in it. Then integrate the New Diff to produce an updated summary.`,
              },
            ],
          } as ModelMessage,
        ]
      }

      let lastError: string | undefined
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          EventV2.run(SessionEvent.Secretary.Retrying.Sync, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
            status: "retrying",
            retry_count: attempt + 1,
            last_error: lastError,
            running_snapshot_start: input.frozenStart,
            running_snapshot_end: input.frozenEnd,
            previous_diff_start: input.state.previousDiffStart,
            previous_diff_end: input.state.previousDiffEnd,
            summary_up_to: input.state.summaryUpTo,
          })
        }

        const current = yield* state.get(input.sessionID)
        if (
          !current ||
          current.runningSnapshotStart !== input.frozenStart ||
          current.runningSnapshotEnd !== input.frozenEnd
        )
          return

        const messageParts: ModelMessage[] = [
          ...systemParts,
          ...(previousText
            ? [
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: `Previous Diff\n${previousText}` }],
                },
              ]
            : []),
          {
            role: "user" as const,
            content: [{ type: "text" as const, text: `New Diff\n${diffText}` }],
          },
          {
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: "Create a concise updated summary integrating the New Diff into the existing summary. Include key decisions, progress, blockers, and next steps. Keep the summary terse and factual. Output ONLY the new summary text — no explanations, no preambles.",
              },
            ],
          },
        ]

        const stream = llm.stream({
          user: input.user,
          sessionID: input.sessionID,
          model: input.model,
          agent: input.compactionAgent,
          system: [],
          messages: messageParts,
          tools: {},
        })

        let text = ""
        const result = yield* Stream.runForEach(stream, (event) =>
          Effect.sync(() => {
            if (event.type === "text-delta") {
              text += event.text
            }
          }),
        ).pipe(Effect.exit)

        if (Exit.isSuccess(result) && text.trim()) {
          const summary = text.trim()
          const newDiff = MessageV2.nextBoundary(input.messages, input.diffEnd)

          const casResult = yield* state.compareAndSwap({
            sessionID: input.sessionID,
            version: current.version,
            next: {
              ...current,
              status: "idle",
              summary,
              summaryUpTo: input.diffEnd,
              previousDiffStart: input.diffStart,
              previousDiffEnd: input.diffEnd,
              newDiffStart: newDiff,
              runningSnapshotStart: undefined,
              runningSnapshotEnd: undefined,
              retryCount: 0,
              lastError: undefined,
              lastSuccessAt: Date.now(),
            },
          })

          if (casResult === "stale") continue

          EventV2.run(SessionEvent.Secretary.Succeeded.Sync, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
            status: "idle",
            summary,
            retry_count: 0,
            last_success_at: Date.now(),
            summary_up_to: input.diffEnd,
            previous_diff_start: input.state.previousDiffStart,
            previous_diff_end: input.state.previousDiffEnd,
            diff_token_count: input.diffTokenCount,
            diff_turn_count: input.diffTurnCount,
          })
          return
        }

        lastError = Exit.isFailure(result)
          ? Cause.squash(result.cause) instanceof Error
            ? (Cause.squash(result.cause) as Error).message
            : String(Cause.squash(result.cause))
          : "empty summary"

        yield* state.update({
          sessionID: input.sessionID,
          update: (s) => ({
            ...s,
            retryCount: s.retryCount + 1,
            lastError,
          }),
        })
      }

      yield* state.update({
        sessionID: input.sessionID,
        update: (s) => ({
          ...s,
          status: "error",
          lastError,
          runningSnapshotStart: undefined,
          runningSnapshotEnd: undefined,
        }),
      })

      EventV2.run(SessionEvent.Secretary.Failed.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        status: "error",
        retry_count: 3,
        last_error: lastError,
        running_snapshot_start: input.frozenStart,
        running_snapshot_end: input.frozenEnd,
        previous_diff_start: input.state.previousDiffStart,
        previous_diff_end: input.state.previousDiffEnd,
        summary_up_to: input.state.summaryUpTo,
      })
    })

    const resolveModel = Effect.fnUntraced(function* (userModel: { providerID: ProviderID; modelID: ModelID }, cfg: Config.Info) {
      const compactionAgent = yield* agent.get("compaction")
      const configured = cfg.compaction?.secretary?.model
      const parsed = configured ? Provider.parseModel(configured) : undefined
      const model = parsed
        ? yield* provider.getModel(parsed.providerID, parsed.modelID)
        : compactionAgent.model
          ? yield* provider.getModel(compactionAgent.model.providerID, compactionAgent.model.modelID)
          : yield* provider.getModel(userModel.providerID, userModel.modelID)
      return { compactionAgent, model }
    })

    const afterAssistantComplete = Effect.fn("SecretaryCompaction.afterAssistantComplete")(function* (input) {
      const cfg = yield* config.get()
      const strategy = cfg.compaction?.strategy
      if (!strategy || strategy === "classic") return

      if (input.assistant.summary) return

      let currentState = yield* state.getOrInit({
        sessionID: input.sessionID,
        messages: input.messages,
      })

      if (currentState.classic) return

      const diffEnd = input.assistant.id
      const diffStart = currentState.newDiffStart ?? input.assistant.parentID
      if (!diffStart) return
      const diffMessages = MessageV2.secretaryRange({
        messages: input.messages,
        start: diffStart,
        end: diffEnd,
      })

      if (!diffMessages.length) return

      const { compactionAgent, model } = yield* resolveModel(input.user.model, cfg)

      const tokenThreshold = cfg.compaction?.secretary?.diff_token_threshold ?? DEFAULT_DIFF_TOKEN_THRESHOLD
      const turnThreshold = cfg.compaction?.secretary?.diff_turn_threshold ?? DEFAULT_DIFF_TURN_THRESHOLD

      const modelMessages = yield* MessageV2.toModelMessagesEffect(diffMessages, model, { stripMedia: true })
      const tokenEstimate = Token.estimate(JSON.stringify(modelMessages))
      const turns = MessageV2.secretaryTurnCount(diffMessages)

      if (tokenEstimate < tokenThreshold && turns < turnThreshold) return

      currentState = yield* state.update({
        sessionID: input.sessionID,
        update: (s) => ({
          ...s,
          runningSnapshotStart: diffStart,
          runningSnapshotEnd: diffEnd,
        }),
      })

      yield* runActionBlocking({
        sessionID: input.sessionID,
        messages: input.messages,
        user: input.user,
        diffMessages,
        diffStart,
        diffEnd,
        model,
        compactionAgent,
        frozenStart: diffStart,
        frozenEnd: diffEnd,
        state: currentState,
        diffTokenCount: tokenEstimate,
        diffTurnCount: turns,
      })
    })

    const beforeModelSend = Effect.fn("SecretaryCompaction.beforeModelSend")(function* (input) {
      const cfg = yield* config.get()
      const strategy = cfg.compaction?.strategy
      if (!strategy || strategy === "classic") return { type: "continue" as const }

      const current = yield* state.get(input.sessionID)
      if (current?.classic) return { type: "continue" as const }

      const contextThreshold = cfg.compaction?.secretary?.context_token_threshold
      const msgs = yield* MessageV2.toModelMessagesEffect(input.messages, input.model, { stripMedia: true })
      const estimate = Token.estimate(JSON.stringify(msgs))

      const overflow = contextThreshold !== undefined
        ? estimate >= contextThreshold
        : estimate >= usable({ cfg, model: input.model })

      if (!overflow) return { type: "continue" as const }

      const waitTimeout = cfg.compaction?.secretary?.compact_wait_timeout ?? DEFAULT_COMPACT_WAIT_TIMEOUT
      const waitStarted = Date.now()
      let waited = false
      while (true) {
        const cur = yield* state.get(input.sessionID)
        if (!cur || (cur.status !== "running" && cur.status !== "retrying")) break
        waited = true
        if (Date.now() - waitStarted >= waitTimeout) {
          const lastError = `Secretary compact wait timed out after ${waitTimeout}ms`
          yield* state.update({
            sessionID: input.sessionID,
            update: (s) => ({
              ...s,
              status: "error",
              lastError,
              runningSnapshotStart: undefined,
              runningSnapshotEnd: undefined,
            }),
          })
          EventV2.run(SessionEvent.Secretary.Failed.Sync, {
            sessionID: input.sessionID,
            timestamp: DateTime.makeUnsafe(Date.now()),
            status: "error",
            retry_count: cur.retryCount,
            last_error: lastError,
            payload_degraded: cur.payloadDegraded,
            summary_up_to: cur.summaryUpTo,
            previous_diff_start: cur.previousDiffStart,
            previous_diff_end: cur.previousDiffEnd,
            compact_waiting: false,
          })
          return { type: "continue" as const }
        }
        const remaining = waitTimeout - (Date.now() - waitStarted)
        yield* Effect.sleep(`${Math.min(1000, Math.max(1, remaining))} millis`)
      }

      if (waited) {
        EventV2.run(SessionEvent.Secretary.Compact.Waiting.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          status: "compacting",
          compact_waiting: true,
        })
      }

      let currentState = yield* state.getOrInit({
        sessionID: input.sessionID,
        messages: input.messages,
      })

      if (!currentState.summary) {
        const latestAssistant = input.messages.findLast(
          (msg: MessageV2.WithParts) => msg.info.role === "assistant" && !msg.info.summary,
        )
        if (latestAssistant) {
          const parentUser = input.messages.find(
            (msg: MessageV2.WithParts) => msg.info.id === latestAssistant.info.parentID,
          )
          if (parentUser?.info.role === "user") {
            const diffMsgs = MessageV2.secretaryRange({
              messages: input.messages,
              start: currentState.newDiffStart ?? latestAssistant.info.parentID,
              end: latestAssistant.info.id,
            })
            const { compactionAgent, model } = yield* resolveModel(input.user.model, cfg)
            const forcedDiffModelMsgs = yield* MessageV2.toModelMessagesEffect(diffMsgs, model, { stripMedia: true })
            const forcedDiffTokenCount = Token.estimate(JSON.stringify(forcedDiffModelMsgs))
            const forcedDiffTurnCount = MessageV2.secretaryTurnCount(diffMsgs)
            const nextState = yield* state.update({
              sessionID: input.sessionID,
              update: (s) => ({
                ...s,
                runningSnapshotStart: currentState.newDiffStart ?? latestAssistant.info.parentID,
                runningSnapshotEnd: latestAssistant.info.id,
              }),
            })
            yield* runActionBlocking({
              sessionID: input.sessionID,
              messages: input.messages,
              user: input.user,
              diffMessages: diffMsgs,
              diffStart: currentState.newDiffStart ?? latestAssistant.info.parentID,
              diffEnd: latestAssistant.info.id,
              model,
              compactionAgent,
              frozenStart: currentState.newDiffStart ?? latestAssistant.info.parentID,
              frozenEnd: latestAssistant.info.id,
              state: nextState,
              diffTokenCount: forcedDiffTokenCount,
              diffTurnCount: forcedDiffTurnCount,
            })
          }
        }
        const refreshed = yield* state.get(input.sessionID)
        if (!refreshed) return { type: "continue" as const }
        if (!refreshed.summary) return { type: "continue" as const }
        currentState = refreshed
      }

      const summaryText = currentState.summary!

      const previousMessages = MessageV2.secretaryRange({
        messages: input.messages,
        start: currentState.previousDiffStart,
        end: currentState.previousDiffEnd,
      })

      const newMessages = MessageV2.secretaryRange({
        messages: input.messages,
        start: currentState.newDiffStart ?? input.user.id,
        end: input.messages.at(-1)?.info.id,
      })

      const previousModelMsgs = previousMessages.length
        ? yield* MessageV2.toModelMessagesEffect(previousMessages, input.model, { stripMedia: true })
        : []

      const newModelMsgs = newMessages.length
        ? yield* MessageV2.toModelMessagesEffect(newMessages, input.model, { stripMedia: true })
        : []

      const continuation = (previousTrimmed: boolean) => [
        `Latest Summary\n${summaryText}`,
        "I understand the latest summary and will continue from the compacted context.",
        formatCompactMessages({ title: "Previous Diff", messages: previousModelMsgs, trimmed: previousTrimmed }),
        formatCompactMessages({ title: "New Diff", messages: newModelMsgs }),
      ]

      let continuationMessages = continuation(false)

      const targetContext = contextThreshold ?? usable({ cfg, model: input.model })
      const payloadEstimate = Token.estimate(continuationMessages.join("\n\n"))
      let payloadDegraded = currentState.payloadDegraded

      if (payloadEstimate > targetContext) {
        continuationMessages = continuation(true)
        payloadDegraded = true

        EventV2.run(SessionEvent.Secretary.Compact.Degraded.Sync, {
          sessionID: input.sessionID,
          timestamp: DateTime.makeUnsafe(Date.now()),
          status: "compacting",
          summary: currentState.summary,
          payload_degraded: true,
          summary_up_to: currentState.summaryUpTo,
          previous_diff_start: currentState.previousDiffStart,
          previous_diff_end: currentState.previousDiffEnd,
          running_snapshot_start: currentState.runningSnapshotStart,
          running_snapshot_end: currentState.runningSnapshotEnd,
        })
      }

      EventV2.run(SessionEvent.Secretary.Compact.Started.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        status: "compacting",
        summary: currentState.summary,
        payload_degraded: payloadDegraded,
        summary_up_to: currentState.summaryUpTo,
        previous_diff_start: currentState.previousDiffStart,
        previous_diff_end: currentState.previousDiffEnd,
        running_snapshot_start: currentState.runningSnapshotStart,
        running_snapshot_end: currentState.runningSnapshotEnd,
      })

      if (payloadDegraded !== currentState.payloadDegraded) {
        yield* state.update({
          sessionID: input.sessionID,
          update: (s) => ({ ...s, payloadDegraded }),
        })
      }

      const parentSession = yield* session.get(input.sessionID).pipe(Effect.option)
      const newSession = yield* session.create({
        parentID: parentSession._tag === "Some" ? parentSession.value.parentID : undefined,
        agent: input.user.agent,
        model: {
          id: input.user.model.modelID,
          providerID: input.user.model.providerID,
          ...(input.user.model.variant !== undefined && { variant: input.user.model.variant }),
        },
      })

      const userMsg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: newSession.id,
        agent: input.user.agent,
        model: input.user.model,
        time: { created: Date.now() },
      })

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: userMsg.id,
        sessionID: newSession.id,
        type: "text",
        text: continuationMessages[0]!,
        synthetic: true,
        metadata: { compaction_continue: true },
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })

      const ackMsg = yield* session.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        parentID: userMsg.id,
        sessionID: newSession.id,
        mode: input.user.agent,
        agent: input.user.agent,
        variant: input.user.model.variant,
        path: { cwd: newSession.directory, root: newSession.directory },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: input.model.id,
        providerID: input.model.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })

      yield* session.updatePart({
        id: PartID.ascending(),
        messageID: ackMsg.id,
        sessionID: newSession.id,
        type: "text",
        text: continuationMessages[1]!,
        synthetic: true,
        metadata: { compaction_continue: true },
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      })

      yield* Effect.forEach(
        continuationMessages.slice(2),
        (text) =>
          Effect.gen(function* () {
            const msg = yield* session.updateMessage({
              id: MessageID.ascending(),
              role: "user" as const,
              sessionID: newSession.id,
              agent: input.user.agent,
              model: input.user.model,
              time: { created: Date.now() },
            })
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: newSession.id,
              type: "text" as const,
              text,
              synthetic: true,
              metadata: { compaction_continue: true },
              time: {
                start: Date.now(),
                end: Date.now(),
              },
            })
          }),
        { discard: true },
      )

      EventV2.run(SessionEvent.Secretary.Compact.Switched.Sync, {
        sessionID: input.sessionID,
        timestamp: DateTime.makeUnsafe(Date.now()),
        status: "compacting",
        summary: currentState.summary,
        payload_degraded: payloadDegraded,
        new_session_id: newSession.id,
        auto_switch: !newSession.parentID,
        summary_up_to: currentState.summaryUpTo,
        previous_diff_start: currentState.previousDiffStart,
        previous_diff_end: currentState.previousDiffEnd,
        running_snapshot_start: currentState.runningSnapshotStart,
        running_snapshot_end: currentState.runningSnapshotEnd,
      })

      return { type: "switched" as const, sessionID: newSession.id }
    })

    const manualCompact = Effect.fn("SecretaryCompaction.manualCompact")(function* (input) {
      const cfg = yield* config.get()
      const strategy = cfg.compaction?.strategy
      if (!strategy || strategy === "classic") return { type: "continue" as const }

      return yield* beforeModelSend(input)
    })

    return Service.of({ afterAssistantComplete, beforeModelSend, manualCompact })
  }),
)

export const defaultLayer = Layer.suspend(() =>
  layer.pipe(
    Layer.provide(SecretaryState.layer),
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Session.defaultLayer),
    Layer.provide(Agent.defaultLayer),
    Layer.provide(LLM.defaultLayer),
    Layer.provide(Config.defaultLayer),
  ),
)

export * as SecretaryCompaction from "./secretary-compaction"
