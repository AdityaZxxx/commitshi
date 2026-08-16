// Tests for the loader seam: the single-line "drafting…" indicator shown
// while a regeneration is in flight. The loader is zero-dep, mute off-TTY,
// and leaves the terminal in the same state it found it (cursor restored,
// line erased, no trailing frame garbling the next presentDraft output).

import { describe, expect, test } from "bun:test";
import { startLoader, type LoaderClock } from "./loader.ts";

/** A write() seam that captures every chunk so tests can assert ordering. */
function makeSink() {
  const chunks: string[] = [];
  return { chunks, write: (s: string) => (chunks.push(s), true) };
}

/** A controllable clock + interval pair; tests step time manually. */
function makeClock() {
  let t = 0;
  let intervalCb: (() => void) | undefined;
  const clock: LoaderClock = {
    now: () => t,
    setIntervalFn: (cb: () => void, _ms: number) => {
      intervalCb = cb;
      // A real timer satisfies IntervalHandle; unref + huge delay keep it
      // inert — tests drive ticks manually via runInterval().
      const handle = setInterval(() => {}, 1e9);
      handle.unref?.();
      return handle;
    },
    clearIntervalFn: (handle) => {
      intervalCb = undefined;
      clearInterval(handle);
    },
  };
  return {
    clock,
    tick: (ms: number) => {
      t += ms;
    },
    runInterval: () => intervalCb?.(),
  };
}

describe("startLoader — off-TTY", () => {
  test("writes nothing at all when the terminal is not a TTY", () => {
    const sink = makeSink();
    const { clock } = makeClock();
    const loader = startLoader("drafting…", sink.write, false, clock);
    loader.stop();
    expect(sink.chunks).toEqual([]);
  });
});

describe("startLoader — on TTY", () => {
  test("paints the first frame immediately, before any interval tick", () => {
    const sink = makeSink();
    const { clock } = makeClock();
    startLoader("drafting…", sink.write, true, clock);
    // First paint: cursor hidden, then the spinner frame with the label.
    expect(sink.chunks[0]).toBe("\x1b[?25l");
    expect(sink.chunks[1]).toContain("drafting…");
    expect(sink.chunks[1]).toContain("⠋");
  });

  test("each interval tick erases the line and redraws the next frame", () => {
    const sink = makeSink();
    const { clock, runInterval } = makeClock();
    startLoader("drafting…", sink.write, true, clock);
    runInterval();
    // tick 1: one chunk carrying "\r\x1b[K" + the next frame (⠙ follows ⠋).
    expect(sink.chunks[2]).toMatch(/^\r\x1b\[K/);
    expect(sink.chunks[2]).toContain("⠙");
  });

  test("frame advances one position per tick", () => {
    const sink = makeSink();
    const { clock, runInterval } = makeClock();
    startLoader("drafting…", sink.write, true, clock);
    runInterval(); // ⠙
    runInterval(); // ⠹
    expect(sink.chunks[2]).toContain("⠙");
    expect(sink.chunks[3]).toContain("⠹");
  });

  test("shows whole elapsed seconds next to the label", () => {
    const sink = makeSink();
    const { clock, tick, runInterval } = makeClock();
    startLoader("drafting…", sink.write, true, clock);
    tick(2300);
    runInterval();
    expect(sink.chunks[2]).toContain("2s");
  });

  test("stop erases the line and restores the cursor, and stops ticking", () => {
    const sink = makeSink();
    const { clock, runInterval } = makeClock();
    const loader = startLoader("drafting…", sink.write, true, clock);
    runInterval();
    const before = sink.chunks.length;
    loader.stop();
    expect(sink.chunks[before]).toBe("\r\x1b[K");
    expect(sink.chunks[before + 1]).toBe("\x1b[?25h");
    // Interval cleared: further ticks are no-ops.
    runInterval();
    expect(sink.chunks.length).toBe(before + 2);
  });

  test("stop is idempotent — a second stop emits nothing", () => {
    const sink = makeSink();
    const { clock } = makeClock();
    const loader = startLoader("drafting…", sink.write, true, clock);
    loader.stop();
    const before = sink.chunks.length;
    loader.stop();
    expect(sink.chunks.length).toBe(before);
  });
});
