import { z } from 'zod';
import type { PluginApprovalRequest, PluginInvitationDecision, PluginInvitationReason, PluginInvitationState, PluginInvitationStatus, PluginPeerLink, PluginPeerRequest, PluginSdkPeers, ZccPluginApi } from '@zana-ai/zcc-plugin-sdk/server';
import { canonicalPeerHash, PeerProtocolError } from '../shared/peer-contract.js';
import type { GroupRoster, GroupStatus } from '../shared/peer-group.js';
import { PEER_CALL_TIMEOUT_MS, PEER_PENDING_TICK_MS } from '../shared/peer-limits.js';
import { admissionSchema, capacityRequestId, capacitySchema, DesignDocPeerGroup, parseRoster, retirementJobSchema, rosterCovers, type Admission } from './peer-group.js';
import { historicalMembers, isRetiring, ownedSeats, retirementEvidence } from './peer-slots.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/);
const helloSchema = z.object({ repoId: id, replicaId: id, peerId: id, scope: id, roster: z.unknown().nullable() }).strict();
const revokeSchema = z.object({ peerId: id, scope: id }).strict();
const localRevokeSchema = revokeSchema.extend({ localOnly: z.boolean().optional() }).strict();
const receiptSchema = z.object({ requestId: id, stage: z.literal('joining'), roster: z.unknown() }).strict();
const introductionSchema = z.object({ peerId: id, sponsorPeerId: id, scope: id }).strict();

/** Core sees an opaque scope; sorted app identities make control negotiation symmetric. */
export function bootstrapScope(a: string, b: string): string {
  id.parse(a); id.parse(b);
  if (a === b) throw new PeerProtocolError('invalid', 'cannot pair with local app');
  return `bootstrap-${canonicalPeerHash([a, b].sort())}`;
}

export const INVITE_UNSUPPORTED_REASON = 'host cannot invite peers';
const INVITE_METHODS = ['createInvitation', 'redeemInvitation', 'invitationStatus', 'listInvitations', 'invitationApproval', 'decideInvitation', 'cancelInvitation', 'peerLinks', 'reconnectPeer'] as const;
type InviteMethod = typeof INVITE_METHODS[number];
type InvitePeers = PluginSdkPeers & Required<Pick<PluginSdkPeers, InviteMethod>>;
const ACTIVE_INVITATION = new Set<PluginInvitationState>(['open', 'redeeming', 'reserved', 'consented', 'connecting']);
const INVITATION_LIST_LIMIT = 6;
/** Thrown by the core pair store while a link re-key or rotation is in flight; it clears on its own, so it is retried, not shown. */
const TRANSIENT_PEER_ERROR = 'peer enrollment changed or revoked';
const isTransient = (error: unknown): boolean => error instanceof Error && error.message === TRANSIENT_PEER_ERROR;
/** Cap for the follower's backoff between failed probes of an unreachable initiator. */
const FOLLOWER_PROBE_MAX_MS = 5 * 60 * 1000;

/** Invitation UX is gated apart from group sync: older hosts keep syncing an existing group and only lose the new action. */
export function inviteCapability(peers: Pick<PluginSdkPeers, never> | undefined): { available: true } | { available: false; reason: typeof INVITE_UNSUPPORTED_REASON } {
  return peers && INVITE_METHODS.every((method) => typeof (peers as Record<string, unknown>)[method] === 'function')
    ? { available: true }
    : { available: false, reason: INVITE_UNSUPPORTED_REASON };
}

/** What the Peers view may show about an invitation: no token, locator, key or credential. */
export interface InviteItem {
  invitationId: string;
  role: 'inviter' | 'redeemer';
  state: PluginInvitationState;
  reason: PluginInvitationReason | null;
  /** The other computer once discovered; the fingerprint is for out-of-band confirmation. */
  peer: { instanceId: string; name: string; fingerprint: string } | null;
  localFingerprint: string;
  myDecision: PluginInvitationDecision;
  theirDecision: PluginInvitationDecision;
  /** This owner must still decide: the reserved invitation is waiting on them. */
  awaitingMyApproval: boolean;
  expiresAt: number;
  consentExpiresAt: number | null;
}

export interface InviteView {
  available: boolean;
  /** Set when `available` is false: why the new action cannot run on this host. */
  reason: string | null;
  invitations: InviteItem[];
  links: PluginPeerLink[];
  /** The last automatic Enable failure for an invitation-founded peer, shown until it succeeds. */
  enableError: string | null;
  /** Set when the host failed transiently: this is the last good view, with the failure reason (never a secret). */
  stale?: string;
}

interface InviteSnapshot { list: PluginInvitationStatus[]; links: PluginPeerLink[] }

function inviteItem(status: PluginInvitationStatus): InviteItem {
  const inviter = status.role === 'inviter';
  const myDecision = inviter ? status.inviterDecision : status.redeemerDecision;
  return { invitationId: status.invitationId, role: status.role, state: status.state, reason: status.reason ?? null,
    peer: status.peer ? { instanceId: status.peer.instanceId, name: status.peer.name, fingerprint: status.peer.fingerprint } : null,
    localFingerprint: status.localFingerprint, myDecision, theirDecision: inviter ? status.redeemerDecision : status.inviterDecision,
    awaitingMyApproval: status.state === 'reserved' && myDecision === 'pending', expiresAt: status.expiresAt, consentExpiresAt: status.consentExpiresAt ?? null };
}

export class DesignDocPairing {
  private readonly abort = new AbortController();
  private lifecycleWarning: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private enabling: Promise<GroupStatus> | null = null;
  private revoking: Promise<GroupStatus> | null = null;
  private reconciling: Promise<InviteSnapshot | null> | null = null;
  private enableError: string | null = null;
  /** Last non-transient failure of the best-effort auto-enable / grant restore steps; cleared by the next clean pass. */
  private setupError: string | null = null;
  private lastSnapshot: InviteSnapshot | null = null;
  /** The shareable token of this owner's open invitation. The host returns it once, so it lives here (memory only, never logged) until the invitation stops being open. */
  private openInvite: { invitationId: string; token: string; expiresAt: number } | null = null;
  /** Peers the owner disabled locally -> invitations that were ready then. Only a different (new) ready invitation re-pairs them. */
  private readonly disabledPeers = new Map<string, Set<string>>();
  private readyInvitations = new Map<string, string[]>();
  /** Invitation peers this (higher-id) side waits on; see `initiatorReady`. */
  private readonly following = new Map<string, { attempts: number; nextAt: number; scope: string | null; failedAt: string | null }>();
  /** Initiator side: earliest next grant restore per member peer (bounded like `following`). */
  private readonly restoring = new Map<string, number>();

  /**
   * `stateDigest` is an opaque, convergence-stable hash of the local database state; drift checks compare it and never see
   * content. `stateChanged` fires when a peer says its state moved (e.g. after its Sync Now) so the UI can re-check.
   */
  constructor(readonly group: DesignDocPeerGroup, private readonly peers: PluginSdkPeers,
    private readonly hooks: { stateDigest?: () => string | null; stateChanged?: () => void } = {}) {}

  register(zcc: Pick<ZccPluginApi, 'onDispose'>): void {
    this.peers.handle('group-hello', async (request) => {
      this.fence(request);
      z.object({}).strict().parse(request.body);
      const self = id.parse((await this.peers.localIdentity()).id), local = this.group.sync.localRepository()!;
      if (request.scope !== bootstrapScope(self, request.peerId) && request.scope !== local.repoId) {
        throw new PeerProtocolError('invalid', 'database negotiation scope mismatch');
      }
      this.fence(request);
      return { repoId: local.repoId, replicaId: local.replicaId, peerId: self, scope: request.scope, roster: this.group.roster() };
    });
    this.peers.handle('group-join', async (request) => {
      this.fence(request);
      const input = admissionSchema.parse(request.body);
      const self = id.parse((await this.peers.localIdentity()).id);
      if (request.scope !== input.repoId && request.scope !== bootstrapScope(self, request.peerId)) {
        throw new PeerProtocolError('invalid', 'join scope mismatch');
      }
      if (this.group.roster() && !this.group.hasCapacity() && !this.group.containsAdmission(this.group.roster()!, input)) {
        await request.commitSync(() => { this.fence(request); this.group.authorizeSponsor(input, request.peerId); });
        await this.acquireCapacity(input, request);
      }
      return request.commitSync(() => { this.fence(request); return this.group.admit(input, request.peerId); });
    });
    this.peers.handle('group-capacity', (request) => {
      this.fence(request);
      const input = capacitySchema.parse(request.body);
      if (request.scope !== input.repoId) throw new PeerProtocolError('invalid', 'capacity scope mismatch');
      return request.commitSync(() => {
        this.fence(request);
        try { return this.group.transfer(input, request.peerId); }
        catch (error) {
          if (!(error instanceof PeerProtocolError) || error.message !== 'waiting for reserved capacity') throw error;
          // Explicit authenticated refusal is not an unknown commit outcome. Refresh donor state before retrying elsewhere.
          return { requestId: input.requestId, roster: this.group.roster(), unavailable: true };
        }
      });
    });
    this.peers.handle('group-join-receipt', (request) => {
      this.fence(request);
      const input = admissionSchema.parse(request.body);
      if (request.scope !== input.repoId) throw new PeerProtocolError('invalid', 'join receipt scope mismatch');
      return request.commitSync(() => {
        this.fence(request);
        const receipt = this.group.existingReceipt(input, request.peerId);
        if (!receipt) throw new PeerProtocolError('invalid', 'committed admission receipt missing');
        return { receipt, roster: this.group.roster() };
      });
    });
    this.peers.handle('group-roster', async (request) => {
      this.fence(request);
      const roster = parseRoster(request.body);
      if (roster.repoId !== request.scope) throw new PeerProtocolError('invalid', 'roster scope mismatch');
      await request.commitSync(() => {
        this.fence(request);
        if (!this.group.coveredHistoricalAck(roster, request.peerId)) this.group.apply(roster, request.peerId);
        this.group.acknowledgeRoster(roster, request.peerId);
      });
      return { roster: this.group.roster() };
    });
    this.peers.handle('group-retire', (request) => {
      this.fence(request);
      const roster = parseRoster(request.body);
      if (request.scope !== roster.repoId) throw new PeerProtocolError('invalid', 'retirement scope mismatch');
      return request.commitSync(() => { this.fence(request); return { roster: this.group.retire(roster, request.peerId) }; });
    });
    this.peers.handle('group-revoke', async (request) => {
      this.fence(request);
      const input = revokeSchema.parse(request.body);
      const authorize = () => {
        this.fence(request);
        const current = revokeSchema.parse(request.body), roster = this.group.roster();
        if (!roster || !roster.members.some((member) => member.machineId === request.peerId && !isRetiring(roster, member.replicaId)) ||
          input.scope !== roster.repoId || request.scope !== roster.repoId || current.scope !== input.scope || current.peerId !== input.peerId ||
          !historicalMembers(roster).some((member) => member.machineId === input.peerId) ||
          roster.members.some((member) => member.machineId === input.peerId)) throw new PeerProtocolError('invalid', 'removal roster must commit before revocation');
        return roster;
      };
      authorize();
      await request.commitSync(() => {
        const roster = authorize();
        this.group.queueJob(this.group.localPeerId()!, 'local-revoke', roster.rosterEpoch, input);
      });
      return { stage: 'pending' };
    });
    this.peers.handle('state-digest', async (request) => {
      this.fence(request);
      z.object({}).strict().parse(request.body);
      const local = this.group.sync.localRepository()!;
      if (request.scope !== local.repoId) throw new PeerProtocolError('invalid', 'state scope mismatch');
      return { digest: this.hooks.stateDigest?.() ?? null };
    });
    this.peers.handle('state-changed', async (request) => {
      this.fence(request);
      z.object({}).strict().parse(request.body);
      if (request.scope !== this.group.sync.localRepository()!.repoId) throw new PeerProtocolError('invalid', 'state scope mismatch');
      try { this.hooks.stateChanged?.(); } catch { /* a UI nudge must never fail the peer call */ }
      return { ok: true };
    });
    zcc.onDispose(() => {
      this.abort.abort();
      this.openInvite = null;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    });
    this.timer = setInterval(() => { void this.retry().catch(() => {}); void this.invitations().catch(() => {}); }, PEER_PENDING_TICK_MS);
    this.timer.unref();
    void this.retry().catch(() => {});
  }

