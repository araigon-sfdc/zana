import { lstat as fsLstat, readlink as fsReadlink, stat as fsStat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, sep } from 'node:path';

/**
 * Where an agent-named file may be read as a Squad or execution source. Rule 2's trust
 * anchors decide the location: its realpath must be inside the project, HOME or the clone
 * root. Inside those, secrets are refused wherever they live: credential stores and agent
 * session caches in HOME, the app's own data, and Zana's data folders apart from their
 * document folders (such as the library). One policy for goal-path discovery, Squad
 * proposals, squad_plan_check and the source registry.
 */

/**
 * Credential stores and agent session caches under HOME, relative to it. Kept in step with
 * the extension permission broker's `sensitiveRoots` (a guard test checks it).
 */
export const SENSITIVE_HOME_PATHS: readonly string[] = [
  '.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.netrc', '.docker/config.json',
  '.codex', '.cursor', '.claude/sessions',
  // Stores of the other harnesses Zana launches: opencode (opencode.db, auth.json), pi, grok, gemini.
  '.local/share/opencode', '.pi', '.grok', '.gemini',
  '.git-credentials', '.npmrc', '.pypirc', '.kube', '.claude.json', '.claude/.credentials.json',
  '.claude/projects', 'Library/Keychains'
];

/**
 * The protected entries above that the extension permission broker's `sensitiveRoots` does not
 * list (it guards plugin writes, this guards agent reads). Documented in one place so the two
 * lists can be compared by eye; the broker parity test checks every other entry is in both.
 */
export const SENSITIVE_HOME_PATHS_OUTSIDE_BROKER: readonly string[] = [
  '.gnupg', '.config/gh', '.netrc', '.docker/config.json',
  '.git-credentials', '.npmrc', '.pypirc', '.kube', '.claude.json', '.claude/.credentials.json',
  '.claude/projects', 'Library/Keychains',
  '.local/share/opencode', '.pi', '.grok', '.gemini'
];

/**
 * The only HOME credential stores refused inside the registered Project. Before the shared
 * policy these (plus Zana's data folders and the app's own data) were the whole list, so a
 * Project that lives in, say, `~/.claude/projects/<p>` keeps the files it could attach.
 */
// The pre-#385 refusals, plus Claude Code's credentials file, which no Project should hand to a Squad.
export const IN_PROJECT_PROTECTED_HOME_PATHS: readonly string[] = ['.ssh', '.aws', '.claude/.credentials.json'];

/** Zana's data folders under HOME (production, dev and shared machines); ZCC_DATA_DIR is added by the caller. */
export const ZANA_DATA_DIR_NAMES: readonly string[] = ['.zcc', '.zcc-dev', '.zcc-machines', '.cc-center'];

/**
 * The folders of a Zana data folder that may be read: its documents, and the checkouts it
 * manages (Squad worktrees, personal workspaces). Everything else in it (tokens, keys,
 * config, sockets, databases and state folders, including new ones) is refused.
 */
export const READABLE_DATA_DIRS: readonly string[] = [
  'library', 'personas', 'teams', 'templates', 'saved',
  // Managed Squad worktrees: MANAGED_WORKTREE_DIR_NAME, see services/threads/worktree-paths.ts.
  'worktrees',
  // A Project cloned by the host daemon lives in <dataDir>/checkouts: PROJECT_CHECKOUTS_DIR_NAME, see packages/host-workspace/src/workspace.ts.
  'checkouts',
  'personal-workspaces'
];

