import { describe, expect, beforeEach, afterEach } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { SyncEvent } from "../../src/sync"
import { Database } from "../../src/storage/db"
import { EventTable } from "../../src/sync/event.sql"
import { EventV2 } from "../../src/v2/event"
import { Flag } from "@opencode-ai/core/flag/flag"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const originalEventFlag = Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM
const originalWorkspaceFlag = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

const it = testEffect(Layer.mergeAll(SyncEvent.defaultLayer, CrossSpawnSpawner.defaultLayer))

function setup() {
  SyncEvent.reset()

  const Created = SyncEvent.define({
    type: "item.created",
    version: 1,
    aggregate: "id",
    schema: Schema.Struct({ id: Schema.String, name: Schema.String }),
  })

  SyncEvent.init({
    projectors: [SyncEvent.project(Created, () => {})],
  })

  return { Created }
}

describe("EventV2.run gate", () => {
  beforeEach(() => {
    Database.close()
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true
  })

  afterEach(() => {
    Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = originalEventFlag
    Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = originalWorkspaceFlag
  })

  it.live(
    "emits events when OPENCODE_EXPERIMENTAL_EVENT_SYSTEM is false",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        Flag.OPENCODE_EXPERIMENTAL_EVENT_SYSTEM = false
        const { Created } = setup()

        EventV2.run(Created, { id: "evt_1", name: "test" })

        const rows = Database.use((db) => db.select().from(EventTable).all())
        expect(rows).toHaveLength(1)
        expect(rows[0].aggregate_id).toBe("evt_1")
        expect(rows[0].type).toBe("item.created.1")
      }),
    ),
  )
})
