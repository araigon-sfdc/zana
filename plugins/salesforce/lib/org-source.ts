import { ACTION_SOURCE_CAP, apexContract, orgGetter, readOrgAction, type ActionSource } from './action-source.js';
import { parseActionTarget, type ActionTarget } from './agent-action-model.js';
import { readRetrieved, removeTemp, retrieveInto, tempProject } from './org-retrieve.js';
import type { ResolvedOrg, SalesforceDeps } from './types.js';

const CACHE_ENTRIES = 24;
const RETRIEVE_TIMEOUT = 120_000;

type Freshness = { stamp: string; version?: number; inactive?: boolean };
type Cached = { stamp: string; content: string | null };

const errorText = (error: unknown) => error instanceof Error && error.message ? error.message.slice(0, 300) : 'Unknown error';

/**
 * The org copy of an Apex class or Flow, retrieved in source format like the project copy (the VS Code
 * extension's approach), so both sides are the same file format and a Flow need not be active.
 *
 * A cheap Tooling query stamps the component (last modified, Flow versions); a retrieve runs only when the
 * stamp changed. Managed (namespaced) components and failed retrieves fall back to the Tooling snapshot.
 */
export class OrgSourceReader {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<string | null>>();
  constructor(private readonly deps: SalesforceDeps) {}

  async read(org: ResolvedOrg, target: string, apiVersion?: string): Promise<ActionSource> {
    const parsed = parseActionTarget(target);
    if (!parsed) throw Error('Only Apex and Flow implementation targets are supported.');
    if (parsed.namespace) return readOrgAction(org, target, this.deps);
    const who = org.alias || org.username;
    const get = orgGetter(org, this.deps);
    const contract = parsed.kind === 'apex' ? get(`/actions/custom/apex/${encodeURIComponent(parsed.name)}`).catch(() => null) : undefined;
    const fresh = await this.freshness(get, parsed);
    const base: ActionSource = { origin: 'org', target, status: 'missing', label: `${who} · ${parsed.kind === 'apex' ? 'Deployed Apex' : fresh?.inactive ? 'Latest Flow (inactive)' : 'Active Flow'}` };
    if (!fresh) return { ...base, message: parsed.kind === 'apex' ? 'No accessible Apex class with this name was found in the org.' : 'No accessible Flow with this name was found in the org.' };
    const version = apiVersion ?? org.apiVersion;
    let content: string | null;
    try { content = await this.content(org, parsed, fresh.stamp, version); }
    catch (error) {
      const fallback = await readOrgAction(org, target, this.deps);
      const note = `Could not retrieve the source (${errorText(error)}). Showing the Tooling API snapshot.`;
      return { ...fallback, message: fallback.message ? `${note} ${fallback.message}` : note };
    }
    if (content === null) return { ...base, status: 'unavailable', message: 'The org returned no source for this component. It may be restricted by permissions.' };
    if (parsed.kind === 'flow') {
      return {
        ...base, status: 'ready', content, language: 'xml',
        ...(fresh.version !== undefined ? { version: fresh.version } : {}),
        ...(fresh.inactive ? { inactive: true, message: `This Flow has no active version. Showing the latest version${fresh.version !== undefined ? ` (v${fresh.version})` : ''}.` } : {}),
      };
    }
    return { ...base, status: 'ready', content, language: 'apex', ...apexContract(await contract!) };
  }

  /** Null when the org has no such component. */
  private async freshness(get: ReturnType<typeof orgGetter>, parsed: ActionTarget): Promise<Freshness | null> {
    if (parsed.kind === 'apex') {
      const json = await get('/tooling/query', { q: `SELECT Id, LastModifiedDate FROM ApexClass WHERE Name = '${parsed.developerName}' AND NamespacePrefix = null LIMIT 1` });
      const row = json.records?.[0];
      return row?.Id ? { stamp: String(row.LastModifiedDate ?? '') } : null;
    }
    const json = await get('/tooling/query', { q: `SELECT Id, LastModifiedDate, ActiveVersion.VersionNumber, LatestVersion.VersionNumber, LatestVersion.LastModifiedDate FROM FlowDefinition WHERE DeveloperName = '${parsed.developerName}' AND NamespacePrefix = null LIMIT 1` });
    const row = json.records?.[0];
    if (!row?.Id) return null;
    const active = typeof row.ActiveVersion?.VersionNumber === 'number' ? row.ActiveVersion.VersionNumber as number : undefined;
    const latest = typeof row.LatestVersion?.VersionNumber === 'number' ? row.LatestVersion.VersionNumber as number : undefined;
    // The Metadata API returns the active version, or the latest one when none is active.
    const version = active ?? latest;
    return { stamp: [row.LastModifiedDate, active, latest, row.LatestVersion?.LastModifiedDate].join('|'), ...(version !== undefined ? { version } : {}), ...(active === undefined ? { inactive: true } : {}) };
  }

  private async content(org: ResolvedOrg, parsed: ActionTarget, stamp: string, apiVersion: string): Promise<string | null> {
    const key = `${org.orgId}:${parsed.kind}:${parsed.developerName}:${apiVersion}`;
    const hit = this.cache.get(key);
    if (hit && hit.stamp === stamp) {
      this.cache.delete(key); this.cache.set(key, hit); // most recently used last
      return hit.content;
    }
    const flight = `${key}\0${stamp}`;
    let running = this.pending.get(flight);
    if (!running) {
      running = this.retrieve(org, parsed, apiVersion).then(content => {
        this.cache.delete(key);
        this.cache.set(key, { stamp, content });
        while (this.cache.size > CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
        return content;
      }).finally(() => this.pending.delete(flight));
      this.pending.set(flight, running);
    }
    return running;
  }

  private async retrieve(org: ResolvedOrg, parsed: ActionTarget, apiVersion: string): Promise<string | null> {
    const type = parsed.kind === 'apex' ? 'ApexClass' : 'Flow';
    const file = parsed.kind === 'apex' ? `classes/${parsed.developerName}.cls` : `flows/${parsed.developerName}.flow-meta.xml`;
    let project: string | undefined;
    try {
      project = await tempProject(apiVersion, 'zcc-sf-source-');
      const { files } = await retrieveInto(this.deps.execSf, project, [`${type}:${parsed.developerName}`], { alias: org.alias || org.username, apiVersion, timeoutMs: RETRIEVE_TIMEOUT });
      const match = files.find(row => row.type === type && (row.rest === file || row.rest.endsWith(`/${file}`)));
      return match ? await readRetrieved(match.path, ACTION_SOURCE_CAP) : null;
    } finally {
      await removeTemp(project);
    }
  }
}