  /** Invitation flow, one method per owner action. Tokens pass through only `createInvitation`; nothing here logs or stores them. */
  private invitePeers(): InvitePeers {
    const capability = inviteCapability(this.peers);
    if (!capability.available) throw new PeerProtocolError('invalid', capability.reason);
    return this.peers as InvitePeers;
  }

  async inviteState(): Promise<InviteView> {
    const capability = inviteCapability(this.peers);
    if (!capability.available) return { available: false, reason: capability.reason, invitations: [], links: [], enableError: null };
    let snapshot: InviteSnapshot | null, stale: string | undefined;
    try { snapshot = await this.invitations(); }
    catch (error) {
      this.abort.signal.throwIfAborted();
      // A failed read must not blank the Peers view: keep the last good one and say why it is old.
      if (!this.lastSnapshot) throw error;
      snapshot = this.lastSnapshot; stale = this.message(error);
    }
    return { available: true, reason: null, invitations: snapshot?.list.map(inviteItem) ?? [], links: snapshot?.links ?? [],
      enableError: this.enableError ?? this.setupError, ...(stale ? { stale } : {}) };
  }

  /** One in-flight read: refresh redeemer attempts, then act on invitation-founded peers (single consent). */
  private invitations(): Promise<InviteSnapshot | null> {
    if (!inviteCapability(this.peers).available || this.abort.signal.aborted) return Promise.resolve(null);
    if (!this.reconciling) this.reconciling = this.loadInvitations().finally(() => { this.reconciling = null; });
    return this.reconciling;
  }

  private async loadInvitations(): Promise<InviteSnapshot> {
    const peers = this.invitePeers(), signal = this.abort.signal;
    const listed = await peers.listInvitations({ limit: INVITATION_LIST_LIMIT, signal });
    const list = await Promise.all(listed.map((item) => item.role === 'redeemer' && ACTIVE_INVITATION.has(item.state)
      ? peers.invitationStatus({ invitationId: item.invitationId, refresh: true, signal }).catch(() => item) : item));
    const links = await peers.peerLinks({ signal }).catch(() => [] as PluginPeerLink[]);
    this.trackOpenInvite(list);
    this.readyInvitations = new Map();
    for (const item of list) {
      if (item.state === 'ready' && item.peer) this.readyInvitations.set(item.peer.instanceId, [...(this.readyInvitations.get(item.peer.instanceId) ?? []), item.invitationId]);
    }
    const snapshot = { list, links };
    this.lastSnapshot = snapshot;
    // Best effort and independent: a failure of one step (e.g. a re-key in flight) must not fail the read or skip the other, and is retried next tick.
    let failure: unknown = null;
    for (const step of [() => this.autoEnable(list, links), () => this.restoreGrants(list, links)]) {
      try { await step(); } catch (error) { this.abort.signal.throwIfAborted(); if (!isTransient(error)) failure = error; }
    }
    this.setupError = failure ? this.message(failure) : null;
    return snapshot;
  }

  /**
   * A link re-key (Reconnect, the scheduled rotation) revokes every grant on that link, so a member's database grant can
   * vanish after the group formed. The initiator (lower id) re-enables it for a ready, linked, connected member; core
   * imports the new binding on the follower. Bounded: at most one enable per tick, then a per-peer back-off.
   */
  private async restoreGrants(list: PluginInvitationStatus[], links: PluginPeerLink[]): Promise<void> {
    if (this.enabling || this.revoking || this.group.consent()) return;
    const roster = this.group.roster(), local = this.group.sync.localRepository(), self = this.group.localPeerId();
    if (!roster || !local?.groupId || roster.repoId !== local.repoId || !self) return;
    const now = Date.now();
    const due = list.filter((item) => {
      const peerId = item.peer?.instanceId;
      return item.state === 'ready' && !!peerId && self < peerId && !this.disabledPeers.get(peerId)?.has(item.invitationId) &&
        roster.members.some((member) => member.machineId === peerId && !isRetiring(roster, member.replicaId)) &&
        links.some((link) => link.peerInstanceId === peerId && link.phase === 'linked' && link.state === 'connected') &&
        (this.restoring.get(peerId) ?? 0) <= now;
    });
    if (!due.length) return;
    const grants = await this.peers.list({ signal: this.abort.signal });
    for (const item of due) {
      const peerId = item.peer!.instanceId;
      if (grants.some((grant) => grant.id === peerId && grant.scope === roster.repoId)) continue;
      if (this.restoring.size >= INVITATION_LIST_LIMIT) this.restoring.clear();
      this.restoring.set(peerId, now + PEER_PENDING_TICK_MS);
      await this.peers.enable(peerId, { scope: roster.repoId, signal: this.abort.signal }).catch(() => undefined);
      return;
    }
  }

