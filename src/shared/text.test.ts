import { describe, expect, test } from "bun:test"
import { appendBounded, boundedOutput, outputLines } from "./text"

describe("boundedOutput", () => {
  test("keeps short strings intact", () => {
    expect(boundedOutput("hello")).toBe("hello")
  })

  test("truncates to the byte budget", () => {
    expect(boundedOutput("abcdefgh", 4)).toBe("abcd")
  })

  test("measures bytes, not characters, and clips at the budget", () => {
    // "ü" is two bytes; a 1-byte budget yields the replacement character for
    // the split sequence, and 2 bytes keep the character whole.
    expect(boundedOutput("üx", 2)).toBe("ü")
    expect(Buffer.byteLength(boundedOutput("üüü", 4))).toBe(4)
  })

  test("defaults to the 64 KiB budget", () => {
    const large = "x".repeat(80 * 1024)
    expect(Buffer.byteLength(boundedOutput(large))).toBe(64 * 1024)
  })
})

describe("appendBounded", () => {
  test("accumulates chunks up to the budget", () => {
    let current = ""
    current = appendBounded(current, Buffer.from("ab"), 4)
    current = appendBounded(current, Buffer.from("cd"), 4)
    expect(current).toBe("abcd")
  })

  test("truncates the chunk that crosses the budget", () => {
    let current = ""
    current = appendBounded(current, Buffer.from("abcdef"), 4)
    expect(current).toBe("abcd")
  })

  test("ignores chunks after the budget is exhausted", () => {
    let current = appendBounded("", Buffer.from("1234"), 4)
    current = appendBounded(current, Buffer.from("more"), 4)
    expect(current).toBe("1234")
  })

  test("clips UTF-8 sequences at the budget", () => {
    // "ü" = 0xC3 0xBC; budget 2 keeps the whole character.
    const result = appendBounded("", Buffer.from("üx", "utf8"), 2)
    expect(result).toBe("ü")
  })
})

describe("outputLines", () => {
  test("splits LF and CRLF output and drops empty lines", () => {
    expect(outputLines("a\r\nb\nc\n\nd")).toEqual(["a", "b", "c", "d"])
  })

  test("trims surrounding whitespace", () => {
    expect(outputLines("  x  \n\ty")).toEqual(["x", "y"])
  })

  test("returns an empty list for blank output", () => {
    expect(outputLines("\n\n  \n")).toEqual([])
  })
})