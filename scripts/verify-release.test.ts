import { describe, expect, test } from "bun:test"
import { verifyReleaseTag } from "./verify-release"

describe("verifyReleaseTag", () => {
  test("accepts the exact stable package version tag", () => {
    expect(() => verifyReleaseTag("v0.3.12", "0.3.12")).not.toThrow()
  })

  test("rejects missing and mismatched release tags", () => {
    expect(() => verifyReleaseTag("", "0.3.12")).toThrow("must equal package version tag v0.3.12")
    expect(() => verifyReleaseTag("v0.3.11", "0.3.12")).toThrow("must equal package version tag v0.3.12")
  })

  test("rejects prerelease package versions from the stable release workflow", () => {
    expect(() => verifyReleaseTag("v0.3.13-beta.1", "0.3.13-beta.1")).toThrow(
      "Stable GitHub releases cannot publish prerelease package version",
    )
  })
})
