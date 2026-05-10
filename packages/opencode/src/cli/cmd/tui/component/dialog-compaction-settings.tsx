import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { createMemo } from "solid-js"

const DEFAULT_DIFF_TOKEN_THRESHOLD = 100_000
const DEFAULT_DIFF_TURN_THRESHOLD = 20
const DEFAULT_CONTEXT_TOKEN_THRESHOLD = 120_000

export function compactionControlDescriptions(config: {
  auto?: boolean
  strategy?: "classic" | "secretary"
  secretary_bar?: "compact" | "detailed"
}) {
  return {
    auto: config.auto === false ? "Disabled" : "Enabled",
    strategy: (config.strategy ?? "classic") === "secretary" ? "Secretary" : "Classic",
    secretaryBar: (config.secretary_bar ?? "compact") === "detailed" ? "Detailed" : "Compact",
  }
}

export function compactionSettingsOptionValues() {
  return [
    "auto",
    "strategy",
    "model",
    "diff_token_threshold",
    "diff_turn_threshold",
    "context_token_threshold",
    "compact_wait_timeout",
    "secretary_bar",
  ]
}

export function secretaryControlDescriptions(secretary?: {
  model?: string
  diff_token_threshold?: number
  diff_turn_threshold?: number
  context_token_threshold?: number
  compact_wait_timeout?: number
}) {
  return {
    model: secretary?.model,
    diffTokenThreshold: String(secretary?.diff_token_threshold ?? DEFAULT_DIFF_TOKEN_THRESHOLD),
    diffTurnThreshold: String(secretary?.diff_turn_threshold ?? DEFAULT_DIFF_TURN_THRESHOLD),
    contextTokenThreshold: String(secretary?.context_token_threshold ?? DEFAULT_CONTEXT_TOKEN_THRESHOLD),
    compactWaitTimeout: secretary?.compact_wait_timeout != null ? String(secretary.compact_wait_timeout) : undefined,
  }
}

export async function updateCompactionSettings(input: {
  compaction: NonNullable<ReturnType<typeof useSync>["data"]["config"]["compaction"]>
  dialog: Pick<DialogContext, "clear">
  toast: Pick<ReturnType<typeof useToast>, "show">
  update: (config: { compaction: NonNullable<ReturnType<typeof useSync>["data"]["config"]["compaction"]> }) => Promise<unknown>
}) {
  input.dialog.clear()
  await input.update({ compaction: input.compaction }).catch(() =>
    input.toast.show({ message: "Failed to update config", variant: "error" }),
  )
}

export function formatStatus(data: {
  status: "idle" | "running" | "retrying" | "error" | "compacting"
  new_session_id?: string
  retry_count?: number
  last_success_at?: number
  last_error?: string
  payload_degraded?: boolean
  compact_waiting?: boolean
  summary_up_to?: string
  previous_diff_start?: string
  previous_diff_end?: string
  running_snapshot_start?: string
  running_snapshot_end?: string
}) {
  const lines = [
    `Status: ${data.status}`,
    `Retry count: ${data.retry_count ?? 0}`,
  ]
  if (data.new_session_id) lines.push(`New session: ${data.new_session_id}`)
  if (data.last_success_at) lines.push(`Last success: ${new Date(data.last_success_at).toLocaleString()}`)
  if (data.last_error) lines.push(`Last error: ${data.last_error}`)
  if (data.payload_degraded) lines.push("Payload degraded: true")
  if (data.compact_waiting) lines.push("Compact waiting: true")
  if (data.summary_up_to) lines.push(`Summary up to: ${data.summary_up_to}`)
  if (data.previous_diff_start) lines.push(`Previous diff start: ${data.previous_diff_start}`)
  if (data.previous_diff_end) lines.push(`Previous diff end: ${data.previous_diff_end}`)
  if (data.running_snapshot_start) lines.push(`Running snapshot start: ${data.running_snapshot_start}`)
  if (data.running_snapshot_end) lines.push(`Running snapshot end: ${data.running_snapshot_end}`)
  return lines
}

