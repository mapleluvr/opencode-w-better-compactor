import { describe, expect, test } from "bun:test"
import {
  compactionToast,
  formatSecretaryStatus,
  markToastEvent,
  openSecretarySummarySnapshot,
  secretarySidebarRows,
  secretarySummaryPreview,
  secretaryToast,
} from "../../../../src/cli/cmd/tui/util/secretary-status"

describe("secretary status formatting", () => {
  test("formats diagnostic status with boundaries and continuation session", () => {
    expect(
      formatSecretaryStatus({
        status: "compacting",
        retry_count: 2,
        payload_degraded: true,
        compact_waiting: true,
        new_session_id: "ses_next",
        summary_up_to: "msg_summary",
        previous_diff_start: "msg_prev_start",
        previous_diff_end: "msg_prev_end",
        running_snapshot_start: "msg_run_start",
        running_snapshot_end: "msg_run_end",
      }),
    ).toEqual([
      "Status: compacting",
      "Retry count: 2",
      "New session: ses_next",
      "Payload degraded: true",
      "Compact waiting: true",
      "Summary up to: msg_summary",
      "Previous diff start: msg_prev_start",
      "Previous diff end: msg_prev_end",
      "Running snapshot start: msg_run_start",
      "Running snapshot end: msg_run_end",
    ])
  })

  test("uses a clear summary fallback label", () => {
    expect(secretarySummaryPreview(undefined, 20)).toBe("No summary yet")
    expect(secretarySummaryPreview("   ", 20)).toBe("No summary yet")
  })

  test("normalizes and truncates summary preview", () => {
    expect(secretarySummaryPreview("alpha\n\n beta   gamma", 40)).toBe("alpha beta gamma")
    expect(secretarySummaryPreview("abcdefghijklmnopqrstuvwxyz", 12)).toBe("abcdefghi...")
  })
})

describe("secretary sidebar rows", () => {
  test("keeps compact mode terse", () => {
    expect(
      secretarySidebarRows({
        strategy: "secretary",
        mode: "compact",
        status: { status: "idle", summary: "summary text", retry_count: 0, payload_degraded: false },
      }).map((row) => row.text),
    ).toEqual(["Strategy: secretary", "Status: idle"])
  })

  test("adds summary preview and boundaries in detailed mode", () => {
    expect(
      secretarySidebarRows({
        strategy: "secretary",
        mode: "detailed",
        status: {
          status: "idle",
          summary: "current summary",
          retry_count: 1,
          payload_degraded: true,
          summary_up_to: "msg_10",
          previous_diff_start: "msg_1",
          previous_diff_end: "msg_9",
          running_snapshot_start: "msg_11",
          running_snapshot_end: "msg_12",
          new_session_id: "ses_next",
        },
      }).map((row) => row.text),
    ).toEqual([
      "Strategy: secretary",
      "Status: idle",
      "Payload degraded",
      "Retry count: 1",
      "Summary range: msg_10",
      "Previous diff: msg_1 .. msg_9",
      "Running snapshot: msg_11 .. msg_12",
      "New session: ses_next",
      "Summary: current summary",
    ])
  })

  test("keeps zero retry count visible in detailed mode", () => {
    expect(
      secretarySidebarRows({
        strategy: "secretary",
        mode: "detailed",
        status: {
          status: "retrying",
          summary: "summary text",
          retry_count: 0,
        },
      }).map((row) => row.text),
    ).toContain("Retry count: 0")
  })
})

