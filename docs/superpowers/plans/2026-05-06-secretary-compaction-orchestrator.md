# Secretary Compaction Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `compaction.strategy = "secretary"` with background secretary summaries, cross-session secretary compact transitions, and TUI controls while preserving classic compaction as the default.

**Architecture:** Keep classic compaction in the current same-session flow and add a dedicated secretary compact orchestrator for all secretary-specific work. The orchestrator owns background summary snapshots, state CAS, payload assembly, payload trimming, new-session creation, prompt handoff, and secretary status events. `SessionPrompt` only calls small boundary methods after complete assistant responses and before model sends.

**Tech Stack:** TypeScript, Bun, Effect services, Drizzle SQLite schema/migrations, opencode SDK generation, Solid/OpenTUI TUI components.

---

## Investigation Results

- Classic compaction is implemented in `packages/opencode/src/session/compaction.ts`; `create()` inserts a same-session `compaction` part and `process()` writes the summary assistant message.
- `packages/opencode/src/session/prompt.ts` invokes classic compaction from the run loop at pending task handling and overflow checks.
- The complete assistant-response boundary is in `SessionPrompt.runLoop()` where `lastAssistant.finish` is set and not `tool-calls`.
- The model-send boundary is immediately before `handle.process()` in `SessionPrompt.runLoop()`.
- Current session storage has no generic metadata column; a dedicated secretary state table is the clearest fit for versioned per-session state.
- TUI command registration lives in `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`; slash autocomplete comes from `dialog-command.tsx`.
- TUI config updates can use `sdk.client.config.update(...)`; the SDK must be regenerated after config schema changes.

## File Structure

- Modify `packages/opencode/src/config/config.ts` for `compaction.strategy` and `compaction.secretary`.
- Modify `packages/opencode/src/session/session.sql.ts` and generate one migration with `bun run db generate --name secretary_compaction_state`.
- Create `packages/opencode/src/session/secretary-state.ts` for state schema, read/update/CAS helpers, and current-boundary initialization.
- Create `packages/opencode/src/session/secretary-compaction.ts` for the secretary compact orchestrator.
- Modify `packages/opencode/src/session/message-v2.ts` for boundary, range, serialization, and secretary turn-count helpers.
- Modify `packages/opencode/src/session/compaction.ts` to remain the strategy facade and preserve classic compaction.
- Modify `packages/opencode/src/session/prompt.ts` to call secretary boundary hooks.
- Modify `packages/opencode/src/v2/session-event.ts`, `packages/opencode/src/session/projectors-next.ts`, and TUI sync state for secretary status events.
- Modify `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` only where manual compact dispatch needs strategy-aware behavior.
- Modify `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` for `/compaction` and strategy-aware manual `/compact`.
- Modify `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` for default and debug secretary status.
- Update or add tests in `packages/opencode/test/config/config.test.ts`, `packages/opencode/test/session/message-v2.test.ts`, `packages/opencode/test/session/compaction.test.ts`, `packages/opencode/test/session/prompt.test.ts`, `packages/opencode/test/v2/session-message-updater.test.ts`, and `packages/opencode/test/cli/cmd/tui/sync.test.tsx`.

## Implementation Tasks

### Task 1: Config Shape And Defaults

**Files:**
- Modify: `packages/opencode/src/config/config.ts`
- Test: `packages/opencode/test/config/config.test.ts`

- [ ] **Step 1: Add failing config parsing tests**

Add tests that load these config fragments and assert decoded shape:

```ts
{
  compaction: {
    auto: true,
    strategy: "secretary",
    secretary: {
      model: "anthropic/claude-haiku-4-5",
      diff_token_threshold: 20000,
      diff_turn_threshold: 8,
      context_token_threshold: 120000,
    },
  },
}
```

Also assert `strategy` can be `"classic"`, omitted `strategy` stays omitted in raw config, and non-positive secretary thresholds fail schema decoding.

Run from `packages/opencode`:

```bash
bun test test/config/config.test.ts -t compaction
```

