import { TextAttributes } from "@opentui/core"
import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useDialog } from "@tui/ui/dialog"

export function DialogSecretaryStatus(props: { lines: string[] }) {
  const dialog = useDialog()
  const { theme } = useTheme()

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Secretary status
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={0} paddingBottom={1}>
        <For each={props.lines}>{(line) => <text fg={theme.textMuted}>{line}</text>}</For>
      </box>
    </box>
  )
}