  /**
   * The invitation was the pairing consent. Once it is ready, its link is live and the peer is connected, run the
   * existing mutual-proof `enable` so group-hello / group-join negotiate as before. Removed or disabled links never re-enable.
   */
  private async autoEnable(list: PluginInvitationStatus[], links: PluginPeerLink[]): Promise<void> {
    if (this.enabling || this.revoking || this.group.consent()) return;
    const roster = this.group.roster(), seen = new Set<string>();
    const candidates = list.filter((item) => {
      if (item.state !== 'ready' || !item.peer || !id.safeParse(item.peer.instanceId).success) return false;
      const peerId = item.peer.instanceId;
      if (seen.has(peerId) || !links.some((link) => link.peerInstanceId === peerId && link.phase === 'linked')) return false;
      // An already-enrolled member must not occupy the single enable slot of this tick.
      if (roster?.members.some((member) => member.machineId === peerId && !isRetiring(roster, member.replicaId))) return false;
      // A peer the owner disabled stays off until a newer invitation re-pairs it.
      const disabled = this.disabledPeers.get(peerId);
      if (disabled?.has(item.invitationId)) return false;
      seen.add(peerId);
      return true;
    });
    if (!candidates.length) return;
    const enrolled = await this.peers.enrolled({ signal: this.abort.signal });
    const self = id.parse((await this.peers.localIdentity()).id);
    for (const candidate of candidates) {
      const peerId = candidate.peer!.instanceId;
      if (!enrolled.some((peer) => peer.id === peerId && peer.connected)) continue;
      if (self > peerId && !(await this.initiatorReady(self, peerId, links))) continue;
      if (this.enabling || this.revoking || this.group.consent()) return;
      this.following.delete(peerId);
      this.disabledPeers.delete(peerId);
      void this.enableNow(peerId).then(() => { this.enableError = null; }).catch((error) => { this.enableError = this.message(error); });
      return;
    }
  }

  /** Forget the token once the invitation is no longer open (redeemed, expired, cancelled, gone) so it cannot be re-shown. */
  private trackOpenInvite(list: PluginInvitationStatus[]): void {
    const open = this.openInvite;
    if (!open) return;
    const found = list.find((item) => item.invitationId === open.invitationId);
    if (open.expiresAt <= Date.now() || (found ? found.state !== 'open' : list.length < INVITATION_LIST_LIMIT)) this.openInvite = null;
  }

  /** Re-show the open invitation's token (the host returns it once). Null once it is no longer open. */
  async openInvitation(): Promise<{ invitationId: string; token: string; expiresAt: number } | null> {
    if (!this.openInvite) return null;
    await this.invitations().catch(() => null);
    return this.openInvite;
  }

  /**
   * Both invited machines see the ready invitation at once. If both ran `enable`, each would create its own core link
   * binding for the same scope and every later enable would fail as ambiguous. So the lower instance id initiates and the
   * higher one only answers: it runs the same bilateral `enable` once the initiator's bindings for the bootstrap scope and
   * the database scope already exist, so core reuses them. Waiting never holds a lifecycle lock; the poll tick re-checks,
   * and only a failed remote probe backs off (bounded), so an offline initiator cannot deadlock or flood this side.
   */
  private async initiatorReady(self: string, peerId: string, links: PluginPeerLink[]): Promise<boolean> {
    let wait = this.following.get(peerId);
    if (!wait) {
      if (this.following.size >= INVITATION_LIST_LIMIT) this.following.clear();
      wait = { attempts: 0, nextAt: 0, scope: null, failedAt: null };
      this.following.set(peerId, wait);
    }
    const bootstrap = bootstrapScope(self, peerId);
    const grant = await this.grant(peerId, bootstrap).catch(() => null);
    // A re-key revokes and re-issues grants (new epoch) or replaces the link; the stale-grant window it opens is short, so a
    // failure seen before it must not keep delaying the probe. A genuinely unreachable initiator keeps its own backoff.
    const identity = grant ? `${grant.grantEpoch}:${links.find((link) => link.peerInstanceId === peerId && link.phase === 'linked')?.pairingId ?? ''}` : null;
    if (wait.failedAt !== null && (!identity || identity !== wait.failedAt)) {
      if (identity) { wait.attempts = 0; wait.nextAt = 0; wait.failedAt = null; }
      else wait.failedAt = '';
    }
    if (!identity) return false;
    // A learned database scope is re-read at most once per tick, so a later relabel on the initiator is still followed.
    if (!wait.scope || Date.now() >= wait.nextAt) {
      if (!wait.scope && Date.now() < wait.nextAt) return false;
      try {
        const hello = helloSchema.parse(await this.peers.call(peerId, 'group-hello', {}, this.options(bootstrap)));
        if (hello.peerId !== peerId || hello.scope !== bootstrap) throw new PeerProtocolError('invalid', 'setup peer identity or scope changed');
        const remote = hello.roster === null ? null : parseRoster(hello.roster);
        // Same choice `negotiate` makes on both sides; the initiator enables this scope right after its hello.
        wait.scope = this.group.roster()?.repoId ?? remote?.repoId ?? hello.repoId;
        wait.attempts = 0;
        wait.nextAt = Date.now() + PEER_PENDING_TICK_MS;
      } catch {
        wait.scope = null;
        wait.failedAt = identity;
        wait.attempts = Math.min(wait.attempts + 1, 16);
        wait.nextAt = Date.now() + Math.min(PEER_PENDING_TICK_MS * 2 ** (wait.attempts - 1), FOLLOWER_PROBE_MAX_MS);
        return false;
      }
    }
    return this.hasGrant(peerId, wait.scope);
  }

  private async hasGrant(peerId: string, scope: string): Promise<boolean> {
    return this.grant(peerId, scope).then(() => true, () => false);
  }

  async createInvitation(): Promise<{ invitationId: string; token: string; expiresAt: number }> {
    const peers = this.invitePeers();
    const created = await peers.createInvitation({ scope: this.group.sync.localRepository()!.repoId, signal: this.abort.signal });
    this.openInvite = { invitationId: created.invitationId, token: created.token, expiresAt: created.expiresAt };
    return created;
  }
  async redeemInvitation(token: string): Promise<InviteItem> {
    return inviteItem(await this.invitePeers().redeemInvitation({ token, signal: this.abort.signal }));
  }
  async invitationApproval(invitationId: string): Promise<PluginApprovalRequest> {
    return this.invitePeers().invitationApproval({ invitationId, signal: this.abort.signal });
  }
  /** `approved` carries the single-use owner proof from the approval sheet; `denied` needs none. */
  async decideInvitation(invitationId: string, decision: 'approved' | 'denied', ownerProof?: string): Promise<InviteItem> {
    const peers = this.invitePeers();
    return inviteItem(await peers.decideInvitation({ invitationId, decision, ...(decision === 'approved' ? { ownerProof } : {}), signal: this.abort.signal }));
  }
  async cancelInvitation(invitationId: string): Promise<void> {
    await this.invitePeers().cancelInvitation({ invitationId, signal: this.abort.signal });
    if (this.openInvite?.invitationId === invitationId) this.openInvite = null;
  }
  async reconnect(peerId: string): Promise<PluginPeerLink[]> {
    id.parse(peerId);
    return this.invitePeers().reconnectPeer(peerId, { signal: this.abort.signal });
  }

