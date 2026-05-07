import { DialogSelect } from "@tui/ui/dialog-select"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useDialog, type DialogContext } from "@tui/ui/dialog"
import { useSync } from "@tui/context/sync"
import { useSDK } from "@tui/context/sdk"
import { useToast } from "@tui/ui/toast"
import { createMemo } from "solid-js"

interface DialogCompactionSettingsProps {
  sessionID: string
}

export function compactionControlDescriptions(config: { auto?: boolean; strategy?: "classic" | "secretary" }) {
  return {
    auto: config.auto === false ? "Disabled" : "Enabled",
    strategy: (config.strategy ?? "classic") === "secretary" ? "Secretary" : "Classic",
  }
}

export function DialogCompactionSettings(props: DialogCompactionSettingsProps) {
  const dialog = useDialog()
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()

  const config = createMemo(() => sync.data.config.compaction ?? {})
  const sec = createMemo(() => config().secretary)

  const strategy = createMemo(() => config().strategy ?? "classic")

  const diffTokenDesc = createMemo(() =>
    sec()?.diff_token_threshold != null ? String(sec()!.diff_token_threshold) : undefined,
  )
  const diffTurnDesc = createMemo(() =>
    sec()?.diff_turn_threshold != null ? String(sec()!.diff_turn_threshold) : undefined,
  )
  const contextTokenDesc = createMemo(() =>
    sec()?.context_token_threshold != null ? String(sec()!.context_token_threshold) : undefined,
  )
  const compactWaitTimeoutDesc = createMemo(() =>
    sec()?.compact_wait_timeout != null ? String(sec()!.compact_wait_timeout) : undefined,
  )

  const enableClassic = async () => {
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, strategy: "classic" } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const enableSecretary = async () => {
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, strategy: "secretary" } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const toggleAuto = async () => {
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, auto: config().auto === false } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const toggleStrategy = async () => {
    if (strategy() === "secretary") return enableClassic()
    return enableSecretary()
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
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, secretary: { ...sec(), model: value } } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const setDiffTokenThreshold = async (dialog: DialogContext) => {
    const current = sec()?.diff_token_threshold
    const value = await DialogPrompt.show(dialog, "Diff token threshold (p)", {
      placeholder: String(current ?? ""),
      description: () => <text>Trigger Secretary Action when new diff tokens exceed this</text>,
      value: current != null ? String(current) : "",
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, secretary: { ...sec(), diff_token_threshold: num } } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const setDiffTurnThreshold = async (dialog: DialogContext) => {
    const current = sec()?.diff_turn_threshold
    const value = await DialogPrompt.show(dialog, "Diff turn threshold (q)", {
      placeholder: String(current ?? ""),
      description: () => <text>Trigger Secretary Action when new diff turns exceed this</text>,
      value: current != null ? String(current) : "",
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, secretary: { ...sec(), diff_turn_threshold: num } } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const setContextTokenThreshold = async (dialog: DialogContext) => {
    const current = sec()?.context_token_threshold
    const value = await DialogPrompt.show(dialog, "Context token threshold (r)", {
      placeholder: String(current ?? ""),
      description: () => <text>Trigger Compact Action when context tokens exceed this</text>,
      value: current != null ? String(current) : "",
    })
    if (!value) return
    const num = parseInt(value, 10)
    if (!Number.isInteger(num) || num <= 0) {
      toast.show({ message: "Enter a positive integer", variant: "error" })
      return
    }
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, secretary: { ...sec(), context_token_threshold: num } } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
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
    await sdk.client.config
      .update({ config: { compaction: { ...sync.data.config.compaction, secretary: { ...sec(), compact_wait_timeout: num } } } })
      .catch(() => toast.show({ message: "Failed to update config", variant: "error" }))
    dialog.clear()
  }

  const viewSecretaryStatus = () => {
    const status = sync.data.secretary_status[props.sessionID]
    if (!status) {
      toast.show({ message: "No secretary status available for this session", variant: "warning" })
      dialog.clear()
      return
    }
    const lines = [
      `Status: ${status.status}`,
      `Retry count: ${status.retry_count ?? 0}`,
    ]
    if (status.last_success_at) lines.push(`Last success: ${new Date(status.last_success_at).toLocaleString()}`)
    if (status.last_error) lines.push(`Last error: ${status.last_error}`)
    if (status.payload_degraded) lines.push("Payload degraded: true")
    if (status.compact_waiting) lines.push("Compact waiting: true")
    if (status.new_session_id) lines.push(`New session: ${status.new_session_id}`)

    void DialogPrompt.show(dialog, "Secretary status", {
      value: lines.join("\n"),
      description: () => <text>Current secretary status for this session</text>,
    }).then(() => dialog.clear())
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
          description: sec()?.model,
          onSelect: setSecretaryModel,
        },
        {
          title: "Diff token threshold (p)",
          value: "diff_token_threshold",
          description: diffTokenDesc(),
          onSelect: setDiffTokenThreshold,
        },
        {
          title: "Diff turn threshold (q)",
          value: "diff_turn_threshold",
          description: diffTurnDesc(),
          onSelect: setDiffTurnThreshold,
        },
        {
          title: "Context token threshold (r)",
          value: "context_token_threshold",
          description: contextTokenDesc(),
          onSelect: setContextTokenThreshold,
        },
        {
          title: "Compact wait timeout (ms)",
          value: "compact_wait_timeout",
          description: compactWaitTimeoutDesc(),
          onSelect: setCompactWaitTimeout,
        },
        {
          title: "View secretary status",
          value: "status",
          onSelect: viewSecretaryStatus,
        },
      ]}
    />
  )
}
