import type { Rule } from "../guard-types.js";

/**
 * Guard bootstrap prerequisites: the project-workflow guard requires the agent
 * to run these read-only commands before writing source. Auto-allow them so a
 * non-interactive run can satisfy the guard without an approval deadlock.
 * Command-specific — matches only the exact bootstrap tokens, never arbitrary
 * shell.
 */
export const guardBootstrapRule: Rule = {
  id: "guard.bootstrap",
  layer: "trusted",
  match(input) {
    if (
      (input.cmd === "python" || input.cmd === "python3") &&
      input.args[0] === "scripts/atomic_memory.py" &&
      input.args[1] === "search"
    ) {
      return {
        action: "allow",
        rule: "guard.bootstrap.memory_search",
        reason: "guard prerequisite: memory search",
      };
    }
    if (input.cmd === "graft" && input.args[0] === "ask") {
      return {
        action: "allow",
        rule: "guard.bootstrap.graft_ask",
        reason: "guard prerequisite: graft ask",
      };
    }
    return null;
  },
};
