import { describe, expect, it, vi } from "vitest";
import { EMPTY_REVIEW_OUTPUT, runReviewThread } from "./orchestration";

describe("BB review orchestration", () => {
  it("spawns, waits for idle, and returns the thread output", async () => {
    const calls: string[] = [];
    const adapter = {
      spawn: vi.fn(async () => { calls.push("spawn"); return { id: "thr_1" }; }),
      wait: vi.fn(async (input: { status: string; timeoutMs: number }) => {
        expect(input.status).toBe("idle");
        expect(input.timeoutMs).toBe(1_000);
        calls.push("wait");
      }),
      output: vi.fn(async () => { calls.push("output"); return { output: "review" }; }),
      stop: vi.fn(async () => { calls.push("stop"); }),
    };
    await expect(runReviewThread(adapter, { timeoutMs: 1_000 })).resolves.toEqual({ threadId: "thr_1", output: "review" });
    expect(calls).toEqual(["spawn", "wait", "output"]);
  });

  it("substitutes a placeholder when the thread produced no text", async () => {
    const result = await runReviewThread({
      spawn: async () => ({ id: "thr_2" }),
      wait: async () => undefined,
      output: async () => ({ output: "   " }),
      stop: async () => undefined,
    });
    expect(result.output).toBe(EMPTY_REVIEW_OUTPUT);
  });

  it("stops the thread when the wait fails", async () => {
    const stop = vi.fn(async () => undefined);
    await expect(runReviewThread({
      spawn: async () => ({ id: "thr_3" }),
      wait: async () => { throw new Error("timed out"); },
      output: async () => ({ output: null }),
      stop,
    })).rejects.toThrow("timed out");
    expect(stop).toHaveBeenCalledWith({ threadId: "thr_3" });
  });
});
