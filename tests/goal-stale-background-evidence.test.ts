/**
 * A registry can keep a husk: a run whose process died without ever reaching a
 * terminal state stays "running" for as long as the registry lives. The goal
 * used to wait out the whole deferral cap behind such a run on every single
 * checkpoint, with the session sitting idle and an active goal on screen.
 *
 * Evidence age is the discriminator: both registries report when their work
 * started, so work whose own evidence is older than STALE_RUN_EVIDENCE_MS
 * stops holding the continuation, while genuinely fresh work still does. A
 * registry that reports no timestamp keeps the old benefit of the doubt — the
 * deferral cap remains the backstop for that case.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { STALE_RUN_EVIDENCE_MS, probeBackgroundTasksActive, probeSubagentRunsActive } from "../extensions/goal-background.ts";

interface BusHandler { (data: unknown): void }

function busWith(reply: (request: Record<string, unknown>) => { channel: string; payload: unknown }) {
  const handlers = new Map<string, Set<BusHandler>>();
  return {
    on(channel: string, handler: BusHandler) {
      const set = handlers.get(channel) ?? new Set<BusHandler>();
      set.add(handler);
      handlers.set(channel, set);
      return () => { set.delete(handler); };
    },
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
      if (channel.endsWith(":reply") || channel.includes("reply:")) return;
      const request = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
      const answer = reply(request);
      queueMicrotask(() => {
        for (const handler of handlers.get(answer.channel) ?? []) handler(answer.payload);
      });
    },
  };
}

function subagentsPi(startedAt: number | undefined) {
  const events = busWith((request) => ({
    channel: `subagents:rpc:v1:reply:${String(request.requestId)}`,
    payload: {
      version: 1,
      requestId: request.requestId,
      success: true,
      data: {
        fleet: {
          version: 1,
          entries: [{ key: "fleet-1", agent: "worker", ...(startedAt === undefined ? {} : { startedAt }) }],
          totalActive: 1,
          topLevelAsyncCapacity: { used: 0, limit: 0 },
          omitted: 0,
        },
      },
    },
  }));
  return { events } as never;
}

function backgroundTasksPi(startTime: number | undefined) {
  const events = busWith((request) => ({
    channel: "pi-background-tasks:response:v1",
    payload: {
      schema_version: "pi-background-tasks.extension-response.v1",
      request_id: request.request_id,
      operation: "status",
      ok: true,
      result: { tasks: [{ id: "task-1", status: "running", ...(startTime === undefined ? {} : { startTime }) }] },
    },
  }));
  return { events } as never;
}

test("fresh subagent work still holds the continuation", async () => {
  assert.equal(await probeSubagentRunsActive(subagentsPi(Date.now() - 30_000)), true);
});

test("a subagent run older than the evidence window stops holding it", async () => {
  assert.equal(await probeSubagentRunsActive(subagentsPi(Date.now() - STALE_RUN_EVIDENCE_MS - 1_000)), false);
});

test("a fleet entry without a timestamp keeps the benefit of the doubt", async () => {
  assert.equal(await probeSubagentRunsActive(subagentsPi(undefined)), true);
});

test("fresh background tasks still hold the continuation", async () => {
  assert.equal(await probeBackgroundTasksActive(backgroundTasksPi(Date.now() - 30_000)), true);
});

test("a background task older than the evidence window stops holding it", async () => {
  assert.equal(await probeBackgroundTasksActive(backgroundTasksPi(Date.now() - STALE_RUN_EVIDENCE_MS - 1_000)), false);
});
