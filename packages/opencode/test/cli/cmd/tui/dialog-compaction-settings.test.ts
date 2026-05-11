import { describe, expect, test } from "bun:test"
import {
  compactionControlDescriptions,
  formatStatus,
  createSecretarySummaryOption,
  secretaryControlDescriptions,
  updateCompactionSettings,
} from "../../../../src/cli/cmd/tui/component/dialog-compaction-settings"

describe("DialogCompactionSettings controls", () => {
  test("separates auto state from compaction strategy", () => {
    expect(compactionControlDescriptions({ auto: true, strategy: "classic" })).toEqual({
      auto: "Enabled",
      strategy: "Classic",
      secretaryBar: "Compact",
    })
    expect(compactionControlDescriptions({ auto: false, strategy: "secretary" })).toEqual({
      auto: "Disabled",
      strategy: "Secretary",
      secretaryBar: "Compact",
    })
    expect(compactionControlDescriptions({})).toEqual({
      auto: "Enabled",
      strategy: "Classic",
      secretaryBar: "Compact",
    })
  })

  test("shows secretary bar state in control descriptions", () => {
    expect(
      compactionControlDescriptions({ auto: true, strategy: "secretary", secretary_bar: "detailed" }),
    ).toEqual({
      auto: "Enabled",
      strategy: "Secretary",
      secretaryBar: "Detailed",
    })
    expect(compactionControlDescriptions({})).toMatchObject({ secretaryBar: "Compact" })
  })

  test("provides p q r defaults when secretary fields are omitted", () => {
    expect(secretaryControlDescriptions()).toMatchObject({
      diffTokenThreshold: "100000",
      diffTurnThreshold: "20",
      contextTokenThreshold: "120000",
    })
    expect(secretaryControlDescriptions({ model: "anthropic/claude-haiku-4-5" })).toMatchObject({
      diffTokenThreshold: "100000",
      diffTurnThreshold: "20",
      contextTokenThreshold: "120000",
    })
  })

  test("uses configured p q r values when present", () => {
    expect(
      secretaryControlDescriptions({
        diff_token_threshold: 20000,
        diff_turn_threshold: 8,
        context_token_threshold: 64000,
      }),
    ).toMatchObject({
      diffTokenThreshold: "20000",
      diffTurnThreshold: "8",
      contextTokenThreshold: "64000",
    })
  })

  test("closes the dialog before awaiting config update", async () => {
    const events: string[] = []
    let resolveUpdate!: () => void
    const pending = new Promise<void>((resolve) => {
      resolveUpdate = resolve
    })

    const saved = updateCompactionSettings({
      compaction: { strategy: "secretary", secretary: { diff_token_threshold: 1234 } },
      dialog: {
        clear: () => events.push("clear"),
      },
      toast: {
        show: () => events.push("toast"),
      },
      update: async () => {
        events.push("update-start")
        await pending
        events.push("update-end")
      },
    })

    await Promise.resolve()
    expect(events).toEqual(["clear", "update-start"])

    resolveUpdate()
    await saved
    expect(events).toEqual(["clear", "update-start", "update-end"])
  })
})

describe("secretary summary option", () => {
  test("opens the current summary through the shared snapshot helper", async () => {
    const opened: Array<{ summary?: string; editor?: string }> = []
    const option = createSecretarySummaryOption({
      summary: "current summary text",
      renderer: {} as never,
      toast: { show: () => undefined },
      editor: "test-editor",
      openSummary: async (input) => {
        opened.push({ summary: input.summary, editor: input.editor })
      },
    })

    expect(option.title).toBe("View secretary summary")
    expect(option.description).toBe("current summary text")

    await option.onSelect?.({ clear: () => undefined } as never)

    expect(opened).toEqual([{ summary: "current summary text", editor: "test-editor" }])
  })

  test("loads a persisted summary when the cache is empty", async () => {
    const opened: Array<string | undefined> = []
    const loaded: string[] = []
    const option = createSecretarySummaryOption({
      summary: undefined,
      renderer: {} as never,
      toast: { show: () => undefined },
      editor: "test-editor",
      loadSummary: async () => {
        loaded.push("called")
        return "stored summary text"
      },
      openSummary: async (input) => {
        opened.push(input.summary)
      },
    })

    await option.onSelect?.({ clear: () => undefined } as never)

    expect(loaded).toEqual(["called"])
    expect(opened).toEqual(["stored summary text"])
  })

  test("shows an error toast when the opener rejects", async () => {
    const messages: string[] = []
    const option = createSecretarySummaryOption({
      summary: "current summary text",
      renderer: {} as never,
      toast: { show: (input) => messages.push(input.message) },
      editor: "test-editor",
      openSummary: async () => {
        throw new Error("open failed")
      },
    })

    await option.onSelect?.({ clear: () => undefined } as never)

    expect(messages).toEqual(["open failed"])
  })

  test("shows a fallback label when the session has no secretary summary yet", () => {
    const option = createSecretarySummaryOption({
      summary: undefined,
      renderer: {} as never,
      toast: { show: () => undefined },
      editor: undefined,
    })

    expect(option.description).toBe("No summary yet")
  })
})

describe("formatStatus", () => {
  test("displays new_session_id when present", () => {
    const lines = formatStatus({
      status: "compacting",
      new_session_id: "ses-abc123",
    })
    expect(lines).toContain("New session: ses-abc123")
  })

  test("omits new_session_id line when absent", () => {
    const lines = formatStatus({ status: "idle" })
    for (const line of lines) expect(line).not.toContain("New session")
  })

  test("renders essential fields", () => {
    const lines = formatStatus({ status: "running", retry_count: 3 })
    expect(lines).toContain("Status: running")
    expect(lines).toContain("Retry count: 3")
  })

  test("renders last_success_at as formatted date", () => {
    const lines = formatStatus({ status: "idle", last_success_at: 1700000000000 })
    const successLine = lines.find((l) => l.startsWith("Last success:"))
    expect(successLine).toBeDefined()
  })

  test("omits last_success_at line when zero", () => {
    const lines = formatStatus({ status: "idle", last_success_at: 0 })
    const successLine = lines.find((l) => l.startsWith("Last success:"))
    expect(successLine).toBeUndefined()
  })

  test("displays compact_waiting when true", () => {
    const lines = formatStatus({ status: "compacting", compact_waiting: true })
    expect(lines).toContain("Compact waiting: true")
  })
})
