// Counts the session_shutdown events its sessions receive, on globalThis, so a
// test can see when (and how often) a child session is shut down.
export default function (pi) {
  pi.on("session_shutdown", () => {
    globalThis.__extShutdownProbe = (globalThis.__extShutdownProbe ?? 0) + 1;
  });
}
