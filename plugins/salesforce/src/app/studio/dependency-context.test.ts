import { describe, expect, it } from 'vitest';
import { dependencyContext } from '../AgentScriptPanel.js';
import type { AgentAction } from '../../../lib/agent-script-parse.js';
import type { ExplorerNode } from '../../../lib/studio-contract.js';

const node = (usedBy?: string[]) => ({ kind: 'flow', apiName: 'Refund', usedBy } as ExplorerNode);
const call = (target: string) => ({ target } as AgentAction);

describe('dependencyContext', () => {
  it('prefers the open agent, counts its calls and lists the other users', () => {
    const actions = [call('flow://Refund'), call('flow://Refund'), call('apex://X')];
    expect(dependencyContext('flow://Refund', 'flow', 'Refund', [node(['b/Other.agent', 'a/Orders.agent'])], 'a/Orders.agent', actions))
      .toEqual({ path: 'a/Orders.agent', label: 'Orders.agent · 2 actions · +1', title: 'a/Orders.agent\nb/Other.agent' });
    expect(dependencyContext('flow://Refund', 'flow', 'Refund', [], 'a/Orders.agent', [call('flow://Refund')]))
      .toEqual({ path: 'a/Orders.agent', label: 'Orders.agent · 1 action', title: 'a/Orders.agent' });
    expect(dependencyContext('flow://Refund', 'flow', 'Refund', [node(['a/Orders.agent'])], 'a/Orders.agent', []))
      .toEqual({ path: 'a/Orders.agent', label: 'Orders.agent', title: 'a/Orders.agent' });
  });
  it('falls back to the first user and is null when nothing references the target', () => {
    expect(dependencyContext('flow://Refund', 'flow', 'Refund', [node(['b/Other.agent'])], 'a/Orders.agent', []))
      .toEqual({ path: 'b/Other.agent', label: 'Other.agent', title: 'b/Other.agent' });
    expect(dependencyContext('flow://Refund', 'flow', 'Refund', [node(['b/Other.agent'])], null, [call('flow://Refund')])?.path).toBe('b/Other.agent');
    expect(dependencyContext('flow://Refund', 'flow', 'Refund', [node()], null, [])).toBeNull();
    expect(dependencyContext('flow://Refund', 'apex', 'Refund', [node(['b/Other.agent'])], null, [])).toBeNull();
  });
});
