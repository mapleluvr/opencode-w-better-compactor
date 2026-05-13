import type { CliRenderer } from "@opentui/core"
import type {
  EventSessionNextCompactionEnded,
  EventSessionNextCompactionFailed,
  EventSessionNextCompactionStarted,
  EventSessionNextSecretaryCompactDegraded,
  EventSessionNextSecretaryCompactStarted,
  EventSessionNextSecretaryCompactSwitched,
  EventSessionNextSecretaryCompactWaiting,
  EventSessionNextSecretaryFailed,
  EventSessionNextSecretaryRetrying,
  EventSessionNextSecretaryStarted,
  EventSessionNextSecretarySucceeded,
  SecretaryStatusResponse,
} from "@opencode-ai/sdk/v2"
import { Editor } from "./editor"

type ToastPayload = {
  message: string
  variant: "info" | "success" | "warning" | "error"
}

type SecretaryStatus = Pick<SecretaryStatusResponse, "status"> &
  Partial<
    Pick<
      SecretaryStatusResponse,
      | "summary"
      | "retry_count"
      | "last_error"
      | "last_success_at"
      | "payload_degraded"
      | "compact_waiting"
      | "summary_up_to"
      | "previous_diff_start"
      | "previous_diff_end"
      | "running_snapshot_start"
      | "running_snapshot_end"
    >
  > &
  Partial<Pick<EventSessionNextSecretaryCompactSwitched["properties"], "new_session_id" | "auto_switch">>

type SecretaryEvent =
  | EventSessionNextSecretaryStarted
  | EventSessionNextSecretaryRetrying
  | EventSessionNextSecretarySucceeded
  | EventSessionNextSecretaryFailed
  | EventSessionNextSecretaryCompactWaiting
  | EventSessionNextSecretaryCompactDegraded
  | EventSessionNextSecretaryCompactStarted
  | EventSessionNextSecretaryCompactSwitched

type CompactionEvent = EventSessionNextCompactionStarted | EventSessionNextCompactionEnded | EventSessionNextCompactionFailed

export type SecretarySidebarRow = {
  text: string
  tone?: "default" | "muted" | "warning" | "error" | "success"
  action?: "summary"
}

export function formatSecretaryStatus(status: SecretaryStatus) {
  return [
    `Status: ${status.status}`,
    status.retry_count === undefined ? undefined : `Retry count: ${status.retry_count}`,
    status.new_session_id ? `New session: ${status.new_session_id}` : undefined,
    status.last_success_at ? `Last success: ${new Date(status.last_success_at).toLocaleString()}` : undefined,
    status.last_error ? `Last error: ${status.last_error}` : undefined,
    status.payload_degraded === undefined ? undefined : `Payload degraded: ${status.payload_degraded}`,
    status.compact_waiting === undefined ? undefined : `Compact waiting: ${status.compact_waiting}`,
    status.summary_up_to ? `Summary up to: ${status.summary_up_to}` : undefined,
    status.previous_diff_start ? `Previous diff start: ${status.previous_diff_start}` : undefined,
    status.previous_diff_end ? `Previous diff end: ${status.previous_diff_end}` : undefined,
    status.running_snapshot_start ? `Running snapshot start: ${status.running_snapshot_start}` : undefined,
    status.running_snapshot_end ? `Running snapshot end: ${status.running_snapshot_end}` : undefined,
  ].filter((line): line is string => Boolean(line))
}