  /**
   * True only when a connected member's database state differs from this one. Compares opaque digests, so neither a
   * document name, count nor any content crosses the wire or reaches the UI. Unreachable or older peers read as in sync.
   */
  async outOfSync(): Promise<boolean> {
    const digest = this.hooks.stateDigest?.(), local = this.group.sync.localRepository();
    if (!digest || !local) return false;
    for (const machineId of await this.connectedMembers()) {
      try {
        const reply = z.object({ digest: z.string().nullable() }).strict().parse(await this.peers.call(machineId, 'state-digest', {}, this.options(local.repoId)));
        if (reply.digest !== null && reply.digest !== digest) return true;
      } catch { /* unknown is not drift */ }
    }
    return false;
  }

  /** Tell connected members this database just changed (after a Sync Now) so they re-check. Content-free and best effort. */
  async notifyStateChanged(): Promise<void> {
    const local = this.group.sync.localRepository();
    if (!local) return;
    await Promise.all((await this.connectedMembers()).map((machineId) =>
      this.peers.call(machineId, 'state-changed', {}, this.options(local.repoId)).catch(() => undefined)));
  }

  /** Other, non-retiring group members with exactly one connected grant for this group's scope. */
  async connectedMembers(): Promise<string[]> {
    const roster = this.group.roster(), local = this.group.sync.localRepository();
    if (!roster || !local) return [];
    let grants: Awaited<ReturnType<PluginSdkPeers['list']>>;
    try { grants = await this.peers.list({ signal: this.abort.signal }); } catch { return []; }
    return roster.members
      .filter((member) => member.replicaId !== local.replicaId && !isRetiring(roster, member.replicaId))
      .filter((member) => grants.filter((grant) => grant.id === member.machineId && grant.scope === local.repoId && grant.connected).length === 1)
      .map((member) => member.machineId);
  }

  async status(): Promise<GroupStatus> {
    const features = await this.peers.features();
    let peers: Awaited<ReturnType<PluginSdkPeers['list']>> = [], enrolled: Awaited<ReturnType<PluginSdkPeers['enrolled']>> = [];
    let available = features.lifecycle;
    try {
      [peers, enrolled] = await Promise.all([this.peers.list({ signal: this.abort.signal }), this.peers.enrolled({ signal: this.abort.signal })]);
    } catch (error) {
      this.abort.signal.throwIfAborted();
      const reason = error instanceof Error ? error.message : String(error);
      if (reason !== this.lifecycleWarning) console.warn(`[design-docs] peer lifecycle unavailable: ${reason}`);
      this.lifecycleWarning = reason;
      available = false;
    }
    if (available) this.lifecycleWarning = null;
    const local = this.group.sync.localRepository()!, roster = this.group.roster(), consent = this.group.consent();
    return { configured: !!roster && !!local.groupId, repoId: local.repoId, replicaId: local.replicaId, roster,
      members: (roster?.members ?? []).map((member) => {
        const grants = peers.filter((peer) => peer.id === member.machineId && peer.scope === local.repoId);
        const grant = grants.length === 1 ? grants[0] : undefined, self = member.replicaId === local.replicaId;
        const retiring = isRetiring(roster!, member.replicaId);
        return { ...member, retiring, authorized: !retiring && (self || !!grant), connected: self || !!grant?.connected, grantEpoch: grant?.grantEpoch ?? null };
      }), jobs: this.group.jobs().map(({ payload: _payload, ...job }) => job), peers,
      enrolled: enrolled.map(({ id, name, connected }) => ({ id, name, connected })),
      setup: consent ? { peerId: consent.peerId, repoId: consent.repoId, state: consent.state, error: consent.error } : null,
      lifecycleAvailable: available, introductionsAvailable: available && features.introductions, installerAvailable: false };
  }

  /** Explicit owner action: also lifts a local Disable Link. */
  async enable(peerId: string): Promise<GroupStatus> {
    id.parse(peerId);
    this.disabledPeers.delete(peerId);
    return this.enableNow(peerId);
  }

  private async enableNow(peerId: string): Promise<GroupStatus> {
    id.parse(peerId);
    if (this.enabling || this.revoking) return Promise.reject(new PeerProtocolError('conflict', 'database lifecycle action already running'));
    this.enabling = this.negotiate(peerId).finally(() => { this.enabling = null; });
    return this.enabling;
  }

  private async negotiate(peerId: string): Promise<GroupStatus> {
    if (!(await this.peers.features()).lifecycle) throw new PeerProtocolError('invalid', 'core peer lifecycle unavailable');
    const consent = this.group.consent();
    if (consent && consent.peerId !== peerId) throw new PeerProtocolError('conflict', 'another database setup is pending');
    if (consent?.request) { await this.retry(true); return this.status(); }
    const self = id.parse((await this.peers.localIdentity()).id), scope = bootstrapScope(self, peerId);
    const enrolled = await this.peers.enrolled({ signal: this.abort.signal });
    if (!enrolled.some((peer) => peer.id === peerId && peer.connected)) throw new PeerProtocolError('invalid', 'mutually enrolled peer unavailable');
    await this.peers.enable(peerId, { scope, signal: this.abort.signal });
    const before = await this.grant(peerId, scope);
    const hello = helloSchema.parse(await this.peers.call(peerId, 'group-hello', {}, this.options(scope)));
    if (hello.peerId !== peerId || hello.scope !== scope) throw new PeerProtocolError('invalid', 'setup peer identity or scope changed');
    const remote = hello.roster === null ? null : parseRoster(hello.roster), local = this.group.sync.localRepository()!, roster = this.group.roster();
    if (remote && remote.repoId !== hello.repoId) throw new PeerProtocolError('invalid', 'peer database scope mismatch');
    if (remote && roster && remote.groupId !== roster.groupId) throw new PeerProtocolError('conflict', 'cannot combine existing groups');
    const chosen = roster?.repoId ?? remote?.repoId ?? (self < peerId ? local.repoId : hello.repoId);
    await this.sameGrant(peerId, scope, before.grantEpoch);
    this.group.enable(self, peerId, chosen, hello.replicaId);
    try {
      await this.peers.enable(peerId, { scope: chosen, signal: this.abort.signal });
      await this.retry();
    } catch (error) { this.group.setupState('pending', this.message(error)); }
    return this.status();
  }

