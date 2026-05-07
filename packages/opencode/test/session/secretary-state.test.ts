import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "../../src/storage/db"
import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID } from "../../src/project/schema"
import { SecretaryState } from "../../src/session/secretary-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionTable } from "../../src/session/session.sql"
import { MessageID, SessionID } from "../../src/session/schema"

function userMessage(id: string): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("session"),
      role: "user",
      time: { created: 0 },
      agent: "user",
      model: { providerID: "test", modelID: "test" },
      tools: {},
      mode: "",
    } as unknown as MessageV2.User,
    parts: [],
  }
}

function assistantMessage(id: string, parentID: string): MessageV2.WithParts {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: SessionID.make("session"),
      role: "assistant",
      time: { created: 0 },
      parentID: MessageID.make(parentID),
      modelID: "test",
      providerID: "test",
      mode: "",
      agent: "agent",
      path: { cwd: "/", root: "/" },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
    } as unknown as MessageV2.Assistant,
    parts: [],
  }
}

function run<A>(effect: Effect.Effect<A, never, SecretaryState.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(SecretaryState.defaultLayer)))
}

function makeSessionID(id: string) {
  return SessionID.make(`session_${id}_${crypto.randomUUID()}`)
}

function createSession(id: SessionID) {
  Database.use((db) =>
    db
      .insert(ProjectTable)
      .values({
        id: ProjectID.global,
        worktree: "/",
        sandboxes: [],
      })
      .onConflictDoNothing()
      .run(),
  )
  Database.use((db) =>
    db
      .insert(SessionTable)
      .values({
        id,
        project_id: ProjectID.global,
        slug: id,
        directory: "/",
        title: id,
        version: "test",
      })
      .run(),
  )
  return id
}

describe("SecretaryState", () => {
  test("getOrInit creates idle state with new_diff_start after the current last message", async () => {
    const sessionID = createSession(makeSessionID("init"))
    const messages = [userMessage("u1"), assistantMessage("a1", "u1")]

    const state = await run(SecretaryState.Service.use((svc) => svc.getOrInit({ sessionID, messages })))

    expect(state.sessionID).toBe(sessionID)
    expect(state.version).toBe(1)
    expect(state.status).toBe("idle")
    expect(state.newDiffStart).toBeUndefined()
    expect(state.classic).toBe(false)
  })

  test("getOrInit returns the initialized row for concurrent callers", async () => {
    const sessionID = createSession(makeSessionID("concurrent"))
    const quoted = `'${sessionID.replaceAll("'", "''")}'`
    Database.Client().$client.run(/* sql */ `
      CREATE TEMP TRIGGER secretary_state_conflict_before_insert
      BEFORE INSERT ON secretary_state
      WHEN NEW.session_id = ${quoted}
      BEGIN
        INSERT INTO secretary_state (
          session_id,
          version,
          status,
          retry_count,
          payload_degraded,
          classic,
          time_created,
          time_updated
        ) VALUES (
          NEW.session_id,
          1,
          'idle',
          0,
          0,
          0,
          NEW.time_created,
          NEW.time_updated
        );
      END
    `)

    try {
      const state = await run(SecretaryState.Service.use((svc) => svc.getOrInit({ sessionID, messages: [] })))

      expect(state).toMatchObject({
        sessionID,
        version: 1,
        status: "idle",
      })
    } finally {
      Database.Client().$client.run("DROP TRIGGER IF EXISTS secretary_state_conflict_before_insert")
    }
  })

  test("compareAndSwap updates when version matches", async () => {
    const sessionID = createSession(makeSessionID("cas"))
    const initial = await run(SecretaryState.Service.use((svc) => svc.getOrInit({ sessionID, messages: [] })))

    const updated = await run(
      SecretaryState.Service.use((svc) =>
        svc.compareAndSwap({
          sessionID,
          version: initial.version,
          next: {
            ...initial,
            status: "running",
            summary: "summary",
            newDiffStart: MessageID.make("u2"),
          },
        }),
      ),
    )

    expect(updated).toMatchObject({
      sessionID,
      version: 2,
      status: "running",
      summary: "summary",
      newDiffStart: MessageID.make("u2"),
    })
  })

  test("compareAndSwap returns stale when version does not match", async () => {
    const sessionID = createSession(makeSessionID("stale"))
    const initial = await run(SecretaryState.Service.use((svc) => svc.getOrInit({ sessionID, messages: [] })))

    const updated = await run(
      SecretaryState.Service.use((svc) =>
        svc.compareAndSwap({
          sessionID,
          version: initial.version + 1,
          next: {
            ...initial,
            status: "running",
          },
        }),
      ),
    )

    expect(updated).toBe("stale")
    expect(await run(SecretaryState.Service.use((svc) => svc.get(sessionID)))).toEqual(initial)
  })

  test("compareAndSwap clears nullable fields when next state omits them", async () => {
    const sessionID = createSession(makeSessionID("clear"))
    const initial = await run(SecretaryState.Service.use((svc) => svc.getOrInit({ sessionID, messages: [] })))
    const populated = await run(
      SecretaryState.Service.use((svc) =>
        svc.compareAndSwap({
          sessionID,
          version: initial.version,
          next: {
            ...initial,
            summary: "summary",
            summaryUpTo: MessageID.make("summary-up-to"),
            previousDiffStart: MessageID.make("previous-start"),
            previousDiffEnd: MessageID.make("previous-end"),
            newDiffStart: MessageID.make("new-start"),
            runningSnapshotStart: MessageID.make("running-start"),
            runningSnapshotEnd: MessageID.make("running-end"),
            lastError: "failed",
            lastSuccessAt: 123,
          },
        }),
      ),
    )
    if (populated === "stale") throw new Error("expected populated state")

    const cleared = await run(
      SecretaryState.Service.use((svc) =>
        svc.compareAndSwap({
          sessionID,
          version: populated.version,
          next: {
            ...populated,
            summary: undefined,
            summaryUpTo: undefined,
            previousDiffStart: undefined,
            previousDiffEnd: undefined,
            newDiffStart: undefined,
            runningSnapshotStart: undefined,
            runningSnapshotEnd: undefined,
            lastError: undefined,
            lastSuccessAt: undefined,
          },
        }),
      ),
    )
    if (cleared === "stale") throw new Error("expected cleared state")

    expect(cleared).toMatchObject({
      version: populated.version + 1,
      summary: undefined,
      summaryUpTo: undefined,
      previousDiffStart: undefined,
      previousDiffEnd: undefined,
      newDiffStart: undefined,
      runningSnapshotStart: undefined,
      runningSnapshotEnd: undefined,
      lastError: undefined,
      lastSuccessAt: undefined,
    })
    expect(await run(SecretaryState.Service.use((svc) => svc.get(sessionID)))).toEqual(cleared)
  })

  test("markClassic stops future secretary triggers without deleting state", async () => {
    const sessionID = createSession(makeSessionID("classic"))
    const initial = await run(SecretaryState.Service.use((svc) => svc.getOrInit({ sessionID, messages: [] })))

    const marked = await run(SecretaryState.Service.use((svc) => svc.markClassic(sessionID)))

    expect(marked).toMatchObject({
      sessionID,
      version: initial.version + 1,
      classic: true,
    })
    expect(await run(SecretaryState.Service.use((svc) => svc.get(sessionID)))).toEqual(marked)
  })
})
