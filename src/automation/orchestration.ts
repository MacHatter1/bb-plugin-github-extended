// A `bb.review` action: spawn the same review thread the panel's
// "Review with agent" button starts, wait for the agent to go idle, and
// hand its output to the next action. The thread stays linked to the PR
// so its findings can be inspected in BB; a failed wait stops it.

export const REVIEW_WAIT_TIMEOUT_MS = 30 * 60_000;

export interface ReviewThreadAdapter {
  spawn(): Promise<{ id: string }>;
  wait(input: { threadId: string; status: "idle"; timeoutMs: number; signal?: AbortSignal }): Promise<unknown>;
  output(input: { threadId: string }): Promise<{ output: string | null }>;
  stop(input: { threadId: string }): Promise<unknown>;
}

export const EMPTY_REVIEW_OUTPUT = "Review completed without text output";

export async function runReviewThread(
  adapter: ReviewThreadAdapter,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ threadId: string; output: string }> {
  const thread = await adapter.spawn();
  try {
    await adapter.wait({
      threadId: thread.id,
      status: "idle",
      timeoutMs: options.timeoutMs ?? REVIEW_WAIT_TIMEOUT_MS,
      signal: options.signal,
    });
    const { output } = await adapter.output({ threadId: thread.id });
    return {
      threadId: thread.id,
      output: typeof output === "string" && output.trim().length > 0 ? output : EMPTY_REVIEW_OUTPUT,
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
