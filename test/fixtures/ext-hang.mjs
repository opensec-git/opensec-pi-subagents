// A tool that never settles and ignores its AbortSignal — stands in for any
// extension or MCP tool that does not wire `signal`. Counts its starts on
// globalThis so a test can wait for the child to be inside it.
import { Type } from "@sinclair/typebox";
export default function (pi) {
  pi.registerTool({
    name: "hang",
    label: "Hang",
    description: "Never returns.",
    parameters: Type.Object({}),
    async execute() {
      globalThis.__extHangStarted = (globalThis.__extHangStarted ?? 0) + 1;
      return new Promise(() => {});
    },
  });
}
