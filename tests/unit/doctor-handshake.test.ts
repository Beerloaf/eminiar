import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { mcpHandshake } from "../../src/install/doctor.js";

const REPLY = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "eminiar", version: "9.9.9" } } })}\n`;

/** A stand-in for the em-server child: answers initialize, then exits `exitDelay` ms after the chosen signal. */
function fakeChild(opts: { reply?: boolean; exitDelay: number; exitOn: NodeJS.Signals[] }) {
  const ee = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals: NodeJS.Signals[] = [];
  const state = { exitedAt: 0, stdinEnded: false };
  stdin.on("finish", () => {
    state.stdinEnded = true;
  });
  stdin.once("data", () => {
    if (opts.reply !== false) setImmediate(() => stdout.write(REPLY));
  });
  const child = Object.assign(ee, {
    stdin,
    stdout,
    stderr,
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(sig: NodeJS.Signals = "SIGTERM") {
      signals.push(sig);
      if (opts.exitOn.includes(sig) && !state.exitedAt) {
        setTimeout(() => {
          state.exitedAt = Date.now();
          child.signalCode = sig;
          ee.emit("exit", null, sig);
        }, opts.exitDelay);
      }
      return true;
    },
  });
  return { child: child as unknown as ChildProcess, signals, state };
}

describe("doctor's MCP handshake", () => {
  it("resolves only after a slow-exiting child has exited", async () => {
    const f = fakeChild({ exitDelay: 150, exitOn: ["SIGTERM"] });
    const reply = await mcpHandshake("em-server", 5_000, { exitMs: 2_000, spawn: () => f.child });
    const resolvedAt = Date.now();
    expect(reply).toBe("eminiar v9.9.9");
    expect(f.state.exitedAt).toBeGreaterThan(0);
    expect(resolvedAt).toBeGreaterThanOrEqual(f.state.exitedAt);
    expect(f.state.stdinEnded).toBe(true);
    expect(f.signals).toEqual(["SIGTERM"]);
  });

  it("SIGKILLs a child that ignores SIGTERM within the bound", async () => {
    const f = fakeChild({ exitDelay: 10, exitOn: ["SIGKILL"] });
    const t0 = Date.now();
    const reply = await mcpHandshake("em-server", 5_000, { exitMs: 100, spawn: () => f.child });
    expect(reply).toBe("eminiar v9.9.9");
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.state.exitedAt).toBeGreaterThan(0);
    // exitMs before SIGKILL plus the kill's own latency; generous ceiling for loaded CI.
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("never hangs on a child that survives even SIGKILL", async () => {
    const f = fakeChild({ exitDelay: 0, exitOn: [] });
    const t0 = Date.now();
    const reply = await mcpHandshake("em-server", 5_000, { exitMs: 50, spawn: () => f.child });
    expect(reply).toBe("eminiar v9.9.9");
    expect(f.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(Date.now() - t0).toBeLessThan(1_500);
  });

  it("waits for exit after a reply timeout too", async () => {
    const f = fakeChild({ reply: false, exitDelay: 50, exitOn: ["SIGTERM"] });
    const reply = await mcpHandshake("em-server", 50, { exitMs: 2_000, spawn: () => f.child });
    expect(reply).toMatch(/^no reply in 0.05s/);
    expect(f.state.exitedAt).toBeGreaterThan(0);
    expect(f.signals).toEqual(["SIGTERM"]);
  });

  it("does not signal a child that already exited", async () => {
    const f = fakeChild({ exitDelay: 0, exitOn: ["SIGTERM"] });
    f.child.stdout?.once("data", () => {
      // Exit before the reply is parsed; no kill should follow.
      Object.assign(f.child, { exitCode: 0 });
      f.child.emit("exit", 0, null);
    });
    const reply = await mcpHandshake("em-server", 5_000, { exitMs: 2_000, spawn: () => f.child });
    expect(reply).toBe("eminiar v9.9.9");
    expect(f.signals).toEqual([]);
  });

  it("reports a spawn failure without waiting", async () => {
    const f = fakeChild({ exitDelay: 0, exitOn: [] });
    Object.assign(f.child, { pid: undefined });
    setImmediate(() => f.child.emit("error", new Error("ENOENT")));
    const t0 = Date.now();
    const reply = await mcpHandshake("em-server", 5_000, { exitMs: 2_000, spawn: () => f.child });
    expect(reply).toBe("spawn failed: ENOENT");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("reaps a real child process", async () => {
    const script =
      "process.stdin.once('data',()=>process.stdout.write(" +
      JSON.stringify(REPLY) +
      "));process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));";
    const { spawn } = await import("node:child_process");
    let child: ChildProcess | undefined;
    const reply = await mcpHandshake(process.execPath, 10_000, {
      spawn: (bin) => {
        child = spawn(bin, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
        return child;
      },
    });
    expect(reply).toBe("eminiar v9.9.9");
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  });
});
