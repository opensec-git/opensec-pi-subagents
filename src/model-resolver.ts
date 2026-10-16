/**
 * Model resolution: exact match ("provider/modelId") with fuzzy fallback.
 */

export interface ModelEntry {
  id: string;
  name: string;
  provider: string;
}

export interface ModelRegistry {
  find(provider: string, modelId: string): any;
  getAll(): any[];
  getAvailable?(): any[];
}

/**
 * Both display forms of a model. The short one goes on tight rows (the widget,
 * the Agent tool result), the canonical one where there is room to disambiguate
 * two providers serving a similarly-named model (the conversation viewer).
 *
 * One function, because `index.ts` labels the model it resolved before the run
 * and `agent-manager.ts` relabels it from the live session afterwards — the two
 * must agree or the label would visibly change the moment the session starts.
 */
export function describeModel(
  model: { provider: string; id: string; name?: string },
): { modelName: string; modelId: string } {
  return {
    modelName: (model.name ?? model.id).replace(/^Claude\s+/i, "").toLowerCase(),
    modelId: `${model.provider}/${model.id}`,
  };
}

/** At most this many candidates are named when a model name is ambiguous. */
const MAX_CANDIDATES = 5;

/** Why a model name did not resolve, with what it came closest to. */
export interface ModelResolutionFailure {
  ok: false;
  reason: "not-found" | "ambiguous";
  /** `provider/id` of the closest matches, best first (at most five); empty when nothing matched. */
  candidates: string[];
  /** The error to show a caller that asked for this model. */
  message: string;
}

export type ModelResolution = { ok: true; model: any } | ModelResolutionFailure;

/**
 * Resolve a model string to a Model instance, or say why it does not resolve.
 *
 * An exact "provider/modelId" (case-insensitive) always resolves. Anything else
 * is matched fuzzily against the available models in tiers — exact id, id
 * substring, name substring, all words present — and resolves only when the
 * best tier settles on one provider. Within that tier the parent's provider
 * (`preferProvider`) wins when it is among the matches; if the remaining
 * matches all share one provider, the tightest match is taken (ties broken by
 * id), so a Claude Code-style "haiku" or "sonnet" keeps working. Only matches
 * that still span several providers are refused, with the closest candidates:
 * a silent pick across providers (another vendor's model under a similar name)
 * is worse than an error the caller can act on.
 */
