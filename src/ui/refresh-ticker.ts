/**
 * refresh-ticker.ts — one timer for every surface that redraws on a clock.
 *
 * The widget's spinner wants 80 ms, the fleet list's whole-second clocks want
 * 1 s, and each foreground agent's inline spinner wants 80 ms. With a timer
 * each, their ticks land at unrelated moments and every one is a full TUI
 * frame. Sharing one timer puts all callbacks that are due on the same tick,
 * where pi coalesces their `requestRender()` calls into a single frame.
 *
 * The timer runs at the shortest period anyone asked for and stops when the
 * last subscriber leaves.
 */

type Subscription = { period: number; last: number; fn: () => void };

export class RefreshTicker {
  private readonly subs = new Map<object, Subscription>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private timerPeriod = 0;

  /** Call `fn` every `periodMs` (on the shared tick) until `delete(owner)`. Re-setting keeps the phase. */
  set(owner: object, periodMs: number, fn: () => void): void {
    const existing = this.subs.get(owner);
    if (existing) {
      existing.fn = fn;
      if (existing.period === periodMs) return;
      existing.period = periodMs;
    } else {
      this.subs.set(owner, { period: periodMs, last: Date.now(), fn });
    }
    this.reschedule();
  }

  delete(owner: object): void {
    if (this.subs.delete(owner)) this.reschedule();
  }

  has(owner: object): boolean {
    return this.subs.has(owner);
  }

  /** Stop everything (extension shutdown). */
  clear(): void {
    this.subs.clear();
    this.reschedule();
  }

  private reschedule(): void {
    let period = 0;
    for (const sub of this.subs.values()) period = period === 0 ? sub.period : Math.min(period, sub.period);
    if (period === this.timerPeriod) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.timerPeriod = period;
    if (period > 0) this.timer = setInterval(() => this.tick(), period);
  }

  private tick(): void {
    const now = Date.now();
    for (const [owner, sub] of [...this.subs]) {
      if (this.subs.get(owner) !== sub) continue; // removed by an earlier callback this tick
      // Half a base period of slack: a 1 s subscriber on an 80 ms base fires on
      // the tick nearest its period instead of a whole tick late.
      if (now - sub.last + this.timerPeriod / 2 < sub.period) continue;
      sub.last = now;
      sub.fn();
    }
  }
}