Expected before implementation: config tests for `strategy` and `secretary` fail because the fields are not in `Config.Info`.

- [ ] **Step 2: Extend `Config.Info`**

In `config.ts`, extend `compaction` with:

```ts
strategy: Schema.optional(Schema.Literal("classic", "secretary")),
secretary: Schema.optional(
  Schema.Struct({
    model: Schema.optional(ConfigModelID.ConfigModelID),
    diff_token_threshold: Schema.optional(PositiveInt),
    diff_turn_threshold: Schema.optional(PositiveInt),
    context_token_threshold: Schema.optional(PositiveInt),
  }),
),
```

Keep existing `auto`, `prune`, `tail_turns`, `preserve_recent_tokens`, and `reserved` unchanged.

- [ ] **Step 3: Add effective config helpers in the secretary orchestrator**

Do not encode behavioral defaults as schema decoding defaults. Secretary code should treat omitted `compaction.strategy` as `"classic"` and omitted secretary thresholds as implementation defaults.

- [ ] **Step 4: Verify config tests**

Run from `packages/opencode`:

```bash
bun test test/config/config.test.ts -t compaction
```

Expected after implementation: the new compaction config tests pass.

### Task 2: Message Boundaries And Secretary Turn Counting

**Files:**
- Modify: `packages/opencode/src/session/message-v2.ts`
- Test: `packages/opencode/test/session/message-v2.test.ts`

- [ ] **Step 1: Add failing turn-count tests**

Add tests for:

- `user, assistant` counts as 1.
- `tool, assistant` counts as 1.
- `user, tool, assistant` counts as 1.
- `assistant, user, user` adds one open tail turn after adjacent user merge.
- `assistant, tool, tool` adds one open tail turn after adjacent tool merge.
- Adjacent assistant messages that share the same `parentID` count as one assistant anchor.

Run from `packages/opencode`:

```bash
bun test test/session/message-v2.test.ts -t secretary
```

Expected before implementation: exported helper is missing.

- [ ] **Step 2: Add helpers near `filterCompacted()`**

Add top-level helpers with narrow exports:

```ts
export function secretaryTurnCount(messages: WithParts[]) {
  // implementation uses MessageV2.WithParts, msg.info.role, msg.info.parentID, and adjacent role merging
}

export function secretaryRange(input: { messages: WithParts[]; start?: MessageID; end?: MessageID }) {
  // returns the inclusive message slice for stored boundaries
}

export function nextBoundary(messages: WithParts[], boundary?: MessageID) {
  // returns the first message ID after boundary, or undefined when no later message exists
}
```

Use array methods where the implementation stays readable; keep loops only where boundary scanning is clearer.

- [ ] **Step 3: Add serialization helper for secretary prompts**

Add a helper that converts a `WithParts[]` range to stable text by reusing existing `toModelMessagesEffect(messages, model, { stripMedia: true })` in the orchestrator rather than duplicating provider formatting in `message-v2.ts`.

- [ ] **Step 4: Verify message tests**

Run from `packages/opencode`:

```bash
bun test test/session/message-v2.test.ts -t secretary
```

Expected after implementation: secretary boundary and turn-count tests pass.

### Task 3: Secretary State Storage

**Files:**
- Modify: `packages/opencode/src/session/session.sql.ts`
- Create: `packages/opencode/src/session/secretary-state.ts`
- Generate: `packages/opencode/migration/*_secretary_compaction_state/migration.sql`
- Test: `packages/opencode/test/session/secretary-state.test.ts`

- [ ] **Step 1: Add failing state service tests**

Test:

- `getOrInit(sessionID)` creates idle state with `new_diff_start` at the first message after the current last message when enabling mid-session.
- `compareAndSwap(input)` updates when `version` matches.
- `compareAndSwap(input)` returns a stale result when `version` does not match.
- `markClassic(sessionID)` stops future secretary triggers without deleting state.

Run from `packages/opencode`:

```bash
bun test test/session/secretary-state.test.ts
```