export function resolveModelDetailed(input: string, registry: ModelRegistry, preferProvider?: string): ModelResolution {
  // Available models (those with auth configured)
  const all = (registry.getAvailable?.() ?? registry.getAll()) as ModelEntry[];

  // 1. Exact match: "provider/modelId" — only if available (has auth)
  const slashIdx = input.indexOf("/");
  if (slashIdx !== -1) {
    const exact = all.find(m => `${m.provider}/${m.id}`.toLowerCase() === input.toLowerCase());
    if (exact) {
      const found = registry.find(exact.provider, exact.id);
      if (found) return { ok: true, model: found };
    }
  }

  // 2. Fuzzy match against available models. Normalize separators so cosmetic
  // punctuation differences still match — e.g. "claude-haiku-4.5" and
  // "claude-haiku-4-5" (dot vs dash in the version) resolve to the same model.
  const normalize = (s: string) => s.toLowerCase().replace(/\./g, "-");
  const query = normalize(input);

  // Score each model: exact id > id contains > name contains > all parts present.
  // The tier decides ambiguity; the score within it only orders the candidates.
  const matches: { model: ModelEntry; tier: number; score: number }[] = [];
  for (const m of all) {
    const id = normalize(m.id);
    const name = normalize(m.name);
    const full = normalize(`${m.provider}/${m.id}`);

    if (id === query || full === query) {
      matches.push({ model: m, tier: 3, score: 100 });
    } else if (id.includes(query) || full.includes(query)) {
      matches.push({ model: m, tier: 2, score: 60 + (query.length / id.length) * 30 }); // prefer tighter matches
    } else if (name.includes(query)) {
      matches.push({ model: m, tier: 1, score: 40 + (query.length / name.length) * 20 });
    } else if (
      // A trailing date-stamp token (e.g. "20251001") is optional, so a
      // date-pinned config like "claude-haiku-4-5-20251001" still matches an
      // undated registry id like "claude-haiku-4-5".
      query
        .split(/[\s\-/]+/)
        .every(part => /^\d{8}$/.test(part) || id.includes(part) || name.includes(part) || m.provider.toLowerCase().includes(part))
    ) {
      matches.push({ model: m, tier: 0, score: 20 }); // all parts present somewhere
    }
  }

  if (matches.length > 0) {
    const bestTier = Math.max(...matches.map(match => match.tier));
    // Tightest first; equal scores in id order, so the pick never depends on registry order.
    let best = matches
      .filter(match => match.tier === bestTier)
      .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));
    const preferred = preferProvider?.toLowerCase();
    const fromParent = best.filter(match => match.model.provider.toLowerCase() === preferred);
    if (fromParent.length > 0) best = fromParent;
    if (new Set(best.map(match => match.model.provider.toLowerCase())).size === 1) {
      const found = registry.find(best[0].model.provider, best[0].model.id);
      if (found) return { ok: true, model: found };
    } else {
      const candidates = best.slice(0, MAX_CANDIDATES).map(match => `${match.model.provider}/${match.model.id}`);
      const more = best.length > candidates.length ? ` (and ${best.length - candidates.length} more)` : "";
      return {
        ok: false,
        reason: "ambiguous",
        candidates,
        message: `Model "${input}" is ambiguous: it matches ${best.length} available models, closest first: `
          + `${candidates.join(", ")}${more}. Name one of them as provider/id.`,
      };
    }
  }

  // 3. Provider fallback: a "provider/modelId" query that didn't match under the
  // named provider (exact or fuzzy above) retries against all providers. The
  // named provider is preferred when present; this only kicks in when it isn't,
  // so the same model from another provider beats falling back to "inherit".
  // An ambiguous bare name is reported as such, not as "not found".
  if (slashIdx !== -1 && matches.length === 0) {
    const bare = resolveModelDetailed(input.slice(slashIdx + 1), registry, preferProvider);
    if (bare.ok || bare.reason === "ambiguous") return bare;
  }

  // 4. No match — list available models
  const modelList = all
    .map(m => `  ${m.provider}/${m.id}`)
    .sort()
    .join("\n");
  return {
    ok: false,
    reason: "not-found",
    candidates: [],
    message: `Model not found: "${input}".\n\nAvailable models:\n${modelList}`,
  };
}

/**
 * Resolve a model string to a Model instance.
 * Returns the Model on success, or an error message string on failure — not
 * found, or ambiguous (see {@link resolveModelDetailed}, which also explains
 * `preferProvider`, the parent's provider).
 */
export function resolveModel(
  input: string,
  registry: ModelRegistry,
  preferProvider?: string,
): any | string {
  const resolution = resolveModelDetailed(input, registry, preferProvider);
  return resolution.ok ? resolution.model : resolution.message;
}

/** Why a model name did not resolve, as the clause a note or warning uses. */
export function unresolvedReason(failure: Pick<ModelResolutionFailure, "reason" | "candidates">): string {
  return failure.reason === "ambiguous"
    ? `is ambiguous (candidates: ${failure.candidates.join(", ")})`
    : "was not found among the available models";
}

/**
 * The visible note for a run that kept going on another model because the
 * model it was configured with did not resolve: what was asked for, why it was
 * not used (`why`, e.g. {@link unresolvedReason}), and what ran instead.
 */
export function unresolvedModelNote(
  input: string,
  why: string,
  ranOn: { provider: string; id: string } | string | undefined,
  source = "the agent file",
): string {
  const used = typeof ranOn === "string" ? ranOn : ranOn ? `${ranOn.provider}/${ranOn.id}` : "the default model";
  return `Note: model "${input}" from ${source} ${why}; ran on ${used} instead.`;
}
