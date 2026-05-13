/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createEffect, onMount } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import type { Session } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "../../../../src/cli/cmd/tui/context/args"
import { ExitProvider } from "../../../../src/cli/cmd/tui/context/exit"
import { KVProvider, useKV } from "../../../../src/cli/cmd/tui/context/kv"
import { ProjectProvider } from "../../../../src/cli/cmd/tui/context/project"
import { SDKProvider, type EventSource } from "../../../../src/cli/cmd/tui/context/sdk"
import { SyncProvider, useSync } from "../../../../src/cli/cmd/tui/context/sync"
import { RouteProvider, useRoute } from "../../../../src/cli/cmd/tui/context/route"
import { tmpdir } from "../../../fixture/fixture"

const worktree = "/tmp/opencode"
const directory = `${worktree}/packages/opencode`

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
}

function eventSource(emit?: (handler: Parameters<EventSource["subscribe"]>[0]) => void): EventSource {
  return {
    subscribe: async (handler) => {
      emit?.(handler)
      return () => {}
    },
  }
}

function sessionInfo(id: string): Session {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    directory,
    path: "packages/opencode",
    title: id,
    version: "test",
    time: {
      created: 1,
      updated: 1,
    },
  }
}

function createFetch(
  options: {
    config?: () => Response | Promise<Response>
    sessionGet?: () => Response | Promise<Response>
    sessionList?: () => Response | Promise<Response>
  } = {},
) {
  const session = [] as URL[]
  const sessionGet = [] as URL[]
  const fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (url.pathname === "/session") session.push(url)
    if (url.pathname === "/session/session-1") sessionGet.push(url)

    switch (url.pathname) {
      case "/agent":
      case "/command":
      case "/experimental/workspace":
      case "/experimental/workspace/status":
      case "/formatter":
      case "/lsp":
        return json([])
      case "/experimental/resource":
      case "/mcp":
      case "/provider/auth":
      case "/session/status":
        return json({})
      case "/config":
        return options.config?.() ?? json({})
      case "/config/providers":
        return json({ providers: {}, default: {} })
      case "/experimental/console":
        return json({ consoleManagedProviders: [], switchableOrgCount: 0 })
      case "/path":
        return json({ home: "", state: "", config: "", worktree, directory })
      case "/project/current":
        return json({ id: "proj_test" })
      case "/provider":
        return json({ all: [], default: {}, connected: [] })
      case "/session/session-1":
        return options.sessionGet?.() ?? json(sessionInfo("session-1"))
      case "/session/session-1/diff":
      case "/session/session-1/message":
      case "/session/session-1/todo":
      case "/session":
        return options.sessionList?.() ?? json([])
      case "/vcs":
        return json({ branch: "main" })
    }

    throw new Error(`unexpected request: ${url.pathname}`)
  }) as typeof globalThis.fetch

  return { fetch, session, sessionGet }
}

type EventHandler = Parameters<EventSource["subscribe"]>[0]

