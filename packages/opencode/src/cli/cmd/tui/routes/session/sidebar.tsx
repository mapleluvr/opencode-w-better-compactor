import { useProject } from "@tui/context/project"
import { useSync } from "@tui/context/sync"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useTuiConfig } from "../../context/tui-config"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { TuiPluginRuntime } from "@/cli/cmd/tui/plugin/runtime"

import { getScrollAcceleration } from "../../util/scroll"
import { WorkspaceLabel } from "../../component/workspace-label"

function CompactStatus(props: { sessionID: string }) {
  const sync = useSync()
  const { theme } = useTheme()

  const config = createMemo(() => sync.data.config.compaction ?? {})
  const strategy = createMemo(() => config().strategy ?? "classic")
  const status = createMemo(() => sync.data.secretary_status[props.sessionID])
  const debug = createMemo(() => config().secretary?.debug === true)

  return (
    <Show when={strategy()}>
      <box flexShrink={0} gap={0} paddingRight={1}>
        <text fg={theme.text}>
          <b>Compaction</b>
        </text>
        <text fg={theme.textMuted}>Strategy: {strategy()}</text>
        <Show when={strategy() === "secretary" && status()}>
          <text fg={theme.textMuted}>Status: {status()!.status}</text>
          <Show when={status()!.last_success_at}>
            <text fg={theme.textMuted}>Last success: {new Date(status()!.last_success_at!).toLocaleString()}</text>
          </Show>
          <Show when={status()!.last_error}>
            <text fg={theme.error}>Error: {status()!.last_error}</text>
          </Show>
          <Show when={status()!.payload_degraded}>
            <text fg={theme.warning}>Payload degraded</text>
          </Show>
          <Show when={debug()}>
            <text fg={theme.textMuted}>Retry count: {status()!.retry_count ?? 0}</text>
            <Show when={status()!.diff_token_count != null}>
              <text fg={theme.textMuted}>Diff tokens: {status()!.diff_token_count}</text>
            </Show>
            <Show when={status()!.diff_turn_count != null}>
              <text fg={theme.textMuted}>Diff turns: {status()!.diff_turn_count}</text>
            </Show>
            <Show when={status()!.summary_up_to}>
              <text fg={theme.textMuted}>Summary up to: {status()!.summary_up_to}</text>
            </Show>
            <Show when={status()!.previous_diff_start || status()!.previous_diff_end}>
              <text fg={theme.textMuted}>
                Previous diff: {status()!.previous_diff_start ?? "?"} .. {status()!.previous_diff_end ?? "?"}
              </text>
            </Show>
            <Show when={status()!.running_snapshot_start || status()!.running_snapshot_end}>
              <text fg={theme.textMuted}>
                Running snapshot: {status()!.running_snapshot_start ?? "?"} .. {status()!.running_snapshot_end ?? "?"}
              </text>
            </Show>
            <Show when={status()!.compact_waiting}>
              <text fg={theme.textMuted}>Compact waiting: true</text>
            </Show>
            <Show when={status()!.new_session_id}>
              <text fg={theme.textMuted}>New session: {status()!.new_session_id}</text>
            </Show>
          </Show>
        </Show>
        <Show when={strategy() === "classic" && !config().auto}>
          <text fg={theme.textMuted}>Auto: disabled</text>
        </Show>
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
