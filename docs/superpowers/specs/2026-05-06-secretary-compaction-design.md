# Secretary Compaction Design

## Goal

Build an opencode branch that supports `secretary` as a first-class compaction strategy. The branch keeps the existing classic compaction behavior by default, adds a configurable secretary strategy, and exposes TUI commands for users to discover, enable, disable, inspect, and manually run secretary compaction.

## Non-Goals

- Do not replace classic compaction as the default behavior.
- Do not make `/compact` a settings command.
- Do not require users to start a new session after enabling secretary compaction.
- Do not backfill secretary summaries for old history when the strategy is enabled mid-session.
- Do not hide the old session after a secretary compact transition.

## Configuration

Extend `config.compaction` with a strategy field:

```json
{
  "compaction": {
    "auto": true,
    "strategy": "secretary"
  }
}
```

Supported values:

- `"classic"`: existing compaction behavior.
- `"secretary"`: incremental background secretary summaries plus secretary compact transitions.

Defaults:

- `compaction.auto`: existing default behavior.
- `compaction.strategy`: `"classic"` when omitted.

Existing config values such as `prune`, `tail_turns`, `preserve_recent_tokens`, and `reserved` remain valid. Secretary compaction should reuse existing token budgeting settings where they fit, and only add secretary-specific settings when the current config cannot express the behavior.

## Core Model

Secretary compaction splits the old "compact when full" behavior into two actions:

- `Secretary Action`: a non-blocking background summary update that incrementally summarizes new conversation diff.
- `Compact Action`: a context transition that creates a new session when the main context crosses the replacement threshold.

The main agent continues normally while secretary summaries run. Compact may block the next model request when it needs a running secretary action to finish.

## State

Secretary state is maintained per session. The implementation should store message IDs or stable message boundaries rather than duplicating full diff payloads wherever practical.

Required state:

- `status`: `idle | running | retrying | error | compacting`.
- `summary`: latest completed secretary summary text, if any.
- `summary_up_to`: last message boundary covered by `summary`.
- `previous_diff_start`: first message boundary included in the most recent successful secretary snapshot.
- `previous_diff_end`: last message boundary included in the most recent successful secretary snapshot.
- `new_diff_start`: first message boundary not yet covered by `summary`.
- `running_snapshot_start`: first message boundary in the currently running secretary snapshot, if running.
- `running_snapshot_end`: last message boundary in the currently running secretary snapshot, if running.
- `retry_count`: retry count for the current trigger.
- `last_error`: latest secretary error summary, if any.
- `last_success_at`: timestamp of the latest successful secretary action, if any.
- `payload_degraded`: whether the latest compact payload had to trim `Previous Diff`.

When secretary is enabled mid-session, initialize `new_diff_start` to the next message boundary after the current last message. Existing history is not retroactively summarized.

When switching back to classic, stop future secretary triggers. Existing secretary state may remain available for diagnostics, but it is not used for compact decisions while the strategy is classic.

## Turn Counting

Secretary Action uses turn counting over `New Diff`.

Rules:

- Assistant messages are turn anchors.
- Each assistant anchor closes one turn.
- Tail `user` or `tool` messages after the latest assistant count as one open turn.
- Adjacent messages with the same role inside a turn head are treated as one logical head item.
- If opencode's provider/message normalization can split a single assistant response into adjacent assistant messages, the turn counter must merge those split assistant anchors when they represent the same response.

The implementation should base this on opencode's actual `MessageV2.WithParts` structure, not an OpenAI-wire-format assumption.

## Secretary Action

Secretary Action is checked only after a complete assistant response has been written.

Trigger when either condition is true:

- `getTokenCount(New Diff) > p`.
- `getTurnCount(New Diff) > q`.

The action must freeze a snapshot at trigger time:

```text
snapshot_start = new_diff_start
snapshot_end = current_last_message_boundary
snapshot = messages[snapshot_start ... snapshot_end]
```

Messages created while the secretary model is running do not enter that snapshot. They remain future `New Diff`.

On success:

```text
summary = secretary_response
summary_up_to = snapshot_end
previous_diff_start = snapshot_start
previous_diff_end = snapshot_end
new_diff_start = first boundary after snapshot_end
running_snapshot_start = undefined
running_snapshot_end = undefined
retry_count = 0
status = idle
last_error = undefined
last_success_at = now
```