function controllableEventSource() {
  let handler: EventHandler | undefined
  let ready!: () => void
  const subscribed = new Promise<void>((resolve) => {
    ready = resolve
  })

  return {
    source: {
      subscribe: async (next) => {
        handler = next
        ready()
        return () => {}
      },
    } satisfies EventSource,
    async emit(event: Parameters<EventHandler>[0]) {
      await subscribed
      handler?.(event)
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function mount(input: {
  emit?: (handler: EventHandler) => void
  events?: EventSource
  config?: () => Response | Promise<Response>
  sessionGet?: () => Response | Promise<Response>
  sessionList?: () => Response | Promise<Response>
} = {}) {
  const calls = createFetch(input)
  let sync!: ReturnType<typeof useSync>
  let kv!: ReturnType<typeof useKV>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={input.events ?? eventSource(input.emit)}>
            <ProjectProvider>
              <SyncProvider>
                <Probe
                  onReady={(ctx) => {
                    sync = ctx.sync
                    kv = ctx.kv
                    done()
                  }}
                />
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  await wait(() => sync.status === "complete")
  return { app, kv, sync, session: calls.session, sessionGet: calls.sessionGet }
}

async function mountRoute(input: { emit?: (handler: Parameters<EventSource["subscribe"]>[0]) => void } = {}) {
  const calls = createFetch()
  let route!: ReturnType<typeof useRoute>
  let done!: () => void
  const ready = new Promise<void>((resolve) => {
    done = resolve
  })

  const app = await testRender(() => (
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={eventSource(input.emit)}>
            <ProjectProvider>
              <SyncProvider>
                <RouteProvider initialRoute={{ type: "session", sessionID: "session-1" }}>
                  <RouteProbe
                    onReady={(ctx) => {
                      route = ctx.route
                      done()
                    }}
                  />
                </RouteProvider>
              </SyncProvider>
            </ProjectProvider>
          </SDKProvider>
        </KVProvider>
      </ExitProvider>
    </ArgsProvider>
  ))

  await ready
  return { app, route }
}

function Probe(props: { onReady: (ctx: { kv: ReturnType<typeof useKV>; sync: ReturnType<typeof useSync> }) => void }) {
  const kv = useKV()
  const sync = useSync()

  onMount(() => {
    props.onReady({ kv, sync })
  })

  return <box />
}

function RouteProbe(props: { onReady: (ctx: { route: ReturnType<typeof useRoute> }) => void }) {
  const route = useRoute()
  const sync = useSync()

  createEffect(() => {
    if (route.data.type !== "session") return
    const status = sync.data.secretary_status[route.data.sessionID]
    if (status?.auto_switch === false) return
    const newSessionID = status?.new_session_id
    if (newSessionID) route.navigate({ type: "session", sessionID: newSessionID })
  })

  onMount(() => {
    props.onReady({ route })
  })

  return <box />
}

describe("tui sync", () => {
  test("session.created events add new sessions to the sync store", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const events = controllableEventSource()
    const { app, sync } = await mount({ events: events.source })

    try {
      await events.emit({
        directory,
        payload: {
          id: "evt_session_created",
          type: "session.created",
          properties: {
            sessionID: "session-2",
            info: sessionInfo("session-2"),
          },
        },
      })
      await wait(() => sync.session.get("session-2") !== undefined)
      expect(sync.session.get("session-2")?.id).toBe("session-2")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount()

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/opencode")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("secretary events update secretary status by session", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount({
      emit: (handler) => {
        handler({
          directory,
          payload: {
            id: "evt_1",
            type: "session.next.secretary.retrying",
            properties: {
              sessionID: "session-1",
              timestamp: 1,
              status: "retrying",
              retry_count: 2,
              last_error: "temporary failure",
              payload_degraded: true,
              running_snapshot_start: "msg-run-start",
              running_snapshot_end: "msg-run-end",
              previous_diff_start: "msg-prev-start",
              previous_diff_end: "msg-prev-end",
              summary_up_to: "msg-summary-to",
            },
          },
        })
        handler({
          directory,
          payload: {
            id: "evt_2",
            type: "session.next.secretary.compact.switched",
            properties: {
              sessionID: "session-1",
              timestamp: 2,
              status: "idle",
              retry_count: 0,
              payload_degraded: false,
              new_session_id: "session-2",
              last_success_at: 100,
              diff_token_count: 5000,
              diff_turn_count: 3,
              summary_up_to: "msg-final",
              previous_diff_start: "msg-prev-start-2",
              previous_diff_end: "msg-prev-end-2",
              running_snapshot_start: "msg-run-start-2",
              running_snapshot_end: "msg-run-end-2",
              compact_waiting: true,
            },
          },
        })
      },
    })

    try {
      await wait(() => sync.data.secretary_status["session-1"]?.new_session_id === "session-2")
      expect(sync.data.secretary_status["session-1"]).toEqual({
        sessionID: "session-1",
        timestamp: 2,
        status: "idle",
        retry_count: 0,
        payload_degraded: false,
        new_session_id: "session-2",
        last_success_at: 100,
        diff_token_count: 5000,
        diff_turn_count: 3,
        summary_up_to: "msg-final",
        previous_diff_start: "msg-prev-start-2",
        previous_diff_end: "msg-prev-end-2",
        running_snapshot_start: "msg-run-start-2",
        running_snapshot_end: "msg-run-end-2",
        compact_waiting: true,
      })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("does not carry fully synced sessions into filtered refresh results", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount()

    try {
      await sync.session.sync("session-1")
      expect(sync.session.get("session-1")?.id).toBe("session-1")

      await sync.session.refresh()

      expect(sync.session.get("session-1")).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("keeps a retained session across instance disposal reload", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const events = controllableEventSource()
    const { app, sync, session } = await mount({ events: events.source })
    const release = sync.session.retain("session-1")

    try {
      await sync.session.sync("session-1")
      expect(sync.session.get("session-1")?.id).toBe("session-1")

      const previousSessionRequests = session.length
      await events.emit({
        directory,
        payload: {
          id: "evt_disposed_1",
          type: "server.instance.disposed",
          properties: {
            directory,
          },
        },
      })

      await wait(() => session.length > previousSessionRequests)
      expect(sync.session.get("session-1")?.id).toBe("session-1")
    } finally {
      release()
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("does not preserve a deleted retained session during refresh", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const events = controllableEventSource()
    const { app, sync } = await mount({ events: events.source })
    const release = sync.session.retain("session-1")

    try {
      await sync.session.sync("session-1")
      expect(sync.session.get("session-1")?.id).toBe("session-1")

      await events.emit({
        directory,
        payload: {
          id: "evt_deleted_1",
          type: "session.deleted",
          properties: {
            sessionID: "session-1",
            info: sessionInfo("session-1"),
          },
        },
      })

      await sync.session.refresh()

      expect(sync.session.get("session-1")).toBeUndefined()
    } finally {
      release()
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("explicit sync rehydrates a dropped fully synced session", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync, sessionGet } = await mount()

    try {
      await sync.session.sync("session-1")
      const previousSessionGets = sessionGet.length
      sync.set("session", [])

      await sync.session.sync("session-1")

      expect(sessionGet.length).toBeGreaterThan(previousSessionGets)
      expect(sync.session.get("session-1")?.id).toBe("session-1")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("does not commit a session sync that completes after deletion", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const pendingSession = deferred<Response>()
    const events = controllableEventSource()
    const { app, sync, sessionGet } = await mount({
      events: events.source,
      sessionGet: () => pendingSession.promise,
    })

    try {
      sync.set("session", [sessionInfo("session-1")])
      expect(sync.session.get("session-1")?.id).toBe("session-1")
      const synced = sync.session.sync("session-1")
      await wait(() => sessionGet.length === 1)
      await events.emit({
        directory,
        payload: {
          id: "evt_deleted_during_sync_1",
          type: "session.deleted",
          properties: {
            sessionID: "session-1",
            info: sessionInfo("session-1"),
          },
        },
      })
      await wait(() => sync.session.get("session-1") === undefined)

      pendingSession.resolve(json(sessionInfo("session-1")))
      await synced

      expect(sessionGet.length).toBe(1)
      expect(sync.session.get("session-1")).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("does not commit a bootstrap session list that completes after deletion", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const pendingConfig = deferred<Response>()
    const events = controllableEventSource()
    let configCalls = 0
    const { app, sync, session } = await mount({
      events: events.source,
      config: () => {
        configCalls += 1
        if (configCalls === 1) return json({})
        return pendingConfig.promise
      },
      sessionList: () => json([sessionInfo("session-1")]),
    })
    const release = sync.session.retain("session-1")

    try {
      expect(sync.session.get("session-1")?.id).toBe("session-1")
      const previousSessionRequests = session.length
      await events.emit({
        directory,
        payload: {
          id: "evt_disposed_before_delete_1",
          type: "server.instance.disposed",
          properties: {
            directory,
          },
        },
      })
      await wait(() => session.length > previousSessionRequests)

      await events.emit({
        directory,
        payload: {
          id: "evt_deleted_during_bootstrap_1",
          type: "session.deleted",
          properties: {
            sessionID: "session-1",
            info: sessionInfo("session-1"),
          },
        },
      })
      await wait(() => sync.session.get("session-1") === undefined)

      pendingConfig.resolve(json({}))
      await Bun.sleep(20)

      expect(sync.session.get("session-1")).toBeUndefined()
    } finally {
      release()
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("dedupes in-flight session sync requests", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync, sessionGet } = await mount()

    try {
      await Promise.all([sync.session.sync("session-1"), sync.session.sync("session-1")])

      expect(sessionGet.length).toBe(1)
      expect(sync.session.get("session-1")?.id).toBe("session-1")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("secretary switched status navigates to the new session", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, route } = await mountRoute({
      emit: (handler) => {
        handler({
          directory,
          payload: {
            id: "evt_nav_1",
            type: "session.next.secretary.compact.switched",
            properties: {
              sessionID: "session-1",
              timestamp: 2,
              status: "idle",
              retry_count: 0,
              payload_degraded: false,
              new_session_id: "session-2",
            },
          },
        })
      },
    })

    try {
      await wait(() => route.data.type === "session" && route.data.sessionID === "session-2")
      expect(route.data).toEqual({ type: "session", sessionID: "session-2" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("secretary switched status with auto_switch false does not navigate", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, route } = await mountRoute({
      emit: (handler) => {
        handler({
          directory,
          payload: {
            id: "evt_nav_subagent_1",
            type: "session.next.secretary.compact.switched",
            properties: {
              sessionID: "session-1",
              timestamp: 2,
              status: "idle",
              retry_count: 0,
              payload_degraded: false,
              new_session_id: "session-2",
              auto_switch: false,
            },
          },
        })
      },
    })

    try {
      await Bun.sleep(50)
      expect(route.data).toEqual({ type: "session", sessionID: "session-1" })
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("secretary sidebar status data shape stores idle with success", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount({
      emit: (handler) => {
        handler({
          directory,
          payload: {
            id: "evt_s_1",
            type: "session.next.secretary.succeeded",
            properties: {
              sessionID: "session-1",
              timestamp: 100,
              status: "idle",
              retry_count: 0,
              payload_degraded: false,
              summary: "current summary text",
              last_success_at: 100,
              summary_up_to: "msg-123",
              previous_diff_start: "msg-50",
              previous_diff_end: "msg-100",
              diff_token_count: 4200,
              diff_turn_count: 2,
            },
          },
        })
      },
    })

    try {
      await wait(() => sync.data.secretary_status["session-1"] !== undefined)
      expect(sync.data.secretary_status["session-1"].status).toBe("idle")
      expect(sync.data.secretary_status["session-1"].payload_degraded).toBe(false)
      expect(sync.data.secretary_status["session-1"].retry_count).toBe(0)
      expect(sync.data.secretary_status["session-1"].last_success_at).toBe(100)
      expect(sync.data.secretary_status["session-1"].summary).toBe("current summary text")
      expect(sync.data.secretary_status["session-1"].summary_up_to).toBe("msg-123")
      expect(sync.data.secretary_status["session-1"].previous_diff_start).toBe("msg-50")
      expect(sync.data.secretary_status["session-1"].previous_diff_end).toBe("msg-100")
      expect(sync.data.secretary_status["session-1"].diff_token_count).toBe(4200)
      expect(sync.data.secretary_status["session-1"].diff_turn_count).toBe(2)
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("secretary sidebar status data shape stores error with last_error", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount({
      emit: (handler) => {
        handler({
          directory,
          payload: {
            id: "evt_f_1",
            type: "session.next.secretary.failed",
            properties: {
              sessionID: "session-1",
              timestamp: 200,
              status: "error",
              retry_count: 3,
              last_error: "model unavailable",
              payload_degraded: true,
              running_snapshot_start: "msg-run-start",
              running_snapshot_end: "msg-run-end",
              previous_diff_start: "msg-prev-start",
              previous_diff_end: "msg-prev-end",
              summary_up_to: "msg-summary-to",
            },
          },
        })
      },
    })

    try {
      await wait(() => sync.data.secretary_status["session-1"]?.status === "error")
      expect(sync.data.secretary_status["session-1"].last_error).toBe("model unavailable")
      expect(sync.data.secretary_status["session-1"].retry_count).toBe(3)
      expect(sync.data.secretary_status["session-1"].payload_degraded).toBe(true)
      expect(sync.data.secretary_status["session-1"].running_snapshot_start).toBe("msg-run-start")
      expect(sync.data.secretary_status["session-1"].running_snapshot_end).toBe("msg-run-end")
      expect(sync.data.secretary_status["session-1"].previous_diff_start).toBe("msg-prev-start")
      expect(sync.data.secretary_status["session-1"].previous_diff_end).toBe("msg-prev-end")
      expect(sync.data.secretary_status["session-1"].summary_up_to).toBe("msg-summary-to")
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })

  test("secretary config fields are available in sync data", async () => {
    const previous = Global.Path.state
    await using tmp = await tmpdir()
    Global.Path.state = tmp.path
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, sync } = await mount()

    try {
      expect(sync.data.secretary_status).toBeDefined()
      expect(sync.data.config).toBeDefined()
      expect(sync.data.config.compaction).toBeUndefined()
    } finally {
      app.renderer.destroy()
      Global.Path.state = previous
    }
  })
})