describe("secretary lifecycle toasts", () => {
  test("maps secretary action events to toast messages", () => {
    expect(
      secretaryToast({
        id: "evt_1",
        type: "session.next.secretary.started",
        properties: { sessionID: "s", timestamp: 1, status: "running" },
      }),
    ).toMatchObject({
      message: "Secretary summary started",
      variant: "info",
    })
    expect(
      secretaryToast({
        id: "evt_2",
        type: "session.next.secretary.retrying",
        properties: { sessionID: "s", timestamp: 2, status: "retrying", retry_count: 2 },
      }),
    ).toMatchObject({
      message: "Secretary summary retrying (attempt 2)",
      variant: "warning",
    })
    expect(
      secretaryToast({
        id: "evt_3",
        type: "session.next.secretary.succeeded",
        properties: { sessionID: "s", timestamp: 3, status: "idle" },
      }),
    ).toMatchObject({
      message: "Secretary summary completed",
      variant: "success",
    })
    expect(
      secretaryToast({
        id: "evt_4",
        type: "session.next.secretary.failed",
        properties: { sessionID: "s", timestamp: 4, status: "error", last_error: "model unavailable" },
      }),
    ).toMatchObject({
      message: "Secretary summary failed: model unavailable",
      variant: "error",
    })
    expect(
      secretaryToast({
        id: "evt_5",
        type: "session.next.secretary.compact.waiting",
        properties: { sessionID: "s", timestamp: 5, status: "compacting" },
      }),
    ).toMatchObject({
      message: "Secretary waiting for compaction",
      variant: "info",
    })
    expect(
      secretaryToast({
        id: "evt_6",
        type: "session.next.secretary.compact.degraded",
        properties: { sessionID: "s", timestamp: 6, status: "compacting" },
      }),
    ).toMatchObject({
      message: "Secretary payload degraded for compaction",
      variant: "warning",
    })
    expect(
      secretaryToast({
        id: "evt_7",
        type: "session.next.secretary.compact.started",
        properties: { sessionID: "s", timestamp: 7, status: "compacting" },
      }),
    ).toMatchObject({
      message: "Secretary compaction started",
      variant: "info",
    })
    expect(
      secretaryToast({
        id: "evt_8",
        type: "session.next.secretary.compact.switched",
        properties: { sessionID: "s", timestamp: 8, status: "compacting", new_session_id: "ses-next" },
      }),
    ).toMatchObject({
      message: "Secretary switched to continuation session",
      variant: "success",
    })
  })

  test("maps compaction events to reason-specific toast messages", () => {
    expect(
      compactionToast({
        id: "evt_1",
        type: "session.next.compaction.started",
        properties: { sessionID: "s", timestamp: 1, reason: "auto" },
      }),
    ).toMatchObject({
      message: "Auto compaction started",
      variant: "info",
    })
    expect(
      compactionToast({
        id: "evt_2",
        type: "session.next.compaction.ended",
        properties: { sessionID: "s", timestamp: 2, text: "summary", reason: "manual" },
      }),
    ).toMatchObject({
      message: "Manual compaction completed",
      variant: "success",
    })
    expect(
      compactionToast({
        id: "evt_3",
        type: "session.next.compaction.failed",
        properties: { sessionID: "s", timestamp: 3, reason: "auto", error: "context too large" },
      }),
    ).toMatchObject({
      message: "Auto compaction failed: context too large",
      variant: "error",
    })
  })

  test("deduplicates toast events by event id", () => {
    const seen = new Set<string>()
    expect(markToastEvent(seen, { id: "evt_1" })).toBe(true)
    expect(markToastEvent(seen, { id: "evt_1" })).toBe(false)
    expect(markToastEvent(seen, { id: "evt_2" })).toBe(true)
  })
})

describe("secretary summary snapshot", () => {
  test("shows a toast when no editor is configured", async () => {
    const messages: string[] = []
    await openSecretarySummarySnapshot({
      summary: "summary text",
      editor: undefined,
      renderer: {} as never,
      toast: { show: (input) => messages.push(input.message) },
      open: async () => "ignored",
    })

    expect(messages).toEqual(["Set VISUAL or EDITOR to open the secretary summary"])
  })

  test("opens summary read-only and discards editor output", async () => {
    const opened: string[] = []
    await openSecretarySummarySnapshot({
      summary: "summary text",
      editor: "test-editor",
      renderer: {} as never,
      toast: { show: () => undefined },
      open: async (input) => {
        opened.push(input.value)
        return "edited text"
      },
    })

    expect(opened).toEqual(["summary text"])
  })

  test("passes explicit editor through to the opener", async () => {
    const editors: Array<string | undefined> = []
    await openSecretarySummarySnapshot({
      summary: "summary text",
      editor: "test-editor",
      renderer: {} as never,
      toast: { show: () => undefined },
      open: async (input) => {
        editors.push(input.editor)
        return undefined
      },
    })

    expect(editors).toEqual(["test-editor"])
  })
})
