import { describe, expect, test } from "bun:test"
import { userMessageText } from "../../../../../../src/cli/cmd/tui/routes/session/user-message-text"
import type { Part, TextPart, FilePart } from "@opencode-ai/sdk/v2"

function textPart(overrides: Partial<TextPart> = {}): TextPart {
  return {
    id: "part-1",
    sessionID: "ses-1",
    messageID: "msg-1",
    type: "text",
    text: "hello world",
    ...overrides,
  }
}

function filePart(overrides: Partial<FilePart> = {}): FilePart {
  return {
    id: "f1",
    sessionID: "ses",
    messageID: "msg",
    type: "file",
    mime: "text/plain",
    url: "file:///a.ts",
    ...overrides,
  }
}

describe("userMessageText", () => {
  test("includes normal (non-synthetic) text parts", () => {
    const parts: Part[] = [textPart()]
    expect(userMessageText(parts)).toBe("hello world")
  })

  test("excludes ordinary synthetic text parts", () => {
    const parts: Part[] = [textPart({ synthetic: true })]
    expect(userMessageText(parts)).toBe("")
  })

  test("includes synthetic text parts with compaction_continue metadata", () => {
    const parts: Part[] = [textPart({ synthetic: true, metadata: { compaction_continue: true } })]
    expect(userMessageText(parts)).toBe("hello world")
  })

  test("excludes synthetic text parts with unrelated metadata", () => {
    const parts: Part[] = [textPart({ synthetic: true, metadata: { other: true } })]
    expect(userMessageText(parts)).toBe("")
  })

  test("joins multiple text parts with double newline", () => {
    const parts: Part[] = [
      textPart({ id: "p1", text: "first" }),
      textPart({ id: "p2", text: "second" }),
    ]
    expect(userMessageText(parts)).toBe("first\n\nsecond")
  })

  test("mixes normal, excluded synthetic, and included compaction_continue parts", () => {
    const parts: Part[] = [
      textPart({ id: "p1", text: "normal" }),
      textPart({ id: "p2", text: "ignored", synthetic: true }),
      textPart({ id: "p3", text: "continue", synthetic: true, metadata: { compaction_continue: true } }),
    ]
    expect(userMessageText(parts)).toBe("normal\n\ncontinue")
  })

  test("filters out non-text parts", () => {
    const parts: Part[] = [filePart({ filename: "a.ts" }), textPart()]
    expect(userMessageText(parts)).toBe("hello world")
  })
})
