export interface GroupMember {
  replicaId: string;
  machineId: string;
  joinedAt: number;
  sponsorReplicaId: string | null;
}

export interface GroupRoster {
  version: 1;
  repoId: string;
  groupId: string;
  genesis: { founders: GroupMember[]; requestId: string; sponsorReplicaId: string };
  seats: Array<{ seat: number; events: SeatEvent[] }>;
  retirements: RetirementEvent[];
  closures: RetirementClosure[];
  removals: RemovalEvent[];
  rosterEpoch: number;
  digest: string;
  members: GroupMember[];
}

export type SeatEvent = {
  seat: number; requestId: string; ownerReplicaId: string; ownerAdmission: string; parent: string; hash: string;
} & ({ kind: 'admit'; member: GroupMember } | {
  kind: 'transfer'; recipientReplicaId: string; recipientAdmission: string;
});

export interface RemovalEvent {
  requestId: string; actorReplicaId: string; actorAdmission: string;
  replicaId: string; admission: string; closure: string; hash: string;
}

export interface RetirementEvent {
  requestId: string; actorReplicaId: string; actorAdmission: string;
  replicaId: string; admission: string; hash: string;
}

export interface RetirementClosure {
  replicaId: string; admission: string; heads: string[]; hash: string;
}

export interface GroupReceipt {
  requestId: string;
  stage: 'joining' | 'retiring' | 'removed';
  roster: GroupRoster;
}

export interface GroupJob {
  id: string;
  peerId: string;
  kind: 'retire' | 'roster' | 'revoke' | 'introduce' | 'local-revoke';
  rosterEpoch: number;
  state: 'pending' | 'blocked' | 'done';
  attempts: number;
  error: string | null;
}

export interface GroupStatus {
  configured: boolean;
  repoId: string;
  replicaId: string;
  roster: GroupRoster | null;
  members: Array<GroupMember & { retiring: boolean; connected: boolean; authorized: boolean; grantEpoch: number | null }>;
  jobs: GroupJob[];
  peers: Array<{ id: string; name: string; scope: string; connected: boolean; grantEpoch: number }>;
  enrolled: Array<{ id: string; name: string; connected: boolean }>;
  setup: { peerId: string; repoId: string; state: 'pending' | 'joining'; error: string | null } | null;
  lifecycleAvailable: boolean;
  introductionsAvailable: boolean;
  installerAvailable: false;
}
