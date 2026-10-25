import { describe, expect, test } from "bun:test";
import { requireQueueStateCount } from "./queue-state-count";

describe("requireQueueStateCount", () => {
  test("returns a successful due count", () => {
    expect(requireQueueStateCount("due", 42, null)).toBe(42);
  });

  test("preserves zero for a successful empty queue", () => {
    expect(requireQueueStateCount("pending", null, null)).toBe(0);
  });

  test("does not disguise a failed due query as an empty queue", () => {
    expect(() => requireQueueStateCount("due", null, { message: "timeout" }))
      .toThrow("Queue-state due count query failed: timeout");
  });

  test("reports pending-count permission errors", () => {
    expect(() => requireQueueStateCount("pending", null, "permission denied"))
      .toThrow("Queue-state pending count query failed: permission denied");
  });
});
