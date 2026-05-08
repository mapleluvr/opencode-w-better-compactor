import { describe, expect, test } from "bun:test"
import {
  compactionControlDescriptions,
  formatStatus,
  secretaryControlDescriptions,
  updateCompactionSettings,
} from "../../../../src/cli/cmd/tui/component/dialog-compaction-settings"

describe("DialogCompactionSettings controls", () => {
  test("separates auto state from compaction strategy", () => {
    expect(compactionControlDescriptions({ auto: true, strategy: "classic" })).toEqual({
      auto: "Enabled",
      strategy: "Classic",
    })
    expect(compactionControlDescriptions({ auto: false, strategy: "secretary" })).toEqual({
      auto: "Disabled",
      strategy: "Secretary",
    })
    expect(compactionControlDescriptions({})).toEqual({
      auto: "Enabled",
      strategy: "Classic",
    })
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
