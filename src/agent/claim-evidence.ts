import type { ConversationTurn } from "../session/conversation-turn.js";

/**
 * Claims need evidence.
 *
 * A final `reply` that says a check ran — "ran node --check on all
 * files (all passed)", "tests pass", "verified" — is read by the
 * operator as a fact about this turn. Three runs showed it was not:
 * one reply reported every JavaScript file checked after a one-file
 * `node --check`, another "Syntax: all passed" from the same command,
 * and a 12B model claimed `node --check` passed with no shell call at
 * all. Nothing compared the claim with the turn's tool calls.
 *
 * This does. A claim is matched against the turn's calls: a shell
 * command that contains the claimed check, or any `verify.*` call,
 * counts as evidence. A claim with none earns one `### notice` and one
 * more step — the same shape as the invented-transcript rejection: the
 * reply is not delivered, the model is told why, and the exit is named
 * (run the check, or drop the claim). Once per turn: a second reply
 * that still claims is delivered, and the trace marks it.
 *
 * It is a heuristic and is held to warn-once. The patterns are the
 * ones the failing replies used; a reply that mentions tests the
 * operator ran gets a needless notice at worst, never a blocked turn.
 */

export type CheckClaimKind = "node-check" | "tests" | "verified" | "lint" | "build";

export interface CheckClaim {
  kind: CheckClaimKind;
  /** The words in the reply that made the claim, as written. */
  text: string;
}

/** A tool call made this turn, as much of it as the evidence check reads. */
export interface TurnToolCall {
  tool: string;
  args: Record<string, unknown>;
  /**
   * The call's own result was elided before the model saw it. A truncated
   * result cannot stand as evidence: the model quoted, checked or summarised
   * a fraction of the output and cannot know what the rest said.
   */
  truncated?: boolean;
  /** Exit code of a shell call's result, when the transcript carried it. */
  exitCode?: number;
  /** Blob hash of a truncated result, so the full body can be re-read. */
  blob?: string;
}

const CLAIM_PATTERNS: ReadonlyArray<{ kind: CheckClaimKind; re: RegExp }> = [
  { kind: "node-check", re: /node\s+--check/i },
  { kind: "tests", re: /\btests?\s+(?:pass|passed)\b/i },
  { kind: "tests", re: /\bran\s+(?:the\s+)?tests\b/i },
  { kind: "verified", re: /\bverified\b/i },
  { kind: "lint", re: /\blint(?:ed)?\s+passes\b/i },
  { kind: "build", re: /\bbuilds?\s+(?:cleanly|passes)\b/i },
];

/**
 * What a shell command must contain to stand as evidence for a claim.
 * `verified` names no particular command, so any command the turn ran
 * is taken as the thing that was verified.
 */
const EVIDENCE: Readonly<Record<CheckClaimKind, RegExp>> = {
  "node-check": /\bnode(?:\.exe)?\s+(?:[^\s]+\s+)*?(?:--check|-c)\b/i,
  tests: /\b(?:tests?|vitest|jest|mocha|pytest|unittest|spec|cargo\s+test|go\s+test)\b/i,
  verified: /\S/,
  lint: /\b(?:lint|eslint|ruff|flake8|pylint|clippy|golangci-lint|biome)\b/i,
  build: /\b(?:build|tsc|make|cargo\s+build|go\s+build|webpack|vite|esbuild|compile|gradle|mvn)\b/i,
};

/** The claims a reply makes, one per kind, in order of appearance. */
export function detectCheckClaims(replyText: string): CheckClaim[] {
  const found = new Map<CheckClaimKind, { claim: CheckClaim; at: number }>();
  for (const { kind, re } of CLAIM_PATTERNS) {
    const match = re.exec(replyText);
    if (match === null) continue;
    const existing = found.get(kind);
    if (existing === undefined || match.index < existing.at) {
      found.set(kind, { claim: { kind, text: match[0] }, at: match.index });
    }
  }
  return [...found.values()]
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.claim);
}

/** The command line an `os.shell.run` call would run, or `null`. */
function shellCommandLine(call: TurnToolCall): string | null {
  if (call.tool !== "os.shell.run") return null;
  const cmd = typeof call.args.cmd === "string" ? call.args.cmd : "";
  const args = Array.isArray(call.args.args)
    ? call.args.args.filter((a): a is string => typeof a === "string")
    : [];
  const line = [cmd, ...args].join(" ").trim();
  return line.length > 0 ? line : null;
}

/** Whether `calls` hold a check that stands for `claim`. */
export function claimHasEvidence(
  claim: CheckClaim,
  calls: readonly TurnToolCall[],
): boolean {
  return hasEvidence(claim, calls, { includeTruncated: false });
}

/**
 * The same check, but counting elided calls. Used only to tell "nothing ran"
 * apart from "it ran and the output was cut" — never to accept a claim.
 */
function claimHasEvidenceIncludingTruncated(
  claim: CheckClaim,
  calls: readonly TurnToolCall[],
): boolean {
  return hasEvidence(claim, calls, { includeTruncated: true });
}

function hasEvidence(
  claim: CheckClaim,
  calls: readonly TurnToolCall[],
  options: { includeTruncated: boolean },
): boolean {
  for (const call of calls) {
    // A truncated result cannot stand as evidence: the model saw a fraction of
    // the output, so "tests pass" from an elided run is a guess with a receipt.
    if (call.truncated === true && !options.includeTruncated) continue;
    if (call.tool.startsWith("verify.")) return true;
    const line = shellCommandLine(call);
    if (line !== null && EVIDENCE[claim.kind].test(line)) return true;
  }
  return false;
}