Expected before implementation: module is missing.

- [ ] **Step 2: Add Drizzle table**

Add `SecretaryStateTable` to `session.sql.ts`:

```ts
export const SecretaryStateTable = sqliteTable(
  "secretary_state",
  {
    session_id: text()
      .$type<SessionID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    status: text().$type<"idle" | "running" | "retrying" | "error" | "compacting">().notNull(),
    summary: text(),
    summary_up_to: text().$type<MessageID>(),
    previous_diff_start: text().$type<MessageID>(),
    previous_diff_end: text().$type<MessageID>(),
    new_diff_start: text().$type<MessageID>(),
    running_snapshot_start: text().$type<MessageID>(),
    running_snapshot_end: text().$type<MessageID>(),
    retry_count: integer().notNull(),
    last_error: text(),
    last_success_at: integer(),
    payload_degraded: integer({ mode: "boolean" }).notNull(),
    ...Timestamps,
  },
  (table) => [index("secretary_state_status_idx").on(table.status)],
)
```

- [ ] **Step 3: Generate migration**

Run from `packages/opencode`:

```bash
bun run db generate --name secretary_compaction_state
```

Expected: Drizzle creates one migration folder under `packages/opencode/migration`.

- [ ] **Step 4: Implement state service**

Create `secretary-state.ts` using the module self-export pattern. The implementation should read/write `SecretaryStateTable` through `Database.use`, increment `version` on successful updates, and keep all table columns mapped one-to-one to the `Info` shape:

```ts
export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info | undefined>
  readonly getOrInit: (input: { sessionID: SessionID; messages: MessageV2.WithParts[] }) => Effect.Effect<Info>
  readonly compareAndSwap: (input: { sessionID: SessionID; version: number; next: Info }) => Effect.Effect<Info | "stale">
  readonly update: (input: { sessionID: SessionID; update: (state: Info) => Info }) => Effect.Effect<Info>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SecretaryState") {}
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    return Service.of({ get, getOrInit, compareAndSwap, update })
  }),
)
export const defaultLayer = layer
export * as SecretaryState from "./secretary-state"
```

- [ ] **Step 5: Verify state tests**

Run from `packages/opencode`:

```bash
bun test test/session/secretary-state.test.ts
```

Expected after implementation: state service tests pass.

### Task 4: Secretary Events And TUI Sync Shape

**Files:**
- Modify: `packages/opencode/src/v2/session-event.ts`
- Modify: `packages/opencode/src/session/projectors-next.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- Test: `packages/opencode/test/v2/session-message-updater.test.ts`
- Test: `packages/opencode/test/cli/cmd/tui/sync.test.tsx`

- [ ] **Step 1: Add failing reducer/sync tests**

Test that secretary events preserve `sessionID`, `status`, `retry_count`, `last_error`, `payload_degraded`, and `new_session_id` when present.

Run from `packages/opencode`:

```bash
bun test test/v2/session-message-updater.test.ts -t secretary
bun test test/cli/cmd/tui/sync.test.tsx -t secretary
```

Expected before implementation: event types are missing.

- [ ] **Step 2: Add event definitions**

Add `SessionEvent.Secretary` events with these names:

```ts
session.next.secretary.started
session.next.secretary.retrying
session.next.secretary.succeeded
session.next.secretary.failed
session.next.secretary.compact.waiting
session.next.secretary.compact.degraded
session.next.secretary.compact.started
session.next.secretary.compact.switched
```

Each event includes `sessionID`, `timestamp`, and `status`; compact switched includes `new_session_id`.

- [ ] **Step 3: Project or sync events**

Do not force secretary status into classic compaction messages. Add a secretary status store keyed by `sessionID` in `useSync()` so `sidebar.tsx` can render it directly.

- [ ] **Step 4: Verify event/sync tests**

Run from `packages/opencode`:

```bash
bun test test/v2/session-message-updater.test.ts -t secretary
bun test test/cli/cmd/tui/sync.test.tsx -t secretary
```

Expected after implementation: secretary event and sync tests pass.

### Task 5: Secretary Action Orchestrator

**Files:**
- Create: `packages/opencode/src/session/secretary-compaction.ts`
- Modify: `packages/opencode/src/session/compaction.ts`
- Test: `packages/opencode/test/session/compaction.test.ts`

- [ ] **Step 1: Add failing Secretary Action tests**

Test:

- No action when strategy is omitted or `"classic"`.
- Secretary Action starts after a completed non-summary assistant response.
- Snapshot start/end are frozen while newer messages arrive.
- Success updates `summary`, `summary_up_to`, `previous_diff_start`, `previous_diff_end`, `new_diff_start`, `retry_count`, and `last_success_at`.
- Three failed attempts set `status = "error"` and preserve `new_diff_start`.
- The next complete assistant response retries with expanded `New Diff`.

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts -t secretary
```

