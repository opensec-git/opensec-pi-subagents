/**
 * viewer-keys.ts — Scroll key matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` through the user's keybindings when pi provides a
 * manager, falling back to the previous hardcoded keys otherwise. The viewer's
 * k/j and shift+arrow aliases always work alongside whatever is bound.
 *
 * The tool-output toggle resolves Pi's own `app.tools.expand` (ctrl+o by
 * default), so a rebinding in Pi's keybindings file applies in the viewer too.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** The `tui.select.*` keybinding ids the viewer resolves. */
export type ViewerScrollKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "app.tools.expand";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerScrollKeybinding): boolean;
  /** Keys bound to `keybinding`, for the footer hint. Pi's manager has it. */
  getKeys?(keybinding: ViewerScrollKeybinding): readonly string[];
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  /** Expand or collapse tool output, as Pi's `app.tools.expand`. */
  toggleExpand(data: string): boolean;
  /** The first key bound to `toggleExpand`, as a footer label ("" when unbound). */
  readonly expandLabel: string;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerScrollKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    toggleExpand: (data) => matches(data, "app.tools.expand", "ctrl+o"),
    expandLabel: keybindings?.getKeys ? (keybindings.getKeys("app.tools.expand")[0] ?? "") : "ctrl+o",
  };
}
