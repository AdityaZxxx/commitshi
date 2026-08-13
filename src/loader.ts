// The in-flight indicator for model calls: a single-line braille spinner
// with an elapsed-seconds readout, written while a regeneration is awaited.
//
// Why a spinner and not a shimmer/progress bar: the wait is unbounded and
// indeterminate (no streaming, no total), so the loader's only jobs are (1)
// prove the process is alive and (2) show elapsed time so the user can judge
// whether to keep waiting or quit. A shimmer repaints many columns per frame
// and garbles scrollback on interrupt; one spinner cell + digits never does.
//
// Discipline:
//   - TTY only. Off-TTY (pipes, CI, hooks) emits nothing — captured output
//     stays linear and greppable, matching regenerating()'s contract.
//   - The cursor is hidden for the spinner's lifetime and ALWAYS restored on
//     stop(); stop() is idempotent so cleanup paths can call it blindly.
//   - Every redraw is "\r\x1b[K" + one frame: carriage-return, clear-line,
//     fixed-width content. The screen is consistent after any interrupt.
//   - Zero deps; time and timers are injected (LoaderClock) so tests step
//     manually instead of sleeping.

/** The frames, in order. Braille cells are one terminal column wide. */
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** How fast the spinner advances. 80ms reads as alive without flicker. */
const INTERVAL_MS = 80;

export type LoaderClock = Readonly<{
  now?: () => number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}>;

export type Loader = Readonly<{
  /** Clears the interval, erases the line, restores the cursor. Idempotent. */
  stop: () => void;
}>;

const defaultClock: Required<LoaderClock> = {
  now: () => Date.now(),
  setIntervalFn: (cb, ms) => setInterval(cb, ms),
  clearIntervalFn: (h) => clearInterval(h as Parameters<typeof clearInterval>[0]),
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ERASE_LINE = "\r\x1b[K";

/**
 * Starts the spinner. Paints the first frame immediately (no 80ms silence),
 * then one frame per tick. Off-TTY: returns an inert loader that never
 * writes. `label` is caller-chosen ("drafting…"); keep it to one short word.
 */
export function startLoader(
  label: string,
  write: (s: string) => unknown,
  isTTY: boolean,
  clock: LoaderClock = {},
): Loader {
  if (!isTTY) return { stop: () => {} };

  const { now, setIntervalFn, clearIntervalFn } = { ...defaultClock, ...clock };
  const started = now();
  let frame = 0;
  let stopped = false;

  const paint = () => {
    const secs = Math.floor((now() - started) / 1000);
    const spinner = FRAMES[frame++ % FRAMES.length];
    write(`${ERASE_LINE}  ${spinner} ${label} ${secs}s`);
  };

  write(HIDE_CURSOR);
  paint();
  const handle = setIntervalFn(paint, INTERVAL_MS);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(handle);
      write(ERASE_LINE);
      write(SHOW_CURSOR);
    },
  };
}
