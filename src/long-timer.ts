/**
 * long-timer.ts — setTimeout for delays longer than a timer can hold.
 *
 * Runtimes store timer delays as a signed 32-bit millisecond count: anything
 * above 2^31-1 ms (~24.8 days) is clamped to 1 ms, so a "30d" interval would
 * fire every millisecond. `setLongTimeout` chains timers of at most
 * MAX_TIMER_CHUNK_MS and only fires once the wall-clock target is reached.
 */

/** Longest single timer this module arms: 24 days, below the 2^31-1 ms limit. */
export const MAX_TIMER_CHUNK_MS = 24 * 86_400_000;

export interface LongTimer {
  cancel(): void;
}

/** Run `fn` once after `delayMs` (any finite non-negative delay). */
export function setLongTimeout(fn: () => void, delayMs: number): LongTimer {
  if (!Number.isFinite(delayMs)) throw new RangeError(`Invalid timer delay: ${delayMs}`);
  const target = Date.now() + Math.max(0, delayMs);
  let handle: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const arm = () => {
    if (cancelled) return;
    const remaining = target - Date.now();
    if (remaining > MAX_TIMER_CHUNK_MS) {
      handle = setTimeout(arm, MAX_TIMER_CHUNK_MS);
      return;
    }
    handle = setTimeout(() => {
      handle = undefined;
      if (!cancelled) fn();
    }, Math.max(0, remaining));
  };
  arm();
  return {
    cancel() {
      cancelled = true;
      if (handle !== undefined) clearTimeout(handle);
      handle = undefined;
    },
  };
}
