/**
 * terminal-text.ts — make untrusted text safe to write to the terminal.
 *
 * Tool results, agent output, gate output and a script's `log()` lines are all
 * text nobody here wrote. Rendered as-is, an escape sequence in them drives the
 * user's terminal: OSC 52 writes the clipboard, `ESC[2J` clears the screen, a
 * bare `\r` overwrites the line it sits on. Pi's own renderers strip them the
 * same way (`render-utils.ts`: `stripAnsi`, then `sanitizeBinaryOutput`, then
 * drop `\r`); that code is not exported to extensions, so this mirrors it.
 *
 * Styling is applied by the renderer AFTER this runs, so nothing legitimate is
 * lost: only the input's own escape sequences go.
 */

/**
 * OSC (`ESC ]` … terminator) and CSI-style sequences, after Pi's `ansiRegex`.
 * The OSC body excludes the terminator's first characters rather than matching
 * lazily, so an unterminated OSC costs one scan to the next ESC, not to the end
 * of the input for every one of them.
 */
const ANSI_SEQUENCE =
  /\u001B\][^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;

/**
 * C0 controls except tab and newline (so `\r` goes too), DEL, C1 controls, and
 * U+FFF9..U+FFFB, which crash string-width. Every escape sequence starts with
 * one of these, which is what makes the fast path below sound.
 */
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uFFF9-\uFFFB]/g;
const HAS_CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\uFFF9-\uFFFB]/;

/** `text` without escape sequences or control characters other than tab and newline. */
export function sanitizeTerminalText(text: string): string {
  if (!HAS_CONTROL.test(text)) return text;
  return text.replace(ANSI_SEQUENCE, "").replace(CONTROL, "");
}