/** The bases a policy actually allows, named for a refusal message ("the project, your home folder and the clone root"). */
export function allowedLocationsText(policy?: Pick<SourcePolicy, 'roots' | 'home' | 'cloneRoot'>): string {
  const parts = ['the project'];
  if (!policy || policy.roots.includes(policy.home)) parts.push('your home folder');
  if (!policy || policy.cloneRoot) parts.push('the clone root');
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** How the agent is told what may be attached, so it can correct a refused path itself. */
export function sourcePolicyText(policy?: Pick<SourcePolicy, 'roots' | 'home' | 'cloneRoot'>): string {
  return `A source must be a file inside ${allowedLocationsText(policy).replace(/^the project/, 'this project')}. `
    + `Credential stores and agent sessions (${SENSITIVE_HOME_PATHS.map((path) => `~/${path}`).join(', ')}), the app's own data `
    + `and Zana's data folders (~/.zcc and its kin) are refused, except their ${READABLE_DATA_DIRS.join(', ')} folders. `
    + `Inside the project itself only ${IN_PROJECT_PROTECTED_HOME_PATHS.map((path) => `~/${path}`).join(', ')}, the app's own data and Zana's data folders stay refused. `
    + 'A link that leads into a refused location is refused too.';
}

/** The default text names every base; a refusal built from a resolved policy names only the active ones. */
export const SOURCE_POLICY_TEXT = sourcePolicyText();

export interface SourcePolicy {
  /** Realpaths of the allowed bases: the project, HOME and the clone root. */
  roots: readonly string[];
  /** Realpath of HOME. */
  home: string;
  /** Protected folders and files, plain and realpath'd. Defaults to the credential stores under `home`. */
  protectedRoots?: readonly string[];
  /** Zana data folders, plain and realpath'd. Defaults to `ZANA_DATA_DIR_NAMES` under `home`. */
  dataDirs?: readonly string[];
  /** Realpath of the registered Project, set only when it is a proper sub-folder of HOME (see `projectProtectedRoots`). */
  projectRoot?: string;
  /** What stays protected inside `projectRoot`: only the protections that predate the shared policy. Outside it, `protectedRoots` applies. */
  projectProtectedRoots?: readonly string[];
  /** The clone root, when it is an active base. */
  cloneRoot?: string;
}

export type SourceRefusal = 'outside' | 'sensitive' | 'links';

const within = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
const atOrWithin = (child: string, parent: string): boolean => child === parent || within(child, parent);

/**
 * macOS volumes are case-insensitive by default and realpath does not always normalise case, so
 * protected paths and data folders are compared case-insensitively (a harmless over-refusal on
 * case-sensitive volumes). The allowed bases (`roots`) keep the exact comparison.
 */
const withinFold = (child: string, parent: string): boolean => within(child.toLowerCase(), parent.toLowerCase());
const atOrWithinFold = (child: string, parent: string): boolean => child.toLowerCase() === parent.toLowerCase() || withinFold(child, parent);

const defaultProtectedRoots = (home: string): string[] => SENSITIVE_HOME_PATHS.map((path) => join(home, path));
const defaultDataDirs = (home: string): string[] => ZANA_DATA_DIR_NAMES.map((name) => join(home, name));

export function isSensitiveSourcePath(
  real: string, policy: Pick<SourcePolicy, 'home' | 'protectedRoots' | 'dataDirs' | 'projectRoot' | 'projectProtectedRoots'>
): boolean {
  const inProject = policy.projectRoot !== undefined && policy.projectProtectedRoots !== undefined && within(real, policy.projectRoot);
  const protectedRoots = (inProject ? policy.projectProtectedRoots : policy.protectedRoots) ?? defaultProtectedRoots(policy.home);
  if (protectedRoots.some((root) => atOrWithinFold(real, root))) return true;
  const dataDirs = policy.dataDirs ?? defaultDataDirs(policy.home);
  return dataDirs.some((dataDir) => atOrWithinFold(real, dataDir)
    && !READABLE_DATA_DIRS.some((name) => withinFold(real, join(dataDir, name))));
}

/** Why a resolved (realpath) source is refused, or undefined when it may be read. */
export function sourcePathRefusal(real: string, policy: SourcePolicy): SourceRefusal | undefined {
  if (!policy.roots.some((root) => within(real, root))) return 'outside';
  return isSensitiveSourcePath(real, policy) ? 'sensitive' : undefined;
}

/** The two calls the link walk needs; injectable so tests need no real links. */
export interface LinkFs {
  lstat(path: string): Promise<{ isSymbolicLink?: () => boolean }>;
  readlink(path: string): Promise<string>;
}

export const MAX_LINK_HOPS = 40;

const splitParts = (path: string): string[] => path.split(sep === '\\' ? /[\\/]+/ : /\/+/);

/**
 * `realpath` only reports where a path ends up, so `~/notes.md -> ~/.ssh/id_rsa`, or a link
 * placed inside a protected folder that points out of it, looks harmless. Walk the given
 * absolute path component by component, following every link (at most `MAX_LINK_HOPS`), and
 * refuse when the path or any step it passes through is protected. A Zana data folder and its readable folders
 * may be passed through; what it holds is judged per step.
 * Returns 'links' for a loop or too many links, or a link that can't be read (fail closed).
 * A missing component ends the walk quietly: the caller's realpath reports a missing file.
 */
export async function linkChainRefusal(
  given: string,
  policy: Pick<SourcePolicy, 'home' | 'protectedRoots' | 'dataDirs' | 'projectRoot' | 'projectProtectedRoots'>,
  linkFs: LinkFs = { lstat: fsLstat, readlink: fsReadlink }
): Promise<'sensitive' | 'links' | undefined> {
  if (!isAbsolute(given)) return undefined;
  // A data folder and its readable folders are passed through; what they hold is judged per step.
  const passThrough = new Set((policy.dataDirs ?? defaultDataDirs(policy.home))
    .flatMap((dir) => [dir, ...READABLE_DATA_DIRS.map((name) => join(dir, name))]).map((path) => path.toLowerCase()));
  // The Project and the folders leading to it are judged by the in-Project list: `~/.claude/projects` is protected for
  // everything else, but a Project at `~/.claude/projects/p` has to be reachable.
  const ancestorList = policy.projectRoot !== undefined && policy.projectProtectedRoots !== undefined ? policy.projectProtectedRoots : undefined;
  const protectedStep = (path: string): boolean => {
    if (passThrough.has(path.toLowerCase())) return false;
    const leadsToProject = ancestorList !== undefined && atOrWithinFold(policy.projectRoot!, path);
    return isSensitiveSourcePath(path, leadsToProject ? { home: policy.home, dataDirs: policy.dataDirs, protectedRoots: ancestorList } : policy);
  };
  let current = parse(given).root;
  const pending = splitParts(given.slice(current.length));
  let hops = 0;
  while (pending.length) {
    const part = pending.shift()!;
    if (!part || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const next = join(current, part);
    if (protectedStep(next)) return 'sensitive';
    let isLink = false;
    try { isLink = (await linkFs.lstat(next)).isSymbolicLink?.() === true; } catch { isLink = false; }
    if (!isLink) { current = next; continue; }
    if (++hops > MAX_LINK_HOPS) return 'links';
    let target: string;
    try { target = await linkFs.readlink(next); } catch { return 'links'; }
    if (isAbsolute(target)) {
      current = parse(target).root;
      pending.unshift(...splitParts(target.slice(current.length)));
    } else pending.unshift(...splitParts(target));
  }
  return undefined;
}

/**
 * Why an agent-named file is refused, or undefined when it may be read: the link walk over the
 * path as given, then the policy over the realpath it resolved to. One check for every confirm path.
 */
export async function sourceRefusal(given: string, real: string, policy: SourcePolicy, linkFs?: LinkFs): Promise<SourceRefusal | undefined> {
  const chain = await linkChainRefusal(given, policy, linkFs);
  if (chain) return chain;
  return sourcePathRefusal(real, policy);
}

/**
 * Resolve a policy. A base that doesn't resolve (a remote project root, an unset clone root)
 * is dropped, as is a clone root that is a filesystem root, contains HOME, is world-writable
 * (`/tmp`) or is `/Volumes` (it would widen the bases to the whole disk or to other users'
 * files). When HOME itself is `/`, it is not a base either, and the clone root goes with it
 * (a `/` HOME means the path facts are unreliable), so only the project remains. Protected paths and data folders are kept both as given and
 * realpath'd, so a symlinked `~/.ssh` (a dotfiles setup) stays refused.
 */
export async function resolveSourcePolicy(
  realpath: (path: string) => Promise<string>,
  bases: {
    projectRoot?: string; home: string; cloneRoot?: string; dataDirs?: readonly string[]; protectedRoots?: readonly string[];
    /** Defaults to `fs/promises.stat`; used to detect a world-writable clone root. */
    stat?: (path: string) => Promise<{ mode: number }>;
    /** Defaults to `process.platform`. libuv reports every Windows directory as mode 0o666, so the world-writable check is skipped on win32. */
    platform?: NodeJS.Platform;
  }
): Promise<SourcePolicy> {
  const resolveOr = async (path: string | undefined): Promise<string | undefined> => {
    if (!path?.trim()) return undefined;
    try { return await realpath(path); } catch { return undefined; }
  };
  const bothForms = async (paths: readonly string[]): Promise<string[]> =>
    [...new Set((await Promise.all(paths.map(async (path) => [path, await resolveOr(path)]))).flat().filter((path): path is string => !!path))];
  const home = (await resolveOr(bases.home)) ?? bases.home;
  const cloneRoot = await resolveOr(bases.cloneRoot);
  let cloneRootSafe = cloneRoot !== undefined && dirname(cloneRoot) !== cloneRoot && !atOrWithin(home, cloneRoot) && cloneRoot !== '/Volumes';
  if (cloneRootSafe) {
    // Unreadable mode: keep the clone root out rather than trust it.
    // Windows has no world-writable mode bits to read.
    if ((bases.platform ?? process.platform) !== 'win32') {
      try { cloneRootSafe = ((await (bases.stat ?? fsStat)(cloneRoot!)).mode & 0o002) === 0; } catch { cloneRootSafe = false; }
    }
  }
  const homeIsRoot = dirname(home) === home;
  const projectRoot = await resolveOr(bases.projectRoot);
  const activeCloneRoot = cloneRootSafe && !homeIsRoot ? cloneRoot : undefined;
  const roots = [projectRoot, homeIsRoot ? undefined : home, activeCloneRoot].filter((root): root is string => !!root);
  // Inside a Project that is a proper sub-folder of HOME, only the protections that predate the shared
  // policy apply; a Project that is HOME (or holds it) would otherwise lose every newer one.
  const relaxInProject = projectRoot !== undefined && !homeIsRoot && !atOrWithin(home, projectRoot);
  return {
    roots: [...new Set(roots)],
    home,
    protectedRoots: await bothForms([...defaultProtectedRoots(home), ...(bases.protectedRoots ?? [])]),
    dataDirs: await bothForms([...defaultDataDirs(home), ...(bases.dataDirs ?? [])]),
    ...(relaxInProject ? {
      projectRoot,
      projectProtectedRoots: await bothForms([...IN_PROJECT_PROTECTED_HOME_PATHS.map((path) => join(home, path)), ...(bases.protectedRoots ?? [])])
    } : {}),
    ...(activeCloneRoot ? { cloneRoot: activeCloneRoot } : {})
  };
}

/** `~`-abbreviated form of an absolute path under HOME, for cards and chips. */
export function displaySourcePath(real: string, home: string): string {
  return within(real, home) ? `~${sep}${relative(home, real)}` : real;
}
