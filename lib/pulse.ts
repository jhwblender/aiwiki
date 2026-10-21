// A counter that moves whenever pages or suggestions change, so open pages know to refresh.
// It lives in memory; the start time makes it change after a restart too.

const g = globalThis as unknown as { __wikiPulse?: { started: number; count: number } };
const pulse = (g.__wikiPulse ??= { started: Date.now(), count: 0 });

export function changed() {
  pulse.count++;
}

export function stamp(): string {
  return `${pulse.started}-${pulse.count}`;
}