export function DialogCompactionSettings() {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()

  const config = createMemo(() => sync.data.config.compaction ?? {})
  const sec = createMemo(() => config().secretary)
  const secretary = createMemo(() => secretaryControlDescriptions(sec()))

  const strategy = createMemo(() => config().strategy ?? "classic")

  const enableClassic = async () => {
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, strategy: "classic" },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const enableSecretary = async () => {
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, strategy: "secretary" },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const toggleAuto = async () => {
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, auto: config().auto === false },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const toggleStrategy = async () => {
    if (strategy() === "secretary") return enableClassic()
    return enableSecretary()
  }

  const toggleSecretaryBar = async () => {
    await updateCompactionSettings({
      compaction: {
        ...sync.data.config.compaction,
        secretary_bar: config().secretary_bar === "detailed" ? "compact" : "detailed",
      },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const setSecretaryModel = async (dialog: DialogContext) => {
    const value = await DialogPrompt.show(dialog, "Secretary model", {
      placeholder: "provider/model",
      description: () => <text>Enter provider and model, e.g. anthropic/claude-haiku-4-5</text>,
      value: sec()?.model,
    })
    if (!value) return
    if (!value.includes("/")) {
      toast.show({ message: "Model must include provider and model, separated by /", variant: "error" })
      return
    }
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, secretary: { ...sec(), model: value } },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const setDiffTokenThreshold = async (dialog: DialogContext) => {
    const value = await DialogPrompt.show(dialog, "Diff token threshold (p)", {
      placeholder: secretary().diffTokenThreshold,
      description: () => <text>Trigger Secretary Action when new diff tokens exceed this</text>,
      value: secretary().diffTokenThreshold,
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, secretary: { ...sec(), diff_token_threshold: num } },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const setDiffTurnThreshold = async (dialog: DialogContext) => {
    const value = await DialogPrompt.show(dialog, "Diff turn threshold (q)", {
      placeholder: secretary().diffTurnThreshold,
      description: () => <text>Trigger Secretary Action when new diff turns exceed this</text>,
      value: secretary().diffTurnThreshold,
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, secretary: { ...sec(), diff_turn_threshold: num } },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const setContextTokenThreshold = async (dialog: DialogContext) => {
    const value = await DialogPrompt.show(dialog, "Context token threshold (r)", {
      placeholder: secretary().contextTokenThreshold,
      description: () => <text>Trigger Compact Action when context tokens exceed this</text>,
      value: secretary().contextTokenThreshold,
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, secretary: { ...sec(), context_token_threshold: num } },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const setCompactWaitTimeout = async (dialog: DialogContext) => {
    const current = sec()?.compact_wait_timeout
    const value = await DialogPrompt.show(dialog, "Compact wait timeout (ms)", {
      placeholder: String(current ?? ""),
      description: () => <text>Time to wait for in-progress compaction before proceeding</text>,
      value: current != null ? String(current) : "",
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await updateCompactionSettings({
      compaction: { ...sync.data.config.compaction, secretary: { ...sec(), compact_wait_timeout: num } },
      dialog,
      toast,
      update: (config) => sdk.client.config.update({ config }),
    })
  }

  const controls = createMemo(() => compactionControlDescriptions(config()))

  return (
    <DialogSelect
      title="Compaction settings"
      options={[
        {
          title: "Auto compaction",
          value: "auto",
          description: controls().auto,
          onSelect: toggleAuto,
        },
        {
          title: "Compaction strategy",
          value: "strategy",
          description: controls().strategy,
          onSelect: toggleStrategy,
        },
        {
          title: "Secretary model",
          value: "model",
          description: secretary().model,
          onSelect: setSecretaryModel,
        },
        {
          title: "Diff token threshold (p)",
          value: "diff_token_threshold",
          description: secretary().diffTokenThreshold,
          onSelect: setDiffTokenThreshold,
        },
        {
          title: "Diff turn threshold (q)",
          value: "diff_turn_threshold",
          description: secretary().diffTurnThreshold,
          onSelect: setDiffTurnThreshold,
        },
        {
          title: "Context token threshold (r)",
          value: "context_token_threshold",
          description: secretary().contextTokenThreshold,
          onSelect: setContextTokenThreshold,
        },
        {
          title: "Compact wait timeout (ms)",
          value: "compact_wait_timeout",
          description: secretary().compactWaitTimeout,
          onSelect: setCompactWaitTimeout,
        },
        {
          title: "Secretary bar",
          value: "secretary_bar",
          description: controls().secretaryBar,
          onSelect: toggleSecretaryBar,
        },
      ]}
    />
  )
}
