import { describe, expect, test } from "bun:test"
import {
  compactionControlDescriptions,
  formatStatus,
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
