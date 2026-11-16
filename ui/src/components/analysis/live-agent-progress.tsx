"use client";

/**
 * Issue #2571 — what a running agent is doing, in plain words, on the agent's
 * card and in the change request header.
 *
 * While METIS reads the code it shows #2570's counts: "Reading the code: 14
 * files read, 9 searches, 1 min 10 s so far.", and in explore mode a line on
 * why it takes longer. Any other agent, a re-summary, or an entry from a server
 * without the counts keeps #766's line.
 *
 * Elapsed time counts up once a second on the SERVER's clock: the agent's
 * `startedAt` against `Date.now() + clockOffsetMs`, where the offset comes from
 * the snapshot's `liveAgentsReadAt` ({@link serverClockOffsetMs}).
 *
 * Only the part a poll changes sits in the `role="status"` live region; the
 * time that ticks every second sits beside it, so a screen reader is not told
 * the time once a second. With `announce={false}` (the header, which repeats
 * the card) there is no live region at all, so the change is announced once.
 */
import { useEffect, useState } from "react";
import type { AnalysisLiveAgent } from "@metis/shared";
import { codeReadingProgress, liveAgentLineParts } from "./analysis-views";

interface Props {
  live: AnalysisLiveAgent;
  /** The server's clock minus this browser's, in ms (`serverClockOffsetMs`). */
  clockOffsetMs: number;
  testId: string;
  className?: string;
  /** Whether the counts are a polite live region; `false` where another copy already is. */
  announce?: boolean;
}

export function LiveAgentProgress({
  live,
  clockOffsetMs,
  testId,
  className = "mt-2 text-xs text-muted-foreground",
  announce = true,
}: Props): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const serverNow = now + clockOffsetMs;
  const reading = codeReadingProgress(live, serverNow);
  const { status, elapsed } = reading
    ? { status: reading.counts, elapsed: reading.elapsed }
    : liveAgentLineParts(live, serverNow);
  const line = (
    <p className={reading ? undefined : className} data-testid={testId}>
      <span role={announce ? "status" : undefined} data-testid={`${testId}-status`}>
        {status}
      </span>
      <span data-testid={`${testId}-elapsed`}>{elapsed}</span>
    </p>
  );
  if (!reading) return line;
  return (
    <div className={className}>
      {line}
      {reading.note ? (
        <p className="mt-0.5" data-testid={`${testId}-note`}>
          {reading.note}
        </p>
      ) : null}
    </div>
  );
}