/** The claims in `replyText` that nothing in `calls` backs. */
export function unverifiedClaims(
  replyText: string,
  calls: readonly TurnToolCall[],
): CheckClaim[] {
  return detectCheckClaims(replyText).filter(
    (claim) => !claimHasEvidence(claim, calls),
  );
}

/**
 * Claims that only pass because of a truncated call.
 *
 * `unverifiedClaims` already refuses them, but "no evidence" is the wrong thing
 * to tell the model: the check did run, it was just elided before it was read.
 * These earn a different notice — re-read/re-run so the whole output is seen.
 */
export function truncatedEvidenceClaims(
  replyText: string,
  calls: readonly TurnToolCall[],
): CheckClaim[] {
  if (!calls.some((call) => call.truncated === true)) return [];
  const complete = calls.filter((call) => call.truncated !== true);
  return detectCheckClaims(replyText).filter(
    (claim) =>
      claimHasEvidenceIncludingTruncated(claim, calls) &&
      !claimHasEvidence(claim, complete),
  );
}

/** Notice for a claim whose only evidence arrived elided. */
export function formatTruncatedEvidenceNotice(
  claims: readonly CheckClaim[],
): string {
  return `Your reply claims ${quoteClaims(claims)} and the only matching output this turn was truncated before you read it. Re-run the check with a narrower scope (or read the file in ranges) so the evidence is complete, then reply again.`;
}

/**
 * The tool calls of the turn now running: everything after the last
 * `user` turn in the transcript. A turn's own batch (the calls emitted
 * alongside the reply) is appended by the caller — they run before the
 * reply under the tail-terminal barrier, so they count.
 */
export function turnToolCalls(
  turns: readonly ConversationTurn[],
): TurnToolCall[] {
  let start = 0;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.kind === "user") {
      start = i + 1;
      break;
    }
  }
  const calls: TurnToolCall[] = [];
  // Calls are matched to their results in order, by tool name: the transcript
  // writes assistant_tool_call → tool_result per call, and a truncated result
  // tags the call it belongs to.
  const pending: TurnToolCall[] = [];
  for (const turn of turns.slice(start)) {
    if (turn.kind === "assistant_tool_call") {
      const call: TurnToolCall = { tool: turn.tool, args: turn.args };
      calls.push(call);
      pending.push(call);
    } else if (turn.kind === "tool_result") {
      const idx = pending.findIndex((call) => call.tool === turn.tool);
      if (idx === -1) continue;
      if (turn.truncated === true) pending[idx]!.truncated = true;
      if (turn.blob !== undefined) pending[idx]!.blob = turn.blob;
      // Shell results render their exit code in the summary ("exit: 0"); keep
      // it so the refusal can say *why* a check that ran did not back the claim.
      const exit = /exit:\s*(-?\d+)/i.exec(turn.summary);
      if (exit !== null) pending[idx]!.exitCode = Number(exit[1]);
      pending.splice(idx, 1);
    }
  }
  return calls;
}

function quoteClaims(claims: readonly CheckClaim[]): string {
  return claims.map((claim) => `"${claim.text}"`).join(", ");
}

/** One line naming a call and its outcome, so the model can see what ran. */
function describeRanCall(call: TurnToolCall): string {
  if (call.truncated === true) {
    const prefix = call.blob !== undefined ? call.blob.slice(0, 8) : "";
    return `${call.tool} truncated — body retrievable via tool.recall ${prefix}`;
  }
  if (call.exitCode !== undefined) {
    return `${call.tool} exit: ${call.exitCode}`;
  }
  return `${call.tool} ok`;
}

/**
 * The next-step notice. Names the claim as written, names both exits (the two
 * tools that produce evidence, and dropping the claim) — and, when the caller
 * passes the calls that actually ran this turn, names them too so the model
 * can see which check already happened and why it did not satisfy the claim.
 * With no `ran` list the wording is unchanged from the original.
 */
export function formatUnverifiedClaimNotice(
  claims: readonly CheckClaim[],
  ran?: readonly TurnToolCall[],
): string {
  if (ran === undefined || ran.length === 0) {
    return `Your reply claims ${quoteClaims(claims)} but no such check ran this turn. Run it (\`verify.run\`, \`os.shell.run\`) or remove the claim, then reply again.`;
  }
  const list = ran.map(describeRanCall).join(", ");
  return `Your reply claims ${quoteClaims(claims)} but no matching check ran this turn — what ran: ${list}. Run the check or remove the claim, then reply again.`;
}

/** The tool result that stands in for the reply that was not delivered. */
export function formatUnverifiedClaimRefusal(
  claims: readonly CheckClaim[],
  ran?: readonly TurnToolCall[],
): string {
  if (ran === undefined || ran.length === 0) {
    return `not delivered: the reply claims ${quoteClaims(claims)} but no matching check ran this turn. Run the check (\`verify.run\`, \`os.shell.run\`) or remove the claim, then reply again.`;
  }
  const list = ran.map(describeRanCall).join(", ");
  return `not delivered: the reply claims ${quoteClaims(claims)} but no matching check ran this turn — what ran: ${list}. Run the check or remove the claim, then reply again.`;
}
