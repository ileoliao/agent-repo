import { createLocalShellOperations, type BashOperations } from './vendor/pi/tools/bash';
import { createLocalPowerShellOperations } from './vendor/pi/tools/powershell';
import { getPowerShellConfig, getShellConfig, POWERSHELL_ARGS, type ShellConfig } from './vendor/pi/utils/shell';

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

export interface ShellProbe {
  bash: () => ShellConfig | undefined;
  powershell: () => ShellConfig | undefined;
  comSpec?: string;
}

/**
 * Which shell pi's local executor should use.
 * Unix: bash (pi's getShellConfig). Windows: Git Bash when it is installed, otherwise
 * PowerShell (pi's getPowerShellConfig), otherwise cmd.exe /d /s /c.
 */
export function selectShellConfig(platform: NodeJS.Platform, probe: ShellProbe): ShellConfig {
  if (platform !== 'win32') {
    const bash = probe.bash();
    if (!bash) throw new Error('No bash shell found');
    return bash;
  }
  return probe.bash() ?? probe.powershell() ?? { shell: probe.comSpec || 'cmd.exe', args: ['/d', '/s', '/c'] };
}

let cachedShell: ShellConfig | undefined;

export function resolveShellConfig(): ShellConfig {
  if (!cachedShell) {
    cachedShell = selectShellConfig(process.platform, {
      bash: () => {
        try { return getShellConfig(); } catch { return undefined; }
      },
      powershell: () => {
        try { return getPowerShellConfig(); } catch { return undefined; }
      },
      comSpec: process.env.ComSpec,
    });
  }
  return cachedShell;
}

/** Re-exported so tests can assert pi's PowerShell argument list without importing the vendor tree. */
export { POWERSHELL_ARGS };

const ENV_ALLOW = new Set([
  'path', 'home', 'user', 'logname', 'shell', 'lang', 'lc_all', 'lc_ctype', 'lc_messages',
  'tz', 'tmpdir', 'tmp', 'temp', 'systemroot', 'windir', 'comspec', 'pathext',
  'userprofile', 'homedrive', 'homepath', 'appdata', 'localappdata',
  'programfiles', 'programfiles(x86)', 'programw6432', 'term', 'colorterm',
  'processor_architecture', 'systemdrive', 'userdomain',
  // Plumbing for git/ssh/gh behind keyrings, agents, proxies and private CAs. Tokens (GH_TOKEN, ...) stay out:
  // give those to a role with Set Secret.
  'ssh_auth_sock', 'dbus_session_bus_address', 'xdg_runtime_dir',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'node_extra_ca_certs', 'ssl_cert_file', 'ssl_cert_dir', 'requests_ca_bundle', 'curl_ca_bundle',
]);

/**
 * Environment passed to a child. pi's getShellEnv copies process.env; Harbor Mate does not,
 * so a secret sitting in the extension host environment cannot reach a command or the model.
 */
export function buildShellEnv(secrets: Record<string, string>, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (ENV_ALLOW.has(lower) || lower.startsWith('lc_')) env[key] = value;
  }
  return {
    ...env,
    ...extra,
    ...secrets,
    CI: '1',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    npm_config_yes: 'true',
  };
}

function operationsFor(config: ShellConfig): BashOperations {
  if (/pwsh|powershell/i.test(config.shell)) return createLocalPowerShellOperations();
  return createLocalShellOperations('shell', () => config);
}

/** Non-interactive shell execution: stdin closed, pagers off, hard timeout, secrets redacted. */
export function exec(command: string, o: ExecOptions): Promise<{ code: number | null; text: string }> {
  return run(command, o);
}

async function run(command: string, o: ExecOptions): Promise<{ code: number | null; text: string }> {
  const ac = new AbortController();
  const sub = o.onCancel?.(() => ac.abort());
  const ops = operationsFor(resolveShellConfig());
  const cap = o.maxOutputBytes;
  // Keep the first `cap` chars and a rolling window of the last `cap`..2*cap chars, so the real end of a long
  // log survives. The middle is dropped and the final cut below leaves cap/2 on each side.
  let head = '';
  let tail = '';
  const append = (str: string) => {
    const room = Math.max(0, cap - head.length);
    head += str.slice(0, room);
    tail += str.slice(room);
    if (tail.length > cap * 2) tail = tail.slice(-cap);
  };
  let code: number | null = null;
  let status: string;
  try {
    const result = await ops.exec(command, o.cwd, {
      onData: (data) => append(data.toString()),
      signal: ac.signal,
      timeout: o.timeoutSec,
      env: buildShellEnv(o.secrets, o.env),
    });
    code = result.exitCode;
    status = `exit ${code}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'aborted' || msg.startsWith('timeout:')) {
      code = null;
      status = `killed by SIGKILL (timeout ${o.timeoutSec}s or cancelled)`;
    } else {
      code = null;
      const sofar = head + tail;
      append((sofar && !sofar.endsWith('\n') ? '\n' : '') + msg);
      status = 'error';
    }
  } finally {
    sub?.dispose();
  }
  let text = redact(head + tail, o.secrets);
  if (text.length > cap) {
    const half = Math.floor(cap / 2);
    text = text.slice(0, half) + '\n...[truncated]...\n' + text.slice(-half);
  }
  return { code, text: `[${status}]\n${text}` };
}

/** Replace every secret value, including short ones. Longer values are masked first. */
export function redact(s: string, secrets: Record<string, string>): string {
  const values = Object.values(secrets).filter(v => v.length > 0).sort((a, b) => b.length - a.length);
  let out = s;
  for (const v of values) out = out.split(v).join('***');
  return out;
}
