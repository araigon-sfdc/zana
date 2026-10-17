import { isLoopbackOrigin, sanitizeSshHost } from '@zana-ai/zcc-domain/machine-pairing';

export {
  PAIRING_TUNNEL_PORT,
  isLoopbackOrigin,
  localListenPort,
  sanitizeSshHost,
  sshPairingArgv,
  sshPairingCommand
} from '@zana-ai/zcc-domain/machine-pairing';

export function joinCountdownMs(joinCodeExpiresAt: number, now: number): number {
  return joinCodeExpiresAt - now;
}

export type PairingSshHostGroup = 'project' | 'ssh-config';

export interface PairingSshHostOption {
  host: string;
  label: string;
  group: PairingSshHostGroup;
  /** Secondary line — SSH alias, hostname, or user. */
  detail?: string;
}

export function sshHostOptionsFromProjects(
  projects: Array<{
    name?: string;
    lastActiveAt?: number;
    remote?: { host?: string } | null;
  }>
): PairingSshHostOption[] {
  const byHost = new Map<string, PairingSshHostOption & { lastActiveAt: number }>();
  for (const project of projects) {
    const host = sanitizeSshHost(project.remote?.host);
    if (!host) continue;
    const lastActiveAt = project.lastActiveAt ?? 0;
    const existing = byHost.get(host);
    if (existing && existing.lastActiveAt >= lastActiveAt) continue;
    const name = project.name?.trim();
    const named = Boolean(name && name !== host);
    byHost.set(host, {
      host,
      label: named && name ? name : host,
      group: 'project',
      lastActiveAt,
      ...(named ? { detail: host } : {})
    });
  }
  return [...byHost.values()]
    .sort((left, right) => right.lastActiveAt - left.lastActiveAt || left.host.localeCompare(right.host))
    .map(({ lastActiveAt: _lastActiveAt, ...option }) => option);
}

export function sshHostsFromProjects(
  projects: Array<{ remote?: { host?: string } | null }>
): string[] {
  return sshHostOptionsFromProjects(projects).map((option) => option.host);
}

export type PairingSshConfigHost = string | {
  alias: string;
  hostname?: string;
  user?: string;
};

function sshConfigDetail(entry: { hostname?: string; user?: string }): string | undefined {
  const hostname = entry.hostname?.trim();
  const user = entry.user?.trim();
  const parts = [hostname, user ? `@${user}` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

function sshConfigAlias(entry: PairingSshConfigHost): string {
  return typeof entry === 'string' ? entry : entry.alias;
}

export function mergePairingSshHosts(
  projectOptions: PairingSshHostOption[],
  sshConfigHosts: PairingSshConfigHost[]
): PairingSshHostOption[] {
  const seen = new Set(projectOptions.map((option) => option.host));
  const extra: PairingSshHostOption[] = [];
  for (const raw of sshConfigHosts) {
    const host = sanitizeSshHost(sshConfigAlias(raw));
    if (!host || seen.has(host)) continue;
    seen.add(host);
    const detail = typeof raw === 'string' ? undefined : sshConfigDetail(raw);
    extra.push({
      host,
      label: host,
      group: 'ssh-config',
      ...(detail ? { detail } : {})
    });
  }
  extra.sort((left, right) => left.host.localeCompare(right.host));
  return [...projectOptions, ...extra];
}

export function defaultSshHost(
  projects: Array<{ id?: string; remote?: { host?: string } | null }>,
  lastProjectId?: string | null
): string {
  const last = lastProjectId ? projects.find((project) => project.id === lastProjectId) : undefined;
  const fromLast = sanitizeSshHost(last?.remote?.host);
  if (fromLast) return fromLast;
  return sshHostOptionsFromProjects(projects)[0]?.host ?? '';
}

/** Prefer a reachable public origin; otherwise the local product server, like BB. */
export function resolvePairingServerUrl(publicAppUrl?: string | null): string | null {
  const trimmed = publicAppUrl?.trim().replace(/\/$/, '') || undefined;
  if (trimmed && !isLoopbackOrigin(trimmed)) return trimmed;
  return localProductOrigin() ?? trimmed ?? null;
}

export function localProductOrigin(): string | null {
  const devPort =
    typeof __ZCC_DEV_WS_PORT__ === 'number' && Number.isFinite(__ZCC_DEV_WS_PORT__)
      ? __ZCC_DEV_WS_PORT__
      : undefined;
  if (devPort) return `http://127.0.0.1:${devPort}`;
  if (typeof window !== 'undefined' && window.location?.origin && window.location.protocol !== 'file:') {
    return window.location.origin;
  }
  return null;
}

export function formatJoinCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export const REMOTE_MACHINE_CONNECTION_HINT =
  'Use Zana Connect or an SSH reverse tunnel.';
