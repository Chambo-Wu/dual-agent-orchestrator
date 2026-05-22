type ActiveJobSession = {
  jobId: string;
  goal: string;
  startedAt: string;
  controller: AbortController;
};

const activeSessions = new Map<string, ActiveJobSession>();

export function registerActiveJobSession(jobId: string, goal: string, controller: AbortController): ActiveJobSession {
  const session: ActiveJobSession = {
    jobId,
    goal,
    startedAt: new Date().toISOString(),
    controller,
  };
  activeSessions.set(jobId, session);
  return session;
}

export function getActiveJobSession(jobId: string): ActiveJobSession | undefined {
  return activeSessions.get(jobId);
}

export function cancelActiveJobSession(jobId: string, reason = "Run cancelled by API."): boolean {
  const session = activeSessions.get(jobId);
  if (!session) return false;
  if (!session.controller.signal.aborted) {
    session.controller.abort(new Error(reason));
  }
  return true;
}

export function unregisterActiveJobSession(jobId: string): void {
  activeSessions.delete(jobId);
}
