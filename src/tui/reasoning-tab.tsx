import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { ReasoningEntry, TuiState } from "./tui-state.js";

interface ReasoningTabProps {
  state: TuiState;
  maxVisible: number;
}

const LINE_CLIP = 10_000;
/**
 * Cap rendered lines per reasoning entry. An entry can be thousands of
 * chars (some are 5k+), and Ink cannot reliably redraw a frame taller
 * than the terminal \u2014 the "garbled panel" symptom. Slice each
 * entry, keep the head (the plan) and mark the rest.
 */
const MAX_LINES_PER_ENTRY = 12;

/**
 * Collect reasoning text preserved on finalized assistant messages. The live
 * `state.reasoning` buffer is cleared at `assistant_reply` (see
 * agent-event-reducer.ts), but the same text is packed into each message's
 * `reasoningBlocks`. Reading both gives a persistent history.
 */
function collectHistoricalReasoning(state: TuiState): ReasoningEntry[] {
  const out: ReasoningEntry[] = [];
  const messages =
    (state as unknown as {
      messages?: ReadonlyArray<{
        id?: string;
        role?: string;
        timestamp?: number;
        reasoningBlocks?: readonly string[];
      }>;
    }).messages ?? [];
  for (const msg of messages) {
    if (msg.role !== "assistant" || !msg.reasoningBlocks) continue;
    const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
    const baseId = msg.id ?? "msg";
    for (let i = 0; i < msg.reasoningBlocks.length; i++) {
      out.push({
        id: `${baseId}-r${i}`,
        timestamp: ts,
        stepIndex: i,
        text: msg.reasoningBlocks[i]!,
      });
    }
  }
  return out;
}

/**
 * Shows the most recent `<think>` blocks emitted by the model in the current
 * run. Entries are grouped per step. We clip overly long lines to keep the
 * terminal legible — the underlying `ReasoningEntry.text` is preserved in
 * state for exporters / log dumps.
 */
export function ReasoningTab({
  state,
  maxVisible,
}: ReasoningTabProps): ReactElement {
  const visible = [...collectHistoricalReasoning(state), ...state.reasoning].slice(-maxVisible);
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
    >
      <Text color="gray">
        ── reasoning ─────────────────────────────────────
      </Text>
      {visible.length === 0 ? (
        <Text color="gray">
          no reasoning captured yet — run a task to populate this panel
        </Text>
      ) : (
        visible.map((entry) => <ReasoningBlock key={entry.id} entry={entry} />)
      )}
    </Box>
  );
}

function ReasoningBlock({ entry }: { entry: ReasoningEntry }): ReactElement {
  const allLines = entry.text.split(/\r?\n/);
  const hidden = Math.max(0, allLines.length - MAX_LINES_PER_ENTRY);
  const lines = hidden > 0 ? allLines.slice(0, MAX_LINES_PER_ENTRY) : allLines;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="magenta" bold>
        [step {entry.stepIndex}] reasoning
      </Text>
      {lines.map((line, idx) => (
        <Text key={idx} color="gray">
          {clip(line, LINE_CLIP)}
        </Text>
      ))}
      {hidden > 0 ? (
        <Text color="gray" dimColor>
          {"\u2026 [" + hidden + " more lines]"}
        </Text>
      ) : null}
    </Box>
  );
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
