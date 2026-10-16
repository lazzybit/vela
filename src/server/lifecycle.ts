type Cleanup = () => void | Promise<void>;

const cleanups: Cleanup[] = [];
let installed = false;

/**
 * Process lifecycle. Vela keep browsers alive across MCP transports, so they
 * are closed when the process is asked to stop, not when a connection drops.
 */
export function onShutdown(cleanup: Cleanup): void {
  cleanups.push(cleanup);
  install();
}

function install(): void {
  if (installed) return;
  installed = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown();
    });
  }
}

async function shutdown(): Promise<void> {
  for (const cleanup of [...cleanups].reverse()) {
    try {
      await cleanup();
    } catch (error) {
      console.error("vela: shutdown cleanup failed", error);
    }
  }
}
