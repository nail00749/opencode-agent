import { expect, test } from "bun:test"
import { createLatestRefresh } from "./refresh-state"

test("the latest refresh always clears loading after success or failure", async () => {
  const states: boolean[] = []
  const refresh = createLatestRefresh((loading) => states.push(loading))
  await refresh.run(async () => "ready", () => {})
  await expect(refresh.run(async () => { throw new Error("offline") }, () => {})).rejects.toThrow("offline")
  expect(states).toEqual([true, false, true, false])
})

test("a stale reply cannot overwrite the newest refresh", async () => {
  const commits: string[] = []
  const refresh = createLatestRefresh(() => {})
  let release: ((value: string) => void) | undefined
  const slow = refresh.run(() => new Promise<string>((resolve) => { release = resolve }), (value) => commits.push(value))
  await refresh.run(async () => "new", (value) => commits.push(value))
  release?.("old")
  await slow
  expect(commits).toEqual(["new"])
})