  async remove(replicaId: string): Promise<GroupStatus> {
    id.parse(replicaId);
    if (!(await this.peers.features()).lifecycle) throw new PeerProtocolError('invalid', 'core peer lifecycle unavailable');
    // Barrier commits first; offline targets stay pending until their committed frontier is sealed.
    this.group.remove(replicaId);
    await this.retry();
    return this.status();
  }

  async revoke(peerId: string): Promise<GroupStatus> {
    id.parse(peerId);
    if (this.revoking) throw new PeerProtocolError('conflict', 'database revocation already running');
    this.revoking = this.disable(peerId).finally(() => { this.revoking = null; });
    return this.revoking;
  }

  private async disable(peerId: string): Promise<GroupStatus> {
    const self = id.parse((await this.peers.localIdentity()).id);
    bootstrapScope(self, peerId);
    const known = new Set(this.readyInvitations.get(peerId) ?? []);
    if (inviteCapability(this.peers).available) {
      const listed = await this.invitePeers().listInvitations({ limit: INVITATION_LIST_LIMIT, signal: this.abort.signal }).catch(() => []);
      for (const item of listed) if (item.state === 'ready' && item.peer?.instanceId === peerId) known.add(item.invitationId);
    }
    this.disabledPeers.set(peerId, known);
    await this.enabling?.catch(() => {});
    await this.running?.catch(() => {});
    const local = this.group.sync.localRepository()!;
    this.group.cancelSetup(peerId);
    this.group.queueJob(self, 'local-revoke', local.rosterEpoch, { peerId, scope: local.repoId, localOnly: true });
    await this.retry(true);
    return this.status();
  }

  retry(force = false): Promise<void> {
    if (force) this.group.retryJobs();
    if (this.running) return this.running;
    this.running = this.work().finally(() => { this.running = null; });
    return this.running;
  }

