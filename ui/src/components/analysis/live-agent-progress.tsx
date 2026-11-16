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
 */
import { useEffect, useState } from "react";
import type { AnalysisLiveAgent } from "@metis/shared";
import { codeReadingProgress, liveAgentLine } from "./analysis-views";

interface Props {
  live: AnalysisLiveAgent;
  /** The server's clock minus this browser's, in ms (`serverClockOffsetMs`). */
  clockOffsetMs: number;
  testId: string;
  className?: string;
}

export function LiveAgentProgress({
  live,
  clockOffsetMs,
  testId,
  className = "mt-2 text-xs text-muted-foreground",
}: Props): React.ReactElement {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);
  const serverNow = now + clockOffsetMs;
  const reading = codeReadingProgress(live, serverNow);
  if (!reading) {
    return (
      <p className={className} role="status" data-testid={testId}>
        {liveAgentLine(live, serverNow)}
      </p>
    );
  }
  return (
    <div className={className}>
      <p role="status" data-testid={testId}>
        {reading.line}
      </p>
      {reading.note ? (
        <p className="mt-0.5" data-testid={`${testId}-note`}>
          {reading.note}
        </p>
      ) : null}
    </div>
  );
}
