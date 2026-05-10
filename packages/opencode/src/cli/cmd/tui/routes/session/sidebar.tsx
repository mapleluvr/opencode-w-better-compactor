import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { For, createMemo, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"
import { useToast } from "../../ui/toast"
import { openSecretarySummarySnapshot, secretarySidebarRows } from "../../util/secretary-status"

function CompactStatus(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()
  const renderer = useRenderer()
  const toast = useToast()

  const config = createMemo(() => sync.data.config.compaction ?? {})
  const strategy = createMemo(() => config().strategy ?? "classic")
  const status = createMemo(() => sync.data.secretary_status[props.sessionID])
  const rows = createMemo(() =>
    secretarySidebarRows({
      strategy: strategy(),
      mode: config().secretary_bar ?? "compact",
      auto: config().auto,
      status: status(),
    }),
  )
  const color = (tone: "default" | "muted" | "warning" | "error" | "success" | undefined) => {
    if (tone === "warning") return theme.warning
    if (tone === "error") return theme.error
    if (tone === "success") return theme.success
    return tone === "default" ? theme.text : theme.textMuted
  }

  return (
    <Show when={strategy()}>
      <box flexShrink={0} gap={0} paddingRight={1}>
        <text fg={theme.text}>
          <b>Compaction</b>
        </text>
        <For each={rows()}>
          {(row) => (
            <text
              fg={color(row.tone)}
              onMouseUp={
                row.action === "summary"
                  ? () => {
                      openSecretarySummarySnapshot({
                        summary: status()?.summary,
                        renderer,
                        toast,
                        editor: process.env.VISUAL || process.env.EDITOR,
                      }).catch((err) =>
                        toast.show({
                          message: err instanceof Error ? err.message : "Failed to open secretary summary",
                          variant: "error",
                        }),
                      )
                    }
                  : undefined
              }
            >
              {row.text}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const project = useProject()
  const sync = useSync()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const session = createMemo(() => sync.session.get(props.sessionID))
  const workspace = () => {
    const workspaceID = session()?.workspaceID
    if (!workspaceID) return
    return project.workspace.get(workspaceID)
  }
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <TuiPluginRuntime.Slot
              name="sidebar_title"
              mode="single_winner"
              session_id={props.sessionID}
              title={session()!.title}
              share_url={session()!.share?.url}
            >
              <box paddingRight={1}>
                <text fg={theme.text}>
                  <b>{session()!.title}</b>
                </text>
                <Show when={InstallationChannel !== "latest"}>
                  <text fg={theme.textMuted}>{props.sessionID}</text>
                </Show>
                <Show when={session()!.workspaceID}>
                  <text fg={theme.textMuted}>
                    <Show
                      when={workspace()}
                      fallback={<WorkspaceLabel type="unknown" name={session()!.workspaceID!} status="error" icon />}
                    >
                      {(item) => (
                        <WorkspaceLabel
                          type={item().type}
                          name={item().name}
                          status={project.workspace.status(item().id) ?? "error"}
                          icon
                        />
                      )}
                    </Show>
                  </text>
                </Show>
                <Show when={session()!.share?.url}>
                  <text fg={theme.textMuted}>{session()!.share!.url}</text>
                </Show>
              </box>
            </TuiPluginRuntime.Slot>
            <CompactStatus sessionID={props.sessionID} />
            <TuiPluginRuntime.Slot name="sidebar_content" session_id={props.sessionID} />
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <TuiPluginRuntime.Slot name="sidebar_footer" mode="single_winner" session_id={props.sessionID}>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.success }}>•</span> <b>Open</b>
              <span style={{ fg: theme.text }}>
                <b>Code</b>
              </span>{" "}
              <span>{InstallationVersion}</span>
            </text>
          </TuiPluginRuntime.Slot>
        </box>
      </box>
    </Show>
  )
}
