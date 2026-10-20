// Review and custom agent actions share the same wait/output lifecycle.

export const AGENT_WAIT_TIMEOUT_MS = 30 * 60_000;

export interface AgentThreadAdapter {
  spawn(): Promise<{ id: string }>;
  wait(input: { threadId: string; status: "idle"; timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  output(input: { threadId: string }): Promise<{ output: string | null }>;
  stop(input: { threadId: string }): Promise<unknown>;
}

export const EMPTY_AGENT_OUTPUT = "Agent completed without text output";

export async function runAgentThread(
  adapter: AgentThreadAdapter,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ threadId: string; output: string }> {
  const thread = await adapter.spawn();
  try {
    await adapter.wait({
      threadId: thread.id,
      status: "idle",
      timeoutMs: options.timeoutMs ?? AGENT_WAIT_TIMEOUT_MS,
      signal: options.signal,
    });
    const { output } = await adapter.output({ threadId: thread.id });
    return {
      threadId: thread.id,
      output: typeof output === "string" && output.trim().length > 0 ? output : EMPTY_AGENT_OUTPUT,
    };
  } catch (error) {
    try {
      await adapter.stop({ threadId: thread.id });
    } catch {
      // the wait failure is the error worth surfacing
    }
    throw error;
  }
}
