import { describe, expect, test } from "bun:test"
import { compactionControlDescriptions } from "../../../../src/cli/cmd/tui/component/dialog-compaction-settings"

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
