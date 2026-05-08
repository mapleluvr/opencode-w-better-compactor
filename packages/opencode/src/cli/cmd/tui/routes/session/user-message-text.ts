import type { Part, TextPart } from "@opencode-ai/sdk/v2"

export function userMessageText(parts: Part[]): string {
  return parts
    .filter((x): x is TextPart => {
      if (x.type !== "text") return false
      if (!x.synthetic) return true
      return x.metadata?.compaction_continue === true
    })
    .map((x) => x.text)
    .join("\n\n")
}