State updates should use a version, compare-and-swap check, or equivalent boundary validation so a late secretary response cannot overwrite newer state incorrectly.

## Secretary Prompt Shape

The secretary model receives a prompt equivalent to:

```text
Secretary system prompt
+ Previous Summary and forced confirmation, when a previous summary exists
+ Previous Diff, when it exists
+ Line Prompt
+ New Diff snapshot
+ Summary Prompt
```

The prompt tells the model:

- It is not the active coding agent.
- It only performs summary maintenance.
- It must understand the previous summary.
- It must verify how `Previous Diff` is represented in the previous summary.
- It must integrate `New Diff` into a new summary.
- It must output only the new summary.

For the first secretary action, `Previous Summary` and `Previous Diff` are empty. The implementation may omit the previous-summary confirmation block on the first run to avoid false acknowledgement of nonexistent prior context.

## Failure Policy

Secretary Action failures do not block the main agent.

For each trigger:

- Retry the secretary action up to three times immediately.
- If any attempt succeeds, commit the successful secretary state.
- If all three attempts fail:
  - Record `last_error`.
  - Set `status = error`.
  - Preserve `new_diff_start`.
  - Do not advance `summary_up_to`.
  - Let the main agent continue.

After the next complete assistant response, check again. The next secretary attempt uses an expanded `New Diff` that includes the additional response.

If the secretary model keeps failing, `New Diff` is allowed to grow. This is acceptable for the branch goal because preserving the main agent flow is more important than forcing the background summary to succeed.

## Compact Action

Compact Action is checked at model-send boundaries for tool results and user prompts. It triggers when the main context exceeds the configured replacement threshold `r`.

When the strategy is classic, keep existing compact behavior.

When the strategy is secretary:

1. If a Secretary Action is running, block the next model request from being sent and wait for that action to finish.
2. If no usable `summary` exists, trigger a Secretary Action for the current `New Diff` and wait for it.
3. Build the compact payload:

   ```text
   Latest Summary
   + full Previous Diff
   + full New Diff up to compact boundary
   ```

4. If the payload exceeds the target model context:
   - Keep `Latest Summary`.
   - Keep `New Diff`.
   - Trim only `Previous Diff`.
   - Set `payload_degraded = true` and emit a status event for TUI visibility.

5. Create a new session.
6. Send the compact payload to the new session.
7. Switch TUI to the new session.
8. Leave the old session visible and inspectable.

The first version does not require a parent/child marker in the old session. If the existing session service makes parent linkage cheap and low-risk, the implementation may set it, but the branch does not depend on it.

## Manual `/compact`

The current `/compact` command remains the manual compact command.

Behavior:

- If `compaction.strategy` is omitted or `"classic"`, `/compact` keeps the existing classic manual compact behavior.
- If `compaction.strategy` is `"secretary"`, `/compact` runs the Secretary Compact Action flow.

This keeps manual and automatic compaction semantics aligned under the active strategy.

## TUI Commands

Add a new local TUI command:

- Title: `Compaction settings`.
- Command value: `compaction.settings`.
- Slash command: `/compaction`.
- Suggested aliases: `/autocompact`, `/secretary`.
- Command palette access: visible through `Ctrl+P`.

Do not implement `/compaction` as a server prompt template. It should be a local TUI command with side effects.

The command opens a select dialog with:

- `Classic auto compaction`: sets `compaction.auto = true` and `compaction.strategy = "classic"`.
- `Secretary auto compaction`: sets `compaction.auto = true` and `compaction.strategy = "secretary"`.
- `Disable auto compaction`: sets `compaction.auto = false` and leaves or displays the current strategy.
- `View secretary status`: opens a status view/dialog for the current session.

Selecting `Secretary auto compaction` writes workspace config through the existing config update API and immediately activates secretary behavior for the current session from the current message boundary forward.

Selecting `Classic auto compaction` writes workspace config and stops future secretary triggers in the current session.

`/compact` and `/compaction` must remain semantically distinct:

- `/compact`: perform a compaction now.
- `/compaction`: configure or inspect compaction behavior.

## TUI Sidebar

The TUI sidebar should expose secretary status without making normal usage noisy.

Default view:

