import { and, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "@/storage/db"
import { MessageV2 } from "./message-v2"
import { SecretaryStateTable } from "./session.sql"
import type { MessageID, SessionID } from "./schema"

export type Status = "idle" | "running" | "retrying" | "error" | "compacting"

export interface Info {
  readonly sessionID: SessionID
  readonly version: number
  readonly status: Status
  readonly summary?: string
  readonly summaryUpTo?: MessageID
  readonly previousDiffStart?: MessageID
  readonly previousDiffEnd?: MessageID
  readonly newDiffStart?: MessageID
  readonly runningSnapshotStart?: MessageID
  readonly runningSnapshotEnd?: MessageID
  readonly retryCount: number
  readonly lastError?: string
  readonly lastSuccessAt?: number
  readonly payloadDegraded: boolean
  readonly classic: boolean
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly getOrInit: (input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) => Effect.Effect<Info>
  readonly compareAndSwap: (input: {
    sessionID: SessionID
    version: number
    next: Info
  }) => Effect.Effect<Info | "stale">
  readonly update: (input: { sessionID: SessionID; update: (state: Info) => Info }) => Effect.Effect<Info>
  readonly markClassic: (sessionID: SessionID) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SecretaryState") {}

function fromRow(row: typeof SecretaryStateTable.$inferSelect): Info {
  return {
    sessionID: row.session_id,
    version: row.version,
    status: row.status,
    summary: row.summary ?? undefined,
    summaryUpTo: row.summary_up_to ?? undefined,
    previousDiffStart: row.previous_diff_start ?? undefined,
    previousDiffEnd: row.previous_diff_end ?? undefined,
    newDiffStart: row.new_diff_start ?? undefined,
    runningSnapshotStart: row.running_snapshot_start ?? undefined,
    runningSnapshotEnd: row.running_snapshot_end ?? undefined,
    retryCount: row.retry_count,
    lastError: row.last_error ?? undefined,
    lastSuccessAt: row.last_success_at ?? undefined,
    payloadDegraded: row.payload_degraded,
    classic: row.classic,
  }
}

function toRow(sessionID: SessionID, version: number, next: Info) {
  return {
    session_id: sessionID,
    version,
    status: next.status,
    summary: next.summary ?? null,
    summary_up_to: next.summaryUpTo ?? null,
    previous_diff_start: next.previousDiffStart ?? null,
    previous_diff_end: next.previousDiffEnd ?? null,
    new_diff_start: next.newDiffStart ?? null,
    running_snapshot_start: next.runningSnapshotStart ?? null,
    running_snapshot_end: next.runningSnapshotEnd ?? null,
    retry_count: next.retryCount,
    last_error: next.lastError ?? null,
    last_success_at: next.lastSuccessAt ?? null,
    payload_degraded: next.payloadDegraded,
    classic: next.classic,
    time_updated: Date.now(),
  }
}

const get: Interface["get"] = Effect.fn("SecretaryState.get")(function* (sessionID) {
  const row = yield* Effect.sync(() =>
    Database.use((db) => db.select().from(SecretaryStateTable).where(eq(SecretaryStateTable.session_id, sessionID)).get()),
  )
  if (!row) return undefined
  return fromRow(row)
})

const getOrInit: Interface["getOrInit"] = Effect.fn("SecretaryState.getOrInit")(function* (input) {
  const existing = yield* get(input.sessionID)
  if (existing) return existing
  const initial: Info = {
    sessionID: input.sessionID,
    version: 1,
    status: "idle",
    newDiffStart: MessageV2.nextBoundary(input.messages, input.messages.at(-1)?.info.id),
    retryCount: 0,
    payloadDegraded: false,
    classic: false,
  }
  return yield* Effect.sync(() =>
    Database.transaction((db) => {
      db.insert(SecretaryStateTable).values(toRow(input.sessionID, 1, initial)).onConflictDoNothing().run()
      const row = db.select().from(SecretaryStateTable).where(eq(SecretaryStateTable.session_id, input.sessionID)).get()
      if (!row) throw new Database.NotFoundError({ message: `Secretary state not found after init: ${input.sessionID}` })
      return fromRow(row)
    }),
  )
})

const compareAndSwap: Interface["compareAndSwap"] = Effect.fn("SecretaryState.compareAndSwap")(function* (input) {
  return yield* Effect.sync(() =>
    Database.transaction((db) => {
      const next = {
        ...input.next,
        sessionID: input.sessionID,
        version: input.version + 1,
      }
      const result = db
        .update(SecretaryStateTable)
        .set(toRow(input.sessionID, next.version, next))
        .where(and(eq(SecretaryStateTable.session_id, input.sessionID), eq(SecretaryStateTable.version, input.version)))
        .returning()
        .get()
      if (!result) return "stale"
      return fromRow(result)
    }),
  )
})

const update: Interface["update"] = Effect.fn("SecretaryState.update")(function* (input) {
  const current = yield* get(input.sessionID)
  if (!current) throw new Database.NotFoundError({ message: `Secretary state not found: ${input.sessionID}` })
  const result = yield* compareAndSwap({
    sessionID: input.sessionID,
    version: current.version,
    next: input.update(current),
  })
  if (result === "stale") return yield* update(input)
  return result
})

const markClassic: Interface["markClassic"] = Effect.fn("SecretaryState.markClassic")(function* (sessionID) {
  return yield* update({
    sessionID,
    update: (state) => ({
      ...state,
      classic: true,
    }),
  })
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ get, getOrInit, compareAndSwap, update, markClassic })
  }),
)

export const defaultLayer = layer

export * as SecretaryState from "./secretary-state"
