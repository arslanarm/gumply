/**
 * Version history (spec/mcp §4, D35): MCP saves the version it replaces before
 * every write. The store is the app's own (spec/version-history, D41), shared
 * with the server so both processes write one history with the same rules.
 */
export * from "../../server/src/history.js";
