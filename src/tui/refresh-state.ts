export interface LatestRefresh {
  run<Value>(load: () => Promise<Value>, commit: (value: Value) => void): Promise<void>
}

/**
 * Owns one visible refresh lifecycle. Late replies from an older refresh are
 * ignored, and the newest request always leaves loading state in `finally`.
 */
export function createLatestRefresh(setLoading: (loading: boolean) => void): LatestRefresh {
  let generation = 0
  return {
    async run(load, commit) {
      const current = ++generation
      setLoading(true)
      try {
        const value = await load()
        if (current === generation) commit(value)
      } finally {
        if (current === generation) setLoading(false)
      }
    },
  }
}