Expected before implementation: secretary methods are missing.

- [ ] **Step 2: Implement model resolution**

In `secretary-compaction.ts`, resolve the secretary summary model in this order:

```ts
const configured = cfg.compaction?.secretary?.model
const parsed = configured ? Provider.parseModel(configured) : undefined
const model = parsed
  ? yield* provider.getModel(parsed.providerID, parsed.modelID)
  : agent.model
    ? yield* provider.getModel(agent.model.providerID, agent.model.modelID)
    : yield* provider.getModel(userMessage.model.providerID, userMessage.model.modelID)
```

- [ ] **Step 3: Implement `afterAssistantComplete`**

Export an orchestrator method:

```ts
readonly afterAssistantComplete: (input: {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  assistant: MessageV2.Assistant
  user: MessageV2.User
}) => Effect.Effect<void>
```

It checks strategy, computes `New Diff`, estimates tokens against the secretary model, checks turn count, freezes `running_snapshot_start/end`, and forks non-blocking Secretary Action into the caller scope.

- [ ] **Step 4: Implement retry and CAS commit**

Run up to three immediate attempts for one trigger. Commit only when `running_snapshot_start/end` and state version still match the frozen snapshot.

- [ ] **Step 5: Verify Secretary Action tests**

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts -t secretary
```

Expected after implementation: Secretary Action tests pass.

### Task 6: Secretary Compact Action Orchestrator

**Files:**
- Modify: `packages/opencode/src/session/secretary-compaction.ts`
- Modify: `packages/opencode/src/session/compaction.ts`
- Test: `packages/opencode/test/session/compaction.test.ts`

- [ ] **Step 1: Add failing compact action tests**

Test:

- `beforeModelSend` returns no transition when context threshold is not exceeded.
- Running Secretary Action is awaited before compact payload assembly.
- Missing summary forces a Secretary Action for current `New Diff` and waits.
- Payload is `Latest Summary + full Previous Diff + full New Diff`.
- Payload overflow trims only `Previous Diff` and sets `payload_degraded = true`.
- New session is created and old session remains listable.

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts -t "secretary compact"
```

Expected before implementation: compact action methods are missing.

- [ ] **Step 2: Implement `beforeModelSend`**

Export:

```ts
readonly beforeModelSend: (input: {
  sessionID: SessionID
  messages: MessageV2.WithParts[]
  user: MessageV2.User
  model: Provider.Model
}) => Effect.Effect<{ type: "continue" } | { type: "switched"; sessionID: SessionID }>
```

It uses `compaction.secretary.context_token_threshold` when set; otherwise it uses the existing overflow logic.

- [ ] **Step 3: Implement payload assembly**

Build payload sections as plain text:

```text
Latest Summary

Previous Diff

New Diff
```

Use `MessageV2.toModelMessagesEffect(range, model, { stripMedia: true })` plus `Token.estimate(JSON.stringify(...))` for sizing.

- [ ] **Step 4: Implement cross-session transition**

Use `Session.Service.create({ parentID: input.sessionID, agent: input.user.agent, model: input.user.model })`, then call the prompt service with a synthetic user text part containing the compact payload. Return the new session ID so the TUI can switch.