  private async work(): Promise<void> {
    if (this.abort.signal.aborted) return;
    const consent = this.group.consent();
    if (consent && !this.group.roster() && !this.revoking) {
      try {
        if (!consent.request) {
          // A link re-key (the inviter's first rotation, Reconnect) revokes every grant on it. Only the initiator (lower id)
          // re-creates bindings, the bootstrap one too: the follower answers only once that binding exists, so without it
          // setup never completes. A follower re-creating the database binding at the same time as the initiator (or a
          // sponsor's `restoreSponsorBindings`) would leave two bindings and fail every later enable as ambiguous.
          const self = this.group.localPeerId();
          if (self && self < consent.peerId) {
            await this.peers.enable(consent.peerId, { scope: bootstrapScope(self, consent.peerId), signal: this.abort.signal });
            await this.peers.enable(consent.peerId, { scope: consent.repoId, signal: this.abort.signal });
          }
        }
        const before = await this.grant(consent.peerId, consent.repoId);
        const hello = helloSchema.parse(await this.peers.call(consent.peerId, 'group-hello', {}, this.options(consent.repoId)));
        if (hello.replicaId !== consent.replicaId || hello.repoId !== consent.repoId || hello.peerId !== consent.peerId) {
          throw new PeerProtocolError('invalid', 'waiting for remote database enablement');
        }
        const roster = hello.roster === null ? null : parseRoster(hello.roster), local = this.group.sync.localRepository()!;
        if (!roster && this.group.localPeerId()! < consent.peerId) return;
        const request = this.group.freezeJoin({ requestId: consent.requestId, repoId: consent.repoId, groupId: roster?.groupId ?? null,
          sponsorReplicaId: consent.replicaId, member: { replicaId: local.replicaId, machineId: this.group.localPeerId()!,
            joinedAt: 0, sponsorReplicaId: consent.replicaId } });
        let installed: GroupRoster;
        if (roster && (this.group.containsAdmission(roster, request) || isRetiring(roster, request.sponsorReplicaId))) {
          const result = z.object({ receipt: z.unknown(), roster: z.unknown() }).strict().parse(
            await this.peers.call(consent.peerId, 'group-join-receipt', request, this.options(consent.repoId)));
          const immutable = this.receipt(result.receipt, request);
          installed = parseRoster(result.roster);
          if (!rosterCovers(installed, immutable.roster)) throw new PeerProtocolError('invalid', 'recovery roster does not cover immutable receipt');
        } else {
          const immutable = this.receipt(await this.peers.call(consent.peerId, 'group-join', request, this.options(consent.repoId)), request);
          const result = z.object({ receipt: z.unknown(), roster: z.unknown() }).strict().parse(
            await this.peers.call(consent.peerId, 'group-join-receipt', request, this.options(consent.repoId)));
          const recovered = this.receipt(result.receipt, request);
          installed = parseRoster(result.roster);
          if (recovered.roster.digest !== immutable.roster.digest || !rosterCovers(installed, immutable.roster)) {
            throw new PeerProtocolError('invalid', 'recovery roster does not cover immutable receipt');
          }
        }
        await this.sameGrant(consent.peerId, consent.repoId, before.grantEpoch);
        this.group.apply(installed, consent.peerId);
        this.group.setupState('joining', null);
      } catch (error) { this.group.setupState('pending', this.message(error)); }
    } else if (consent && !consent.request && !this.revoking) await this.restoreSponsorBindings(consent);
    for (const job of this.group.jobs(true)) {
      if (this.abort.signal.aborted) return;
      try {
        const local = this.group.sync.localRepository()!, roster = this.group.roster();
        if (job.kind === 'retire') {
          const input = retirementJobSchema.parse(job.payload);
          if (!roster || input.scope !== roster.repoId) throw new PeerProtocolError('invalid', 'retirement job scope mismatch');
          if (!roster.removals.some((event) => event.replicaId === input.replicaId)) {
            if (roster.closures.some((closure) => closure.replicaId === input.replicaId)) this.group.apply(roster, this.group.localPeerId()!);
            else {
              const before = await this.grant(job.peerId, roster.repoId);
              let delivered = roster;
              if (roster.closures.some((closure) => closure.replicaId === local.replicaId)) {
                const hello = helloSchema.parse(await this.peers.call(job.peerId, 'group-hello', {}, this.options(roster.repoId)));
                if (hello.peerId !== job.peerId || hello.scope !== roster.repoId || hello.repoId !== roster.repoId || hello.replicaId !== input.replicaId) {
                  throw new PeerProtocolError('invalid', 'retirement target identity mismatch');
                }
                delivered = retirementEvidence(roster, parseRoster(hello.roster), local.replicaId);
              }
              const result = z.object({ roster: z.unknown() }).strict().parse(
                await this.peers.call(job.peerId, 'group-retire', delivered, this.options(roster.repoId)));
              const sealed = parseRoster(result.roster);
              if (!rosterCovers(sealed, delivered) || !sealed.closures.some((closure) => closure.replicaId === input.replicaId && closure.admission === input.admission)) {
                throw new PeerProtocolError('invalid', 'retirement ACK missing committed frontier');
              }
              await this.sameGrant(job.peerId, roster.repoId, before.grantEpoch);
              const sender = historicalMembers(roster).find((member) => member.machineId === job.peerId)!;
              const terminal = !roster.members.some((member) => member.replicaId === sender.replicaId) || roster.closures.some((closure) => closure.replicaId === sender.replicaId);
              const evidence = terminal ? retirementEvidence(sealed, roster, sender.replicaId) : sealed;
              this.group.apply(evidence, job.peerId);
            }
          }
          if (!this.group.roster()!.removals.some((event) => event.replicaId === input.replicaId)) throw new PeerProtocolError('invalid', 'waiting for retirement completion');
        } else if (job.kind === 'local-revoke') {
          const input = localRevokeSchema.parse(job.payload);
          if (!input.localOnly && local.groupId && roster?.members.some((member) => member.machineId === input.peerId)) throw new PeerProtocolError('invalid', 'member still in roster');
          if (!input.localOnly && this.group.removalDeliveryPending(input.peerId)) {
            throw new PeerProtocolError('invalid', 'waiting for removal roster delivery before link revocation');
          }
          if (!input.localOnly && roster && (roster.retirements.some((event) => !roster.removals.some((removal) => removal.replicaId === event.replicaId)) ||
            (!local.groupId && this.group.jobs().some((pending) => pending.kind === 'roster' && pending.state !== 'done')))) {
            throw new PeerProtocolError('invalid', 'waiting for authorized retirement evidence delivery before link revocation');
          }
          await this.peers.revoke(input.peerId, { scope: input.scope });
          await this.peers.revoke(input.peerId, { scope: bootstrapScope(job.peerId, input.peerId) });
          await this.revokeInviteLinks(input.peerId, [input.scope, bootstrapScope(job.peerId, input.peerId)]);
        } else if (job.kind === 'revoke') {
          await this.peers.call(job.peerId, 'group-revoke', job.payload, this.options(local.repoId));
        } else if (job.kind === 'introduce') {
          const input = introductionSchema.parse(job.payload);
          if (!roster || local.groupId !== roster.groupId || local.repoId !== roster.repoId || input.scope !== local.repoId ||
            job.peerId !== this.group.localPeerId() ||
            !roster.members.some((member) => member.replicaId === local.replicaId && member.machineId === job.peerId && !isRetiring(roster, member.replicaId)) ||
            !roster.members.some((member) => member.machineId === input.peerId && !isRetiring(roster, member.replicaId)) ||
            !roster.members.some((member) => member.machineId === input.sponsorPeerId && !isRetiring(roster, member.replicaId))) throw new PeerProtocolError('invalid', 'introduction roster changed');
          const result = await this.peers.introduce(input.peerId, { sponsorPeerId: input.sponsorPeerId, scope: input.scope, signal: this.abort.signal });
          if (result.status !== 'complete') throw new PeerProtocolError('invalid', `automatic introduction ${result.status}; Machines installer unavailable`);
        } else {
          const next = parseRoster(job.payload);
          if (!roster || !rosterCovers(roster, next)) throw new PeerProtocolError('invalid', 'roster job not covered locally');
          const before = await this.grant(job.peerId, next.repoId);
          let delivered = next;
          const self = local.replicaId;
          if (roster.closures.some((closure) => closure.replicaId === self)) {
            const hello = helloSchema.parse(await this.peers.call(job.peerId, 'group-hello', {}, this.options(next.repoId)));
            const known = parseRoster(hello.roster);
            if (hello.peerId !== job.peerId || hello.scope !== next.repoId || hello.repoId !== next.repoId ||
              !historicalMembers(roster).some((member) => member.machineId === job.peerId && member.replicaId === hello.replicaId)) {
              throw new PeerProtocolError('invalid', 'retirement delivery peer identity mismatch');
            }
            delivered = retirementEvidence(next, known, self);
          }
          const result = z.object({ roster: z.unknown() }).strict()
            .parse(await this.peers.call(job.peerId, 'group-roster', delivered, this.options(next.repoId)));
          const acknowledged = parseRoster(result.roster);
          if (!rosterCovers(acknowledged, next)) throw new PeerProtocolError('invalid', 'roster ACK does not cover delivered governance');
          await this.sameGrant(job.peerId, next.repoId, before.grantEpoch);
          if (!this.group.coveredHistoricalAck(acknowledged, job.peerId)) this.group.apply(acknowledged, job.peerId);
        }
        this.group.finishJob(job.id);
      } catch (error) { this.group.finishJob(job.id, this.message(error)); }
    }
  }

