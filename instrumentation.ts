// Runs once when the server starts: resume background filing and start watching folders.
// The check must wrap the import directly so the edge build leaves the Node-only code out.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
