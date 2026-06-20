import { spawn } from 'child_process'

// A handle on one running watcher process. The supervisor wires callbacks for
// stdout lines, raw stderr, and exit, and can kill the process. Implementations
// must guarantee LINE semantics on stdout (see LineBuffer below); stderr is
// delivered raw (it is logged only, never a forward signal).
export interface ProcessHandle {
  // Full stdout lines, one callback per line, in order. CRLF and bare LF both
  // terminate a line; the terminator is stripped. A non-empty trailing partial
  // (no final newline) is flushed exactly once, just before onExit fires.
  onLine(cb: (line: string) => void): void
  // Raw stderr chunks (NOT line-buffered). Logged only — never forwarded.
  onStderr(cb: (chunk: string) => void): void
  // Process exit. `code` is the exit status (null if killed by signal); `signal`
  // is the terminating signal name (null on a normal exit).
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void
  kill(signal?: NodeJS.Signals): void
  readonly pid?: number
}

export interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface ProcessSource {
  spawn(cmd: string, args?: string[], opts?: SpawnOptions): ProcessHandle
}

// Incremental stdout-to-lines splitter.
//
// Adversarial cases this must get right (line buffering):
//   - CRLF → the \r is stripped along with the \n (Windows-style scripts).
//   - a line split across two chunks ("foo" then "bar\n" → one line "foobar").
//   - multiple lines in one chunk ("a\nb\nc\n" → a, b, c).
//   - a trailing partial with no newline → flushed on exit IF non-empty.
// Blank-line skipping is intentionally NOT done here — the source emits lines
// verbatim and the Supervisor (forward layer) drops blanks. Keeping the buffer
// dumb means the same emitter is reused for stderr-style raw needs later.
export class LineBuffer {
  private buf = ''

  constructor(private readonly emit: (line: string) => void) {}

  push(chunk: string): void {
    this.buf += chunk
    let nl: number
    // Process every complete line currently in the buffer. We split on \n and
    // strip a single trailing \r so CRLF and LF normalize to the same line.
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      let line = this.buf.slice(0, nl)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.buf = this.buf.slice(nl + 1)
      this.emit(line)
    }
  }

  // Flush the trailing partial (a final line with no newline). Emitted only when
  // non-empty so a clean "…\n" stream does not produce a spurious empty line.
  // A bare trailing \r (a CRLF whose \n never arrived) is stripped too.
  flush(): void {
    if (this.buf.length === 0) return
    let line = this.buf
    if (line.endsWith('\r')) line = line.slice(0, -1)
    this.buf = ''
    if (line.length > 0) this.emit(line)
  }
}

// Production source: child_process.spawn with stdio ['ignore','pipe','pipe'].
// stdin is ignored (a watcher reads no input from us); stdout/stderr are piped
// so we can line-buffer stdout and log stderr.
export function nodeProcessSource(): ProcessSource {
  return {
    spawn(cmd: string, args: string[] = [], opts: SpawnOptions = {}): ProcessHandle {
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let lineCb: ((line: string) => void) | undefined
      let stderrCb: ((chunk: string) => void) | undefined
      let exitCb: ((info: { code: number | null; signal: string | null }) => void) | undefined

      // The LineBuffer emits through `lineCb`; callbacks may be registered after
      // spawn but before any data arrives (the supervisor wires them
      // synchronously), so we read the latest `lineCb` lazily inside emit.
      const lineBuffer = new LineBuffer(line => lineCb?.(line))

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => lineBuffer.push(chunk))

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => stderrCb?.(chunk))

      // node emits 'error' (e.g. spawn ENOENT) separately from 'exit'. Treat a
      // spawn failure as an exit so the supervisor's restart/crashloop logic sees
      // it uniformly (a script that cannot even start is a failure like any other).
      let exited = false
      const finalize = (code: number | null, signal: string | null) => {
        if (exited) return
        exited = true
        lineBuffer.flush()
        exitCb?.({ code, signal })
      }
      child.on('error', () => finalize(null, null))
      // 'close' (not 'exit') guarantees stdout/stderr have been fully drained, so
      // the trailing-partial flush sees every byte the process wrote.
      child.on('close', (code, signal) => finalize(code, signal))

      return {
        onLine(cb) {
          lineCb = cb
        },
        onStderr(cb) {
          stderrCb = cb
        },
        onExit(cb) {
          exitCb = cb
        },
        kill(signal?: NodeJS.Signals) {
          child.kill(signal)
        },
        get pid() {
          return child.pid
        },
      }
    },
  }
}

// --- Test double -------------------------------------------------------------

// One programmatically-driven fake process. The test pushes stdout chunks /
// stderr chunks / an exit, exactly as the real source would deliver them, and
// inspects recorded kills. stdout chunks go through a real LineBuffer so the
// SAME splitting logic is exercised under test as in production.
export class FakeProcessHandle implements ProcessHandle {
  private lineCb?: (line: string) => void
  private stderrCb?: (chunk: string) => void
  private exitCb?: (info: { code: number | null; signal: string | null }) => void
  private lineBuffer = new LineBuffer(line => this.lineCb?.(line))
  private exited = false

  // Recorded kill signals, in order — tests assert the supervisor killed.
  readonly kills: Array<NodeJS.Signals | undefined> = []
  readonly pid?: number

  constructor(public readonly cmd: string, public readonly args: string[], pid: number) {
    this.pid = pid
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb
  }
  onStderr(cb: (chunk: string) => void): void {
    this.stderrCb = cb
  }
  onExit(cb: (info: { code: number | null; signal: string | null }) => void): void {
    this.exitCb = cb
  }
  kill(signal?: NodeJS.Signals): void {
    this.kills.push(signal)
  }

  // --- test drivers ---

  // Feed a raw stdout chunk through the line buffer (split across chunks, CRLF,
  // multi-line all behave exactly as production).
  emitStdout(chunk: string): void {
    this.lineBuffer.push(chunk)
  }

  // Feed a raw stderr chunk (logged only).
  emitStderr(chunk: string): void {
    this.stderrCb?.(chunk)
  }

  // Simulate process exit: flush the trailing partial then fire onExit. Idempotent.
  emitExit(code: number | null = 0, signal: string | null = null): void {
    if (this.exited) return
    this.exited = true
    this.lineBuffer.flush()
    this.exitCb?.({ code, signal })
  }
}

// FakeProcessSource: hands out FakeProcessHandle instances and records every
// spawn so a test can drive the n-th process. `spawned` is append-only across
// the whole lifetime (restarts produce new handles), so backoff/restart
// sequences are inspectable.
export class FakeProcessSource implements ProcessSource {
  readonly spawned: FakeProcessHandle[] = []
  private nextPid = 1000

  spawn(cmd: string, args: string[] = [], _opts: SpawnOptions = {}): ProcessHandle {
    const handle = new FakeProcessHandle(cmd, args, this.nextPid++)
    this.spawned.push(handle)
    return handle
  }

  // The most recently spawned (current) handle, or undefined before start().
  get current(): FakeProcessHandle | undefined {
    return this.spawned[this.spawned.length - 1]
  }
}
