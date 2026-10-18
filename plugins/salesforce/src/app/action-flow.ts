import type { ActionParameter } from '../../lib/agent-action-model.js';

export interface FlowNode { id: string; label: string; kind: string; target?: string; detail: Record<string, unknown> }
export interface FlowEdge { from: string; to: string; label: string; fault: boolean }
/** Flow-level metadata shown in the header; absent when the source does not declare it. */
export interface FlowMeta { processType?: string; triggerType?: string; runInMode?: string; status?: string }
export interface FlowModel { nodes: FlowNode[]; edges: FlowEdge[]; inputs: ActionParameter[]; outputs: ActionParameter[]; truncated: boolean; meta?: FlowMeta }
const NODE_TYPES: Record<string, string> = { start: 'Start', decisions: 'Decision', recordLookups: 'Get records', recordCreates: 'Create records', recordUpdates: 'Update records', recordDeletes: 'Delete records', assignments: 'Assignment', loops: 'Loop', subflows: 'Subflow', actionCalls: 'Action', screens: 'Screen', waits: 'Wait', collectionProcessors: 'Collection', transforms: 'Transform' };
function list(value: unknown): any[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function rec(value: any): Record<string, any> { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

/** DOMParser is inert; reject DTDs and malformed XML before projecting metadata. */
export function flowFromXml(content: string): Record<string, unknown> {
  if (content.length > 750_000 || /<!DOCTYPE|<!ENTITY/i.test(content)) throw Error('This Flow XML cannot be previewed safely.');
  const document = new DOMParser().parseFromString(content, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'Flow') throw Error('The source is not valid Salesforce Flow XML.');
  const convert = (element: Element, depth: number): unknown => {
    if (depth > 40) throw Error('This Flow XML is nested too deeply to preview.');
    if (!element.children.length) return element.textContent ?? '';
    const result: Record<string, unknown> = {};
    for (const child of element.children) {
      const name = child.localName;
      if (['__proto__', 'constructor', 'prototype'].includes(name)) continue;
      const value = convert(child, depth + 1);
      result[name] = name in result ? [...list(result[name]), value] : value;
    }
    return result;
  };
  return convert(document.documentElement, 0) as Record<string, unknown>;
}

export function flowModel(metadata: Record<string, unknown>): FlowModel {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const addEdge = (from: string, connector: any, label: string, fault = false) => {
    if (typeof connector?.targetReference === 'string') edges.push({ from, to: connector.targetReference, label, fault });
  };
  for (const [key, value] of Object.entries(metadata)) {
    for (const item of list(value).map(rec)) {
      if (!NODE_TYPES[key] && !(item.name && ('locationX' in item || 'connector' in item || 'faultConnector' in item))) continue;
      const id = key === 'start' ? '$start' : item.name;
      if (typeof id !== 'string') continue;
      const target = key === 'subflows' && typeof item.flowName === 'string' ? `flow://${item.flowName}` : key === 'actionCalls' && item.actionType === 'apex' && typeof item.actionName === 'string' ? `apex://${item.actionName}` : undefined;
      nodes.push({ id, kind: NODE_TYPES[key] ?? key, label: typeof item.label === 'string' ? item.label : key === 'start' ? 'Start' : id, target, detail: item });
      addEdge(id, item.connector, 'Next');
      addEdge(id, item.faultConnector, 'Fault', true);
      addEdge(id, item.defaultConnector, item.defaultConnectorLabel || 'Default');
      addEdge(id, item.nextValueConnector, 'For each');
      addEdge(id, item.noMoreValuesConnector, 'After last');
      for (const rule of list(item.rules)) addEdge(id, rule?.connector, rule?.label || rule?.name || 'Rule');
    }
  }
  if (metadata.startElementReference && !nodes.some(node => node.id === '$start')) {
    nodes.unshift({ id: '$start', label: 'Start', kind: 'Start', detail: {} });
    addEdge('$start', { targetReference: metadata.startElementReference }, 'Next');
  }
  const variables = list(metadata.variables).map(rec);
  const params = (flag: string): ActionParameter[] => variables.filter(v => v[flag] === true || v[flag] === 'true').slice(0, 250).map(v => ({ name: String(v.name ?? ''), type: `${v.dataType || 'unknown'}${v.isCollection === true || v.isCollection === 'true' ? '[]' : ''}`, description: String(v.description ?? ''), required: false }));
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined;
  const start = rec(metadata.start);
  const meta: FlowMeta = {};
  for (const [key, value] of [['processType', metadata.processType], ['triggerType', start.triggerType], ['runInMode', metadata.runInMode], ['status', metadata.status]] as const) {
    const found = text(value);
    if (found) meta[key] = found;
  }
  return { nodes: nodes.slice(0, 120), edges: edges.slice(0, 300), inputs: params('isInput'), outputs: params('isOutput'), truncated: nodes.length > 120 || edges.length > 300, meta };
}

const PROCESS_TYPES: Record<string, string> = { AutoLaunchedFlow: 'Autolaunched', Flow: 'Screen flow', Workflow: 'Process Builder', InvocableProcess: 'Process Builder', CustomEvent: 'Process Builder', Orchestrator: 'Orchestration', RoutingFlow: 'Omni-Channel routing' };
const TRIGGER_TYPES: Record<string, string> = { RecordBeforeSave: 'Record-triggered', RecordAfterSave: 'Record-triggered', RecordBeforeDelete: 'Record-triggered', Scheduled: 'Scheduled', PlatformEvent: 'Platform event' };
const RUN_MODES: Record<string, string> = { DefaultMode: 'User or system context (default)', SystemModeWithSharing: 'System context with sharing', SystemModeWithoutSharing: 'System context without sharing' };

/** A short type label: the trigger wins over the process type, since every record-triggered Flow is also "autolaunched". */
export function flowTypeLabel(meta: FlowMeta | undefined): string | undefined {
  if (!meta) return undefined;
  return (meta.triggerType && TRIGGER_TYPES[meta.triggerType]) || (meta.processType && (PROCESS_TYPES[meta.processType] ?? meta.processType)) || undefined;
}
export function flowRunModeLabel(meta: FlowMeta | undefined): string | undefined {
  return meta?.runInMode ? RUN_MODES[meta.runInMode] ?? meta.runInMode : undefined;
}

export interface FlowCall { label: string; target?: string }
export interface FlowTouches { reads: string[]; writes: string[]; calls: FlowCall[] }
const WRITE_KINDS = new Set(['Create records', 'Update records', 'Delete records']);

/** What a Flow reads, writes and invokes, from its drawn elements. Record writes through a variable name the variable, not an object. */
export function flowTouches(model: FlowModel): FlowTouches {
  const reads = new Set<string>(), writes = new Set<string>();
  const calls = new Map<string, FlowCall>();
  for (const node of model.nodes) {
    const object = typeof node.detail.object === 'string' && node.detail.object ? node.detail.object : undefined;
    const variable = typeof node.detail.inputReference === 'string' && node.detail.inputReference ? `{!${node.detail.inputReference}}` : undefined;
    if (node.kind === 'Get records' && object) reads.add(object);
    else if (WRITE_KINDS.has(node.kind) && (object || variable)) writes.add((object ?? variable)!);
    else if (node.target) calls.set(node.target, { label: node.target.split('://')[1] ?? node.target, target: node.target });
    else if (node.kind === 'Action' && typeof node.detail.actionName === 'string') {
      const type = typeof node.detail.actionType === 'string' ? node.detail.actionType : 'action';
      calls.set(`${type}:${node.detail.actionName}`, { label: `${node.detail.actionName} (${type})` });
    }
  }
  return { reads: [...reads].sort(), writes: [...writes].sort(), calls: [...calls.values()] };
}

/**
 * Project XML and the org's Tooling JSON spell the same Flow differently (string vs boolean flags, element order),
 * so drift compares the projected structure: elements, connectors and the variable contract.
 */
export function flowSignature(model: FlowModel): string {
  return JSON.stringify([
    model.nodes.map(node => `${node.id}|${node.kind}|${node.label}|${node.target ?? ''}`).sort(),
    model.edges.map(edge => `${edge.from}>${edge.to}|${edge.label}|${edge.fault}`).sort(),
    model.inputs.map(param => `${param.name}:${param.type}`).sort(),
    model.outputs.map(param => `${param.name}:${param.type}`).sort()
  ]);
}

/** Breadth-first levels keep cycles bounded and branches side by side. */
export function flowPositions(model: FlowModel): Map<string, { x: number; y: number }> {
  const levels = new Map<string, number>();
  const known = new Set(model.nodes.map(n => n.id));
  const roots = model.nodes.filter(n => n.id === '$start' || !model.edges.some(e => e.to === n.id)).map(n => n.id);
  const queue = roots.length ? roots : model.nodes.slice(0, 1).map(n => n.id);
  queue.forEach(id => levels.set(id, 0));
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    for (const edge of model.edges.filter(e => e.from === from)) {
      if (known.has(edge.to) && !levels.has(edge.to)) { levels.set(edge.to, levels.get(from)! + 1); queue.push(edge.to); }
    }
  }
  const widths = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  let last = Math.max(0, ...levels.values());
  for (const node of model.nodes) {
    const level = levels.get(node.id) ?? ++last;
    const col = widths.get(level) ?? 0;
    widths.set(level, col + 1);
    positions.set(node.id, { x: 30 + col * 250, y: 25 + level * 126 });
  }
  return positions;
}
