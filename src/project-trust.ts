/**
 * project-trust.ts — Pi's project trust decision, as this extension applies it.
 *
 * Pi 1.x does not load a folder's `.pi` settings, extensions, skills or prompts
 * until the user trusts the folder. Subagents run in sessions this extension
 * builds itself, and this extension reads project files of its own (agents,
 * workflows, skills, `subagents.json`), so both have to follow the decision the
 * parent session made rather than assume trust.
 */

/**
 * Whether the session behind `ctx` trusts its project.
 *
 * A context without `isProjectTrusted` comes from a Pi that predates project
 * trust and loaded every project resource itself, so the child matches it. A
 * context that throws (a session already torn down) is treated as untrusted.
 */
export function isProjectTrustedBy(ctx: { isProjectTrusted?: () => boolean } | undefined): boolean {
  if (typeof ctx?.isProjectTrusted !== "function") return true;
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
}