export function secretarySummaryPreview(summary: string | undefined, maxLength: number) {
  const normalized = summary?.trim().replace(/\s+/g, " ") ?? ""
  if (!normalized) return "No summary yet"
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`
}

export function secretarySidebarRows(input: {
  strategy: "classic" | "secretary" | string
  mode: "compact" | "detailed"
  auto?: boolean
  status?: SecretaryStatus
}): SecretarySidebarRow[] {
  if (input.strategy === "classic") {
    const rows: SecretarySidebarRow[] = [{ text: `Strategy: ${input.strategy}`, tone: "muted" as const }]
    if (input.auto === false) rows.push({ text: "Auto: disabled", tone: "muted" as const })
    return rows
  }

  const statusRows = [
    { text: `Status: ${input.status?.status ?? "unavailable"}`, tone: "muted" as const },
    input.status?.last_success_at
      ? { text: `Last success: ${new Date(input.status.last_success_at).toLocaleString()}`, tone: "muted" as const }
      : undefined,
    input.status?.last_error ? { text: `Error: ${input.status.last_error}`, tone: "error" as const } : undefined,
    input.status?.payload_degraded ? { text: "Payload degraded", tone: "warning" as const } : undefined,
  ].filter(Boolean) as SecretarySidebarRow[]

  const compact: SecretarySidebarRow[] = [
    { text: `Strategy: ${input.strategy}`, tone: "muted" as const },
    ...statusRows,
  ]

  if (input.mode === "compact") return compact

  const previousStart = input.status?.previous_diff_start ?? "?"
  const previousEnd = input.status?.previous_diff_end ?? "?"
  const snapshotStart = input.status?.running_snapshot_start ?? "?"
  const snapshotEnd = input.status?.running_snapshot_end ?? "?"

  return [
    ...compact,
    input.status?.retry_count !== undefined
      ? { text: `Retry count: ${input.status.retry_count}`, tone: "muted" as const }
      : undefined,
    input.status?.compact_waiting ? { text: "Compact waiting: true", tone: "muted" as const } : undefined,
    input.status?.summary_up_to ? { text: `Summary range: ${input.status.summary_up_to}`, tone: "muted" as const } : undefined,
    input.status?.previous_diff_start || input.status?.previous_diff_end
      ? { text: `Previous diff: ${previousStart} .. ${previousEnd}`, tone: "muted" as const }
      : undefined,
    input.status?.running_snapshot_start || input.status?.running_snapshot_end
      ? { text: `Running snapshot: ${snapshotStart} .. ${snapshotEnd}`, tone: "muted" as const }
      : undefined,
    input.status?.new_session_id ? { text: `New session: ${input.status.new_session_id}`, tone: "muted" as const } : undefined,
    { text: `Summary: ${secretarySummaryPreview(input.status?.summary, 80)}`, tone: "muted" as const, action: "summary" as const },
  ].filter(Boolean) as SecretarySidebarRow[]
}

function assertNever(value: never): never {
  throw new Error(`Unhandled event: ${JSON.stringify(value)}`)
}

export function secretaryToast(event: SecretaryEvent): ToastPayload | undefined {
  switch (event.type) {
    case "session.next.secretary.started":
      return { message: "Secretary summary started", variant: "info" }
    case "session.next.secretary.retrying":
      return { message: `Secretary summary retrying (attempt ${event.properties.retry_count ?? 1})`, variant: "warning" }
    case "session.next.secretary.succeeded":
      return { message: "Secretary summary completed", variant: "success" }
    case "session.next.secretary.failed":
      return {
        message: `Secretary summary failed${event.properties.last_error ? `: ${event.properties.last_error}` : ""}`,
        variant: "error",
      }
    case "session.next.secretary.compact.waiting":
      return { message: "Secretary waiting for compaction", variant: "info" }
    case "session.next.secretary.compact.degraded":
      return { message: "Secretary payload degraded for compaction", variant: "warning" }
    case "session.next.secretary.compact.started":
      return { message: "Secretary compaction started", variant: "info" }
    case "session.next.secretary.compact.switched":
      return { message: "Secretary switched to continuation session", variant: "success" }
    default:
      return assertNever(event)
  }
}

export function compactionToast(event: CompactionEvent): ToastPayload {
  const reason = `${event.properties.reason.slice(0, 1).toUpperCase()}${event.properties.reason.slice(1)}`
  switch (event.type) {
    case "session.next.compaction.started":
      return { message: `${reason} compaction started`, variant: "info" }
    case "session.next.compaction.ended":
      return { message: `${reason} compaction completed`, variant: "success" }
    case "session.next.compaction.failed":
      return { message: `${reason} compaction failed: ${event.properties.error ?? "unknown error"}`, variant: "error" }
    default:
      return assertNever(event)
  }
}

export function markToastEvent(seen: Set<string>, event: { id: string }) {
  if (seen.has(event.id)) return false
  seen.add(event.id)
  return true
}

export async function openSecretarySummarySnapshot(input: {
  summary?: string
  renderer: CliRenderer
  toast: { show: (payload: ToastPayload) => void }
  editor?: string
  open?: (input: { value: string; renderer: CliRenderer; editor?: string }) => Promise<string | undefined>
}) {
  if (!input.summary) {
    input.toast.show({ message: "No secretary summary available yet", variant: "warning" })
    return
  }

  if (!input.editor) {
    input.toast.show({ message: "Set VISUAL or EDITOR to open the secretary summary", variant: "warning" })
    return
  }

  await (input.open ?? Editor.open)({ value: input.summary, renderer: input.renderer, editor: input.editor })
}

export * as SecretaryStatus from "./secretary-status"