- Strategy: classic or secretary.
- Secretary status: idle, running, retrying, error, or compacting.
- Last success time, if available.
- Recent error summary, if any.
- Payload degraded indicator, if the latest compact transition trimmed `Previous Diff`.

Debug view:

- New Diff token count.
- New Diff turn count.
- Retry count.
- `summary_up_to`.
- `previous_diff_start` and `previous_diff_end`.
- `running_snapshot_start` and `running_snapshot_end`.
- Compact wait state.

The debug view should follow an existing debug/config flag if one fits. If no suitable flag exists, add the smallest TUI or compaction-specific debug switch needed.

## Events and Observability

Secretary state changes should be observable by TUI and logs.

Useful events:

- Secretary started.
- Secretary retrying.
- Secretary succeeded.
- Secretary failed after retries.
- Secretary compact waiting for running summary.
- Secretary compact payload degraded.
- Secretary compact started.
- Secretary compact switched session.

Events should include session ID and compact/secretary status. Debug-only fields may include token counts, turn counts, message boundaries, and retry count.

## Implementation Touchpoints

Likely modules:

- `packages/opencode/src/config/config.ts`: add `compaction.strategy` and any required secretary-specific config.
- `packages/opencode/src/session/compaction.ts`: keep classic compaction and dispatch to secretary strategy where appropriate.
- `packages/opencode/src/session/prompt.ts`: trigger Secretary Action after completed responses and invoke compact behavior at model-send boundaries.
- `packages/opencode/src/session/processor.ts`: expose or reuse response completion/tool-result boundaries as needed.
- `packages/opencode/src/session/message-v2.ts`: implement turn counting and diff range extraction against actual message structure.
- `packages/opencode/src/util/token.ts` and `packages/opencode/src/session/overflow.ts`: reuse token estimation and overflow thresholds.
- `packages/opencode/src/session/session.ts` and session storage/projectors: store secretary state and support new session creation/switch payloads.
- `packages/opencode/src/v2/session-event.ts` and related projectors: add secretary status events if existing compaction events are insufficient.
- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`: register `/compaction` near the existing `/compact` command.
- `packages/opencode/src/cli/cmd/tui/component/dialog-command.tsx`: no core change expected; it already supports command palette and slash command registration.
- `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`: display default secretary status and debug details.
- `packages/opencode/src/server/routes/instance/httpapi/groups/config.ts` and handlers: reuse config update; extend only if the generated SDK lacks the needed method after schema changes.

## Testing Strategy

Unit tests should cover:

- Config parsing for omitted, classic, secretary, and disabled auto compaction states.
- Turn counting for user/assistant, tool/assistant, adjacent same-role heads, tail user/tool messages, and split assistant messages.
- Secretary snapshot freezing while new messages arrive.
- Successful Secretary Action state transition.
- Three-attempt failure behavior and retry after the next assistant response.
- Compact waiting for a running Secretary Action before model send.
- Compact payload assembly with full `Previous Diff` and full `New Diff`.
- Payload overflow trimming only `Previous Diff`.
- Manual `/compact` dispatching to classic or secretary based on strategy.
- Mid-session `/compaction` strategy switch initializing `new_diff_start` at the current boundary.

TUI tests should cover:

- `/compaction` appears in slash autocomplete.
- `Compaction settings` appears in the command palette.
- Selecting `Secretary auto compaction` calls config update with `compaction.auto = true` and `compaction.strategy = "secretary"`.
- Selecting `Classic auto compaction` calls config update with `compaction.auto = true` and `compaction.strategy = "classic"`.
- Selecting `Disable auto compaction` calls config update with `compaction.auto = false`.
- Secretary sidebar default status renders without debug fields.
- Debug mode renders token/turn/retry/boundary fields.

Integration tests should cover:

- Classic strategy still follows existing compaction behavior.
- Secretary strategy triggers background summary after threshold.
- Secretary compact creates a new session and leaves the old session visible.
- Secretary strategy manual `/compact` switches to the new session using secretary payload.

## Open Implementation Details

These are implementation details to resolve while planning, not product behavior questions:

- Exact storage shape for secretary state.
- Whether secretary state lives as a dedicated table, session metadata, or synthetic part/event projection.
- Exact prompt text for the secretary system prompt and summary prompt.
- Exact debug flag name for sidebar details.
- Exact config names for thresholds `p`, `q`, and `r` if existing compaction thresholds cannot express them clearly.
