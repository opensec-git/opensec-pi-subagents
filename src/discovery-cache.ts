import { statSync } from "node:fs";
import { resolve } from "node:path";

/** Metadata includes replacement, same-size edits, and permission changes. */
function fingerprint(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
}

/**
 * Cache successful file parsing or directory listings, not live session state.
 * Validate on every access (no TTL/watchers); never reuse failures. Values stay
 * private to the caller, which must not expose mutable cached objects.
 */
export function createDiscoveryCache<T>(read: (path: string) => T, capacity = 256): (path: string) => T {
  const entries = new Map<string, { fingerprint: string; value: T }>();
  return (path) => {
    const key = resolve(path);
    try {
      const before = fingerprint(key);
      const cached = entries.get(key);
      entries.delete(key);
      if (cached?.fingerprint === before) {
        entries.set(key, cached);
        return cached.value;
      }
      const value = read(key);
      // An edit racing the read must not label old content with new metadata.
      if (before === fingerprint(key)) {
        entries.set(key, { fingerprint: before, value });
        if (entries.size > capacity) {
          const oldest = entries.keys().next().value;
          if (oldest !== undefined) entries.delete(oldest);
        }
      }
      return value;
    } catch (error) {
      entries.delete(key);
      throw error;
    }
  };
}
