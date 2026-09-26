export const PACKAGE_NAME = "@nail00749/agent-gvozd"
export const PACKAGE_VERSION = "0.7.0"
export const PACKAGE_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`
/**
 * Supported OpenCode release range. "2.0.*" accepts any 2.0.x patch while
 * rejecting adjacent minor versions that may change plugin or TUI contracts.
 *
 * Within this range the plugin API is not uniform: 2.0.2–2.0.3 expose
 * `ctx.catalog.model` and emit `catalog.updated`, while 2.0.4+ expose the flat
 * `ctx.model` / `ctx.provider` domains and emit `model.updated` /
 * `provider.updated`. The runtime detects the available surface instead of
 * pinning an exact patch; see `src/core/version.ts` and `src/plugin/index.ts`.
 */
export const SUPPORTED_OPENCODE_VERSION = "2.0.*"
export const CONFIG_SCHEMA_VERSION = 3
export const MINIMUM_NODE_VERSION = "22.0.0"