- [ ] **Step 5: Verify compact action tests**

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts -t "secretary compact"
```

Expected after implementation: secretary compact action tests pass.

### Task 7: Prompt Loop Integration

**Files:**
- Modify: `packages/opencode/src/session/prompt.ts`
- Test: `packages/opencode/test/session/prompt.test.ts`

- [ ] **Step 1: Add failing prompt loop tests**

Test:

- Secretary Action hook runs after complete assistant response and before loop exit.
- Secretary Action hook does not run for summary assistant messages.
- Secretary Compact Action hook runs before `handle.process()` for user prompts.
- Secretary Compact Action hook runs before `handle.process()` for tool-result continuations.
- When compact action returns `switched`, the old loop stops without sending another request in the old session.

Run from `packages/opencode`:

```bash
bun test test/session/prompt.test.ts -t secretary
```

Expected before integration: hooks are not called.

- [ ] **Step 2: Inject orchestrator service**

In `prompt.ts`, yield `SecretaryCompaction.Service` alongside existing `SessionCompaction.Service`.

- [ ] **Step 3: Call `afterAssistantComplete`**

At the complete assistant boundary near `lastAssistant.finish`, call the hook only when the assistant is not a summary and has no error.

- [ ] **Step 4: Call `beforeModelSend`**

Immediately before `handle.process()`, call `beforeModelSend`. If it returns `switched`, publish a TUI/session-switch event and break the old loop.

- [ ] **Step 5: Verify prompt tests**

Run from `packages/opencode`:

```bash
bun test test/session/prompt.test.ts -t secretary
```

Expected after implementation: prompt integration tests pass.

### Task 8: Manual `/compact` Strategy Dispatch

**Files:**
- Modify: `packages/opencode/src/session/compaction.ts`
- Modify: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Test: `packages/opencode/test/session/compaction.test.ts`

- [ ] **Step 1: Add failing manual dispatch tests**

Test:

- Manual compact with omitted strategy uses classic `SessionCompaction.create()`.
- Manual compact with `"classic"` uses classic `SessionCompaction.create()`.
- Manual compact with `"secretary"` calls secretary compact action and returns the new session ID.

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts -t "manual secretary"
```

Expected before implementation: manual secretary dispatch is missing.

- [ ] **Step 2: Keep `/compact` semantic**

Do not make `/compact` open settings. It remains "compact now" and dispatches based on active strategy.

- [ ] **Step 3: Return switch information to TUI**

When secretary compact creates a new session, return or emit the new session ID through the existing TUI event path so the client can navigate.

