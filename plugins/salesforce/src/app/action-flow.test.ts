/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { flowFromXml, flowModel, flowPositions, flowRunModeLabel, flowSignature, flowTouches, flowTypeLabel } from './action-flow.js';
import { ACTION_FLOW, ACTION_FLOW_XML } from '../action-fixtures.js';

describe('Flow implementation model', () => {
  it('projects XML and Tooling metadata into the same branches, faults, dependencies and variables', () => {
    const local = flowModel(flowFromXml(ACTION_FLOW_XML));
    const remote = flowModel(ACTION_FLOW);
    expect({ ...local, nodes: local.nodes.map(({ detail, ...node }) => node) }).toEqual({ ...remote, nodes: remote.nodes.map(({ detail, ...node }) => node) });
    expect(local.edges).toContainEqual({ from: 'FindOrder', to: 'LogError', label: 'Fault', fault: true });
    expect(local.edges).toContainEqual({ from: 'Eligible', to: 'Decline', label: 'Outside return window', fault: false });
    expect(local.nodes.find(n => n.id === 'LogError')?.target).toBe('apex://OrderLookup');
    expect(local.nodes.find(n => n.id === 'CreateReturn')?.target).toBe('flow://CreateReturn');
    expect(local.inputs).toMatchObject([{ name: 'orderId', type: 'String' }]);
    expect(local.outputs).toMatchObject([{ name: 'eligible', type: 'Boolean' }]);
    expect(flowPositions(local).size).toBe(6);
  });
  it('retains unfamiliar nodes and bounded loops without inventing execution order', () => {
    const model = flowModel({ startElementReference: 'Loop', loops: { name: 'Loop', nextValueConnector: { targetReference: 'Future' }, noMoreValuesConnector: { targetReference: 'End' } }, futureNodes: { name: 'Future', locationX: 10, connector: { targetReference: 'Loop' } }, assignments: [{ name: 'End' }, { name: 'Disconnected' }], variables: [{ name: 'list', dataType: 'String', isInput: 'true', isCollection: 'true' }] });
    expect(model.nodes.find(n => n.id === 'Future')?.kind).toBe('futureNodes');
    expect(model.edges.map(e => e.label)).toContain('For each');
    expect(model.inputs[0].type).toBe('String[]');
    expect(flowPositions(model).size).toBe(5);
    expect(flowPositions({ ...model, nodes: model.nodes.filter(n => ['Loop', 'Future'].includes(n.id)) }).size).toBe(2);
    expect(flowModel({ assignments: Array.from({ length: 130 }, (_, i) => ({ name: 'a' + i })) }).truncated).toBe(true);
    expect(flowModel({})).toEqual({ nodes: [], edges: [], inputs: [], outputs: [], truncated: false, meta: {} });
  });
  it('summarises type, run mode, touches and a format-independent signature', () => {
    const local = flowModel(flowFromXml(ACTION_FLOW_XML)), remote = flowModel(ACTION_FLOW);
    expect(local.meta).toEqual({ processType: 'AutoLaunchedFlow' });
    expect(flowTypeLabel(local.meta)).toBe('Autolaunched');
    expect(flowTypeLabel({ processType: 'AutoLaunchedFlow', triggerType: 'RecordAfterSave' })).toBe('Record-triggered');
    expect(flowTypeLabel({ processType: 'Custom' })).toBe('Custom');
    expect(flowTypeLabel({})).toBeUndefined(); expect(flowTypeLabel(undefined)).toBeUndefined();
    expect(flowRunModeLabel({ runInMode: 'SystemModeWithoutSharing' })).toBe('System context without sharing');
    expect(flowRunModeLabel({ runInMode: 'Other' })).toBe('Other'); expect(flowRunModeLabel(undefined)).toBeUndefined();
    expect(flowModel({ processType: 'AutoLaunchedFlow', runInMode: 'DefaultMode', status: 'Active', start: { triggerType: 'Scheduled' } }).meta).toEqual({ processType: 'AutoLaunchedFlow', runInMode: 'DefaultMode', status: 'Active', triggerType: 'Scheduled' });
    expect(flowTouches(local)).toEqual({ reads: ['Order'], writes: [], calls: [{ label: 'CreateReturn', target: 'flow://CreateReturn' }, { label: 'OrderLookup', target: 'apex://OrderLookup' }] });
    expect(flowTouches(flowModel({
      recordCreates: [{ name: 'c', object: 'Case' }], recordUpdates: [{ name: 'u', inputReference: 'order' }], recordDeletes: [{ name: 'd' }], recordLookups: [{ name: 'g' }],
      actionCalls: [{ name: 'e', actionName: 'emailSimple', actionType: 'emailSimple' }, { name: 'q', actionName: 'notify' }, { name: 'z' }]
    }))).toEqual({ reads: [], writes: ['Case', '{!order}'], calls: [{ label: 'emailSimple (emailSimple)' }, { label: 'notify (action)' }] });
    expect(flowSignature(local)).toBe(flowSignature(remote));
    expect(flowSignature({ ...remote, nodes: remote.nodes.slice(1) })).not.toBe(flowSignature(remote));
  });
  it('refuses malformed, oversized, DTD and deeply nested XML', () => {
    for (const xml of ['<x/>', '<Flow>', '<!DOCTYPE Flow><Flow/>', '<!ENTITY x "secret"><Flow/>', 'x'.repeat(750001), '<Flow>' + '<x>'.repeat(45) + '</x>'.repeat(45) + '</Flow>']) expect(() => flowFromXml(xml)).toThrow();
    expect(flowFromXml('<Flow><__proto__>bad</__proto__><label>Good</label></Flow>')).toEqual({ label: 'Good' });
  });
});
