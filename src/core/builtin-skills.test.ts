import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BUILTIN_SKILL_IDS, BUILTIN_SKILL_MARKER, installBuiltinSkills, planBuiltinSkills, validateBuiltinSkill } from "./builtin-skills"
import { withExclusiveFileLock } from "../shared/file-lock"

const roots: string[] = []
const packageRoot = process.cwd()
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gvozd-skills-")))
  roots.push(root)
  return { root, destination: join(root, "opencode", "skills") }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("managed built-in skills", () => {
  test("portable discovery content and pure preview, owner-only install, idempotence and managed updates", () => {
    const { root, destination } = fixture()
    const preview = installBuiltinSkills(packageRoot, destination, { check: true })
    expect(preview.created).toHaveLength(3)
    expect(existsSync(join(root, "opencode"))).toBe(false)
    for (const [index, id] of BUILTIN_SKILL_IDS.entries()) {
      validateBuiltinSkill(id, preview.writes[index]!.content)
      expect(preview.writes[index]!.target).toBe(join(destination, id, "SKILL.md"))
    }
    installBuiltinSkills(packageRoot, destination, { expected: preview })
    expect(installBuiltinSkills(packageRoot, destination).unchanged).toHaveLength(3)
    const target = join(destination, "forge-workflow", "SKILL.md")
    expect(statSync(target).mode & 0o777).toBe(0o600)
    writeFileSync(target, `${readFileSync(target, "utf8")}stale\n`)
    expect(planBuiltinSkills(packageRoot, destination).updated).toEqual([target])
    installBuiltinSkills(packageRoot, destination)
    expect(readFileSync(target, "utf8")).not.toEndWith("stale\n")
    expect(existsSync(join(root, "opencode", ".agent-gvozd-skills.lock"))).toBe(false)
  })

  test("unmanaged collisions and flat aliases block all skill writes", () => {
    const { destination } = fixture()
    mkdirSync(join(destination, "runner-workflow"), { recursive: true })
    const target = join(destination, "runner-workflow", "SKILL.md")
    writeFileSync(target, "user-owned\n")
    expect(() => installBuiltinSkills(packageRoot, destination)).toThrow("Unmanaged skill conflict")
    expect(existsSync(join(destination, "forge-workflow"))).toBe(false)
    expect(readFileSync(target, "utf8")).toBe("user-owned\n")
    rmSync(join(destination, "runner-workflow"), { recursive: true })
    writeFileSync(join(destination, "ci-workflow.md"), "user-owned\n")
    expect(() => planBuiltinSkills(packageRoot, destination)).toThrow("Unmanaged skill conflict")
  })

  test("rejects symlinked components, non-files and unsafe permissions without following them", () => {
    const { root, destination } = fixture()
    mkdirSync(join(root, "outside"))
    symlinkSync(join(root, "outside"), join(root, "opencode"))
    expect(() => planBuiltinSkills(packageRoot, destination)).toThrow("symbolic-link")
    rmSync(join(root, "opencode"))
    mkdirSync(join(destination, "forge-workflow", "SKILL.md"), { recursive: true })
    expect(() => planBuiltinSkills(packageRoot, destination)).toThrow("Unsafe managed skill")
    rmSync(join(destination, "forge-workflow"), { recursive: true })
    chmodSync(destination, 0o777)
    expect(() => planBuiltinSkills(packageRoot, destination)).toThrow("group/world-writable")
    chmodSync(destination, 0o700)
    expect(existsSync(join(root, "outside", "skills"))).toBe(false)
  })

  test("snapshot mismatch and held installation lock stop writes", async () => {
    const { root, destination } = fixture()
    const preview = planBuiltinSkills(packageRoot, destination)
    installBuiltinSkills(packageRoot, destination)
    expect(() => installBuiltinSkills(packageRoot, destination, { expected: preview })).toThrow("changed since preview")
    const target = join(destination, "ci-workflow", "SKILL.md")
    const stale = `${readFileSync(target, "utf8")}stale\n`
    writeFileSync(target, stale)
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const owner = withExclusiveFileLock(join(root, "opencode", ".agent-gvozd-skills.lock"), async () => waiting)
    await Promise.resolve()
    expect(() => installBuiltinSkills(packageRoot, destination)).toThrow("Another Gvozd")
    expect(readFileSync(target, "utf8")).toBe(stale)
    release()
    await owner
  })

  test("malformed frontmatter cannot ship as advertised guidance", () => {
    expect(() => validateBuiltinSkill("ci-workflow", `---\nname: other\ndescription: CI\n---\n${BUILTIN_SKILL_MARKER}\n`)).toThrow("Invalid packaged skill")
    expect(() => validateBuiltinSkill("ci-workflow", `---\nname: ci-workflow\n---\n${BUILTIN_SKILL_MARKER}\n`)).toThrow("Invalid packaged skill")
  })
})