- [ ] **Step 4: Verify manual dispatch tests**

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts -t "manual secretary"
```

Expected after implementation: manual dispatch tests pass.

### Task 9: `/compaction` Settings Command

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- Test: `packages/opencode/test/cli/cmd/tui/sync.test.tsx`

- [ ] **Step 1: Add failing command registration test**

Assert that command palette contains `Compaction settings` and slash autocomplete contains `/compaction`, `/autocompact`, and `/secretary`.

Run from `packages/opencode`:

```bash
bun test test/cli/cmd/tui/sync.test.tsx -t compaction
```

Expected before implementation: `/compaction` is absent.

- [ ] **Step 2: Add local command beside `/compact`**

Register:

```ts
{
  title: "Compaction settings",
  value: "compaction.settings",
  category: "Session",
  slash: { name: "compaction", aliases: ["autocompact", "secretary"] },
  onSelect: (dialog) => dialog.replace(() => <DialogCompactionSettings sessionID={route.sessionID} />),
}
```

- [ ] **Step 3: Implement settings dialog**

Use `DialogSelect` for the top-level menu and `DialogPrompt.show(...)` for numeric thresholds. Use text entry for `Secretary model` in the first version with validation that the value includes a provider and model separated by `/`.

- [ ] **Step 4: Write config updates**

Use `sdk.client.config.update({ compaction: { ...sync.data.config.compaction, auto: true, strategy: "secretary" } })` for enabling secretary and equivalent updates for classic and disable.

- [ ] **Step 5: Verify TUI command tests**

Run from `packages/opencode`:

```bash
bun test test/cli/cmd/tui/sync.test.tsx -t compaction
```

Expected after implementation: command registration tests pass.

### Task 10: Sidebar Secretary Status

**Files:**
- Modify: `packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx`
- Modify: `packages/opencode/src/cli/cmd/tui/context/sync.tsx`
- Test: `packages/opencode/test/cli/cmd/tui/sync.test.tsx`

- [ ] **Step 1: Add failing sidebar render tests**

Render sidebar state for:

- classic strategy.
- secretary idle with last success.
- secretary error with recent error.
- secretary payload degraded.
- debug mode with token, turn, retry, and boundary fields.

Run from `packages/opencode`:

```bash
bun test test/cli/cmd/tui/sync.test.tsx -t "secretary sidebar"
```

Expected before implementation: secretary sidebar fields are absent.

- [ ] **Step 2: Render default view**

In `Sidebar`, add a compact status block before `sidebar_content` slot. Show strategy, status, last success, recent error, and payload degraded. Keep text terse.

- [ ] **Step 3: Render debug view**

Search `packages/opencode/src/cli/cmd/tui` for existing debug flags. If none controls sidebar diagnostic fields, add `debug: Schema.optional(Schema.Boolean)` under `compaction.secretary` in `Config.Info`, update `sdk.client.config.update(...)` writes to preserve that value, and render debug-only token/turn/retry/boundary fields when `sync.data.config.compaction?.secretary?.debug === true`.

- [ ] **Step 4: Verify sidebar tests**

Run from `packages/opencode`:

```bash
bun test test/cli/cmd/tui/sync.test.tsx -t "secretary sidebar"
```

Expected after implementation: sidebar tests pass.

### Task 11: SDK Regeneration And Full Verification

**Files:**
- Regenerate: `packages/sdk/js/src/**`
- Regenerate: `packages/sdk/openapi.json`
- Verify: package tests and typecheck

- [ ] **Step 1: Regenerate SDK after schema/API changes**

Run from repo root:

```bash
./packages/sdk/js/script/build.ts
```

Expected: generated SDK reflects `compaction.strategy`, `compaction.secretary`, and any secretary compact response shape.

- [ ] **Step 2: Run focused tests**

Run from `packages/opencode`:

```bash
bun test test/config/config.test.ts -t compaction
bun test test/session/message-v2.test.ts -t secretary
bun test test/session/secretary-state.test.ts
bun test test/session/compaction.test.ts -t secretary
bun test test/session/prompt.test.ts -t secretary
bun test test/v2/session-message-updater.test.ts -t secretary
bun test test/cli/cmd/tui/sync.test.tsx -t compaction
```

Expected: all focused secretary tests pass.

- [ ] **Step 3: Run typecheck**

Run from `packages/opencode`:

```bash
bun typecheck
```

Expected: typecheck exits 0.

- [ ] **Step 4: Run broader compaction regression tests**

Run from `packages/opencode`:

```bash
bun test test/session/compaction.test.ts test/session/prompt.test.ts test/session/message-v2.test.ts
```

Expected: existing classic compaction behavior and new secretary behavior pass together.

## Self-Review

- Spec coverage: configuration, state, turn counting, Secretary Action, failure policy, Compact Action, manual `/compact`, TUI `/compaction`, sidebar, events, and testing are all mapped to tasks above.
- Orchestrator decision: Task 5 and Task 6 keep secretary compact out of the classic same-session flow and make `compaction.ts` a strategy facade.
- Classic default: Task 1 and Task 8 preserve omitted strategy as classic behavior.
- Old session visibility: Task 6 creates a new continuation session and does not call `MessageV2.filterCompacted()` to hide the old secretary source session.
- SDK regeneration: Task 11 includes the repo-required JavaScript SDK regeneration step.
