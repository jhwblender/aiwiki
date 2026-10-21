// Runs once when the server starts: resume any background filing left over from last time.
// The check must wrap the import directly so the edge build leaves the Node-only code out.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