  /**
   * Sponsor side of a pending admission. A link re-key (the inviter's first rotation, Reconnect) can revoke the bindings
   * the sponsor created in `negotiate` before the newcomer answered. The newcomer joins only once both bindings exist, and
   * when the sponsor is the initiator (lower id) nobody else may re-create them, so without this the admission never
   * starts. Only missing bindings are re-enabled, so a settled setup costs one grant listing per tick.
   */
  private async restoreSponsorBindings(consent: { peerId: string; repoId: string; state: 'pending' | 'joining'; error: string | null }): Promise<void> {
    const roster = this.group.roster(), self = this.group.localPeerId();
    if (!roster || !self || self >= consent.peerId || consent.repoId !== roster.repoId ||
      roster.members.some((member) => member.machineId === consent.peerId)) return;
    try {
      const grants = await this.peers.list({ signal: this.abort.signal });
      for (const scope of [bootstrapScope(self, consent.peerId), consent.repoId]) {
        if (!grants.some((grant) => grant.id === consent.peerId && grant.scope === scope)) {
          await this.peers.enable(consent.peerId, { scope, signal: this.abort.signal });
        }
      }
      if (consent.error) this.group.setupState(consent.state, null);
    } catch (error) { this.group.setupState('pending', this.message(error)); }
  }

  /** An invitation-founded transport link is scoped by its invitation, which may differ from the sync scopes revoked above. */
  private async revokeInviteLinks(peerId: string, done: string[]): Promise<void> {
    if (!inviteCapability(this.peers).available) return;
    const links = await this.invitePeers().peerLinks({ peerId, signal: this.abort.signal }).catch(() => [] as PluginPeerLink[]);
    for (const scope of new Set(links.filter((link) => link.phase !== 'removed').map((link) => link.scope))) {
      if (!done.includes(scope)) await this.peers.revoke(peerId, { scope });
    }
  }

  private receipt(raw: unknown, request: Admission) {
    const receipt = receiptSchema.parse(raw), roster = parseRoster(receipt.roster);
    if (receipt.requestId !== request.requestId || roster.repoId !== request.repoId ||
      (request.groupId && roster.groupId !== request.groupId) ||
      !this.group.containsAdmission(roster, request) || !roster.members.some((member) => member.replicaId === request.member.replicaId)) {
      throw new PeerProtocolError('invalid', 'join receipt identity mismatch');
    }
    return { ...receipt, roster };
  }

  private async grant(peerId: string, scope: string) {
    const grants = (await this.peers.list({ signal: this.abort.signal })).filter((peer) => peer.id === peerId && peer.scope === scope);
    if (grants.length !== 1 || !grants[0]!.connected || !Number.isSafeInteger(grants[0]!.grantEpoch) || grants[0]!.grantEpoch < 1) {
      throw new PeerProtocolError('invalid', 'pair unavailable; automatic introduction pending');
    }
    return grants[0]!;
  }
  private async acquireCapacity(input: Admission, request: PluginPeerRequest): Promise<void> {
    const roster = this.group.roster()!, local = this.group.sync.localRepository()!;
    if (historicalMembers(roster).length >= 8) throw new PeerProtocolError('limit', 'group full (8)');
    const prior = this.group.consent()?.capacity;
    const grants = await this.peers.list({ signal: this.abort.signal });
    const donor = prior ? roster.members.find((member) => member.replicaId === prior.donorReplicaId) :
      [...roster.members].sort((a, b) => a.machineId < b.machineId ? -1 : 1).find((member) =>
        member.replicaId !== local.replicaId && ownedSeats(roster, member.replicaId).length &&
        grants.some((grant) => grant.id === member.machineId && grant.scope === roster.repoId && grant.connected));
    if (!donor) throw new PeerProtocolError('limit', 'waiting for reserved capacity');
    const capacity = await request.commitSync(() => {
      this.fence(request); this.group.authorizeSponsor(input, request.peerId);
      return this.group.freezeCapacity({ requestId: capacityRequestId(input.requestId, donor.replicaId), admissionRequestId: input.requestId,
        repoId: roster.repoId, groupId: roster.groupId, donorReplicaId: donor.replicaId, recipientReplicaId: local.replicaId });
    });
    const before = await this.grant(donor.machineId, roster.repoId);
    const result = z.object({ requestId: id, roster: z.unknown(), unavailable: z.literal(true).optional() }).strict().parse(
      await this.peers.call(donor.machineId, 'group-capacity', capacity, this.options(roster.repoId)));
    const transferred = parseRoster(result.roster);
    if (result.requestId !== capacity.requestId || (!result.unavailable && !transferred.seats.some((seat) => seat.events.some((event) =>
      event.kind === 'transfer' && event.requestId === capacity.requestId && event.ownerReplicaId === donor.replicaId && event.recipientReplicaId === local.replicaId)))) {
      throw new PeerProtocolError('invalid', 'capacity receipt mismatch');
    }
    await this.sameGrant(donor.machineId, roster.repoId, before.grantEpoch);
    await request.commitSync(() => {
      this.fence(request); this.group.authorizeSponsor(input, request.peerId);
      this.group.apply(transferred, donor.machineId); this.group.clearCapacity();
    });
    if (result.unavailable) throw new PeerProtocolError('limit', 'waiting for reserved capacity');
  }
  private async sameGrant(peerId: string, scope: string, epoch: number): Promise<void> {
    if ((await this.grant(peerId, scope)).grantEpoch !== epoch || this.abort.signal.aborted) throw new PeerProtocolError('invalid', 'authorization changed before control ACK');
  }
  private fence(request: PluginPeerRequest): void {
    if (!request.commitSync || !request.signal || request.signal.aborted || this.abort.signal.aborted ||
      !Number.isSafeInteger(request.grantEpoch) || request.grantEpoch < 1 || !id.safeParse(request.scope).success || !id.safeParse(request.peerId).success) {
      throw new PeerProtocolError('invalid', 'matching core peer commit fence required');
    }
  }
  private options(scope: string) { return { scope, signal: this.abort.signal, timeoutMs: PEER_CALL_TIMEOUT_MS }; }
  private message(error: unknown): string { return error instanceof Error ? error.message : 'peer setup failed'; }
}
