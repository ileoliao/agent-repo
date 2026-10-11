import { spawn } from 'child_process';

export interface ExecOptions {
  cwd: string;
  timeoutSec: number;
  maxOutputBytes: number;
  /** Injected into the environment and masked out of the output. */
  secrets: Record<string, string>;
  /** Extra non-secret environment variables. */
  env?: Record<string, string>;
  onCancel?: (kill: () => void) => { dispose(): void };
}

/** Non-interactive shell execution: stdin closed, pagers off, hard timeout, secrets redacted. */
export function exec(command: string, o: ExecOptions): Promise<{ code: number | null; text: string }> {
  return new Promise(resolve => {
    const child = spawn(command, {
      cwd: o.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...o.env,
        ...o.secrets,
        CI: '1',
        PAGER: 'cat',
        GIT_PAGER: 'cat',
        GIT_TERMINAL_PROMPT: '0',
        NO_COLOR: '1',
        npm_config_yes: 'true'
      }
    });
    let buf = '';
    const cap = o.maxOutputBytes;
    const onData = (d: Buffer) => { if (buf.length < cap * 4) { buf += d.toString(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, o.timeoutSec * 1000);
    const sub = o.onCancel?.(kill);
    child.on('error', err => { buf += `\n${err.message}`; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      sub?.dispose();
      let text = redact(buf, o.secrets);
      if (text.length > cap) {
        text = text.slice(0, cap / 2) + '\n...[truncated]...\n' + text.slice(-cap / 2);
      }
      const status = signal ? `killed by ${signal} (timeout ${o.timeoutSec}s or cancelled)` : `exit ${code}`;
      resolve({ code: signal ? null : code, text: `[${status}]\n${text}` });
    });
  });
}

export function redact(s: string, secrets: Record<string, string>): string {
  let out = s;
  for (const v of Object.values(secrets)) {
    if (v && v.length >= 4) { out = out.split(v).join('***'); }
  }
  return out;
}
