import { describe, expect, it, vi } from "vitest";
import { SessionRecoveryManager } from "./session-recovery.js";
import type { SessionRecoveryState } from "./mixed-modality-types.js";

function mkCheckpoint(sessionId: string, overrides?: Partial<SessionRecoveryState>): SessionRecoveryState {
  return {
    sessionId, duplexState: "listening",
    modalityState: { inputModality: "audio", outputModality: "audio", textInterruptActive: false, audioOutputActive: false, textOutputActive: false, switchCount: 0, lastSwitchAt: null },
    contextTokens: 100,
    conversationHistory: [
      { role: "user", modality: "text", content: "Hello", timestamp: 1000 },
      { role: "assistant", modality: "text", content: "Hi!", timestamp: 1100 },
    ],
    checkpointAt: 1000, recoveryAttempts: 0, ...overrides,
  };
}

describe("SessionRecoveryManager", () => {
  it("saves and retrieves checkpoint", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    expect(mgr.getCheckpoint("sess-1")).not.toBeNull();
  });

  it("returns null for unknown session", () => {
    expect(new SessionRecoveryManager().getCheckpoint("nonexistent")).toBeNull();
  });

  it("overwrites checkpoint for same session", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("sess-1", { contextTokens: 50 }));
    mgr.saveCheckpoint(mkCheckpoint("sess-1", { contextTokens: 200 }));
    expect(mgr.getCheckpoint("sess-1")!.contextTokens).toBe(200);
  });

  it("removes checkpoint", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    expect(mgr.removeCheckpoint("sess-1")).toBe(true);
    expect(mgr.getCheckpoint("sess-1")).toBeNull();
  });

  it("removeCheckpoint returns false for unknown", () => {
    expect(new SessionRecoveryManager().removeCheckpoint("x")).toBe(false);
  });

  it("expires old checkpoints", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ checkpointTtlMs: 5000, now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    now = 7000;
    expect(mgr.getCheckpoint("sess-1")).toBeNull();
  });

  it("returns checkpoint within TTL", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ checkpointTtlMs: 5000, now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    now = 4000;
    expect(mgr.getCheckpoint("sess-1")).not.toBeNull();
  });

  it("pruneExpired removes stale", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ checkpointTtlMs: 5000, now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("s1")); mgr.saveCheckpoint(mkCheckpoint("s2"));
    now = 7000;
    expect(mgr.pruneExpired()).toBe(2);
    expect(mgr.stats.activeCheckpoints).toBe(0);
  });

  it("pruneExpired keeps fresh", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ checkpointTtlMs: 5000, now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("s1")); now = 2000; mgr.saveCheckpoint(mkCheckpoint("s2"));
    now = 4000;
    expect(mgr.pruneExpired()).toBe(0);
  });

  it("recovers on first attempt", () => {
    let now = 1000;
    const onRecovered = vi.fn();
    const mgr = new SessionRecoveryManager({ now: () => now, onRecovered });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    const r = mgr.attemptRecovery("sess-1");
    expect(r.recovered).toBe(true);
    expect(r.checkpoint!.recoveryAttempts).toBe(1);
    expect(onRecovered).toHaveBeenCalled();
  });

  it("fails when max attempts exceeded", () => {
    let now = 1000;
    const onFailed = vi.fn();
    const mgr = new SessionRecoveryManager({ now: () => now, maxRecoveryAttempts: 2, onRecoveryFailed: onFailed });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    mgr.attemptRecovery("sess-1"); mgr.attemptRecovery("sess-1");
    const r = mgr.attemptRecovery("sess-1");
    expect(r.recovered).toBe(false);
    expect(r.reason).toBe("max_attempts_exceeded");
    expect(onFailed).toHaveBeenCalled();
  });

  it("fails when no checkpoint", () => {
    const onFailed = vi.fn();
    const mgr = new SessionRecoveryManager({ onRecoveryFailed: onFailed });
    expect(mgr.attemptRecovery("x").reason).toBe("no_valid_checkpoint");
    expect(onFailed).toHaveBeenCalled();
  });

  it("removes checkpoint after max attempts", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now, maxRecoveryAttempts: 1 });
    mgr.saveCheckpoint(mkCheckpoint("sess-1"));
    mgr.attemptRecovery("sess-1"); mgr.attemptRecovery("sess-1");
    expect(mgr.getCheckpoint("sess-1")).toBeNull();
  });

  it("builds recovery context", () => {
    const mgr = new SessionRecoveryManager();
    const cp = mkCheckpoint("sess-1", {
      conversationHistory: [
        { role: "user", modality: "text", content: "Hello", timestamp: 1000 },
        { role: "assistant", modality: "audio", content: "Hi there", timestamp: 1100 },
      ],
    });
    const ctx = mgr.buildRecoveryContext(cp);
    expect(ctx.systemPrompt).toContain("recovered");
    expect(ctx.messages.length).toBe(2);
    expect(ctx.messages[1].content).toContain("[audio transcript]");
  });

  it("tracks stats", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now, maxRecoveryAttempts: 1 });
    mgr.saveCheckpoint(mkCheckpoint("s1")); mgr.saveCheckpoint(mkCheckpoint("s2"));
    mgr.attemptRecovery("s1"); mgr.attemptRecovery("x");
    expect(mgr.stats.totalCheckpoints).toBe(2);
    expect(mgr.stats.totalRecoveries).toBe(1);
    expect(mgr.stats.totalFailures).toBe(1);
  });

  it("clear removes all", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now });
    mgr.saveCheckpoint(mkCheckpoint("s1")); mgr.saveCheckpoint(mkCheckpoint("s2"));
    mgr.clear();
    expect(mgr.stats.activeCheckpoints).toBe(0);
  });

  it("trims history on save", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now, maxRecoveryItems: 2 });
    mgr.saveCheckpoint(mkCheckpoint("s1", {
      conversationHistory: [
        { role: "user", modality: "text", content: "a", timestamp: 1000 },
        { role: "assistant", modality: "text", content: "b", timestamp: 1100 },
        { role: "user", modality: "text", content: "c", timestamp: 1200 },
      ],
    }));
    expect(mgr.getCheckpoint("s1")!.conversationHistory.length).toBe(2);
  });

  it("swallows onRecovered errors", () => {
    let now = 1000;
    const mgr = new SessionRecoveryManager({ now: () => now, onRecovered: () => { throw new Error("boom"); } });
    mgr.saveCheckpoint(mkCheckpoint("s1"));
    expect(() => mgr.attemptRecovery("s1")).not.toThrow();
  });

  it("swallows onRecoveryFailed errors", () => {
    const mgr = new SessionRecoveryManager({ onRecoveryFailed: () => { throw new Error("boom"); } });
    expect(() => mgr.attemptRecovery("x")).not.toThrow();
  });
});
