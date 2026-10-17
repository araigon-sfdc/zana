import type { PluginAgentsViewProps, PluginFleetMember } from '@zana-ai/zcc-plugin-sdk/app';
import type { CityTheme } from './themes.js';
export const CITY_WIDTH = 1120, CITY_HEIGHT = 775, BLOCK = 340;
const STYLES = [
  { color: 'purple', variant: 0 },
  { color: 'blue', variant: 1 },
  { color: 'mint', variant: 2 }
] as const;
export const STATUS_LABELS = { working: 'Working', 'needs-you': 'Needs you', idle: 'Idle', done: 'Done', error: 'Error', unknown: 'Unknown' };
export type StatusFilter = 'all' | keyof typeof STATUS_LABELS;
export function floors(count: number): number { return count <= 1 ? 1 : count < 5 ? 2 : count <= 10 ? 7 : count <= 20 ? 9 : 11; }
export function buildingHeight(count: number): number { return count <= 1 ? 64 : floors(count) * 24 + 52; }
/** Height of the roof line each theme draws; labels, fit and hit targets follow it. */
export function roofHeight(p: { count: number; form: 'house' | 'office' | 'tower' }, theme: CityTheme = 'classic'): number {
  const h = buildingHeight(p.count);
  if (theme === 'sf') return p.form === 'house' ? 100 : p.form === 'office' ? 132 : h + 50;
  if (theme === 'zh') return p.form === 'house' ? 120 : p.form === 'office' ? 118 : h + 28;
  return h;
}
export function buildingForm(count: number) {
  return count <= 1 ? { form: 'house' as const, w: 142, d: 100 }
    : count < 5 ? { form: 'office' as const, w: 160, d: 100 }
      : { form: 'tower' as const, w: 198, d: 130 };
}
export function projectCity(props: Pick<PluginAgentsViewProps, 'projects' | 'members' | 'schedules' | 'executions' | 'searchQuery'>) {
  const groups = new Map<string, PluginFleetMember[]>();
  for (const member of props.members) {
    const list = groups.get(member.projectId) ?? [];
    list.push(member);
    groups.set(member.projectId, list);
  }
  // Keep project order independent of activity; buildings never swap lots on a status change.
  return props.projects.filter((p) => groups.get(p.id)?.some((m) => m.live) || props.schedules.some((s) => s.projectId === p.id))
    .map((p) => {
    const members = groups.get(p.id) ?? [];
    const schedules = props.schedules.filter((s) => s.projectId === p.id);
    return { ...p, members, schedules, count: members.filter((m) => m.live).length,
      working: members.filter((m) => m.status === 'working').length,
      needs: members.filter((m) => m.status === 'needs-you').length };
  });
}
export type CityProject = ReturnType<typeof projectCity>[number];
export type CityBuilding = CityProject & { u: number; v: number; lot: number } & typeof STYLES[number] & ReturnType<typeof buildingForm>;
/** Preserve occupied plots across insertion, reordering and activity changes. Reuse vacant plots. */
export function reconcileLots(previous: ReadonlyMap<string, number>, projects: readonly { id: string }[]): Map<string, number> {
  const ids = new Set(projects.map((p) => p.id));
  const lots = new Map([...previous].filter(([id]) => ids.has(id)));
  const used = new Set(lots.values());
  let next = 0;
  for (const { id } of projects) {
    if (lots.has(id)) continue;
    while (used.has(next)) next++;
    lots.set(id, next); used.add(next);
  }
  return lots;
}
/** Grow square rings, never change column count underneath existing buildings. Plot zero is the park. */
export function gridPlot(index: number) {
  const ring = Math.floor(Math.sqrt(index)), offset = index - ring * ring;
  return offset < ring ? { col: ring, row: offset } : { col: offset - ring, row: ring };
}
export function cityBuildings(projects: CityProject[], lots: ReadonlyMap<string, number>): CityBuilding[] {
  return projects.map((p, i) => {
    const lot = lots.get(p.id) ?? i, { col, row } = gridPlot(lot + 1);
    return { ...p, lot, u: col * BLOCK + 62, v: row * BLOCK + 82, ...STYLES[lot % STYLES.length], ...buildingForm(p.count) };
  });
}
export const projectPoint = (u: number, v: number, z = 0): [number, number] => [(u - v) * .72, (u + v) * .35 - z];
export function cityLayout(buildings: CityBuilding[], viewportWidth = CITY_WIDTH, viewportHeight = CITY_HEIGHT, theme: CityTheme = 'classic') {
  let cols = 2, rows = 1;
  for (const p of buildings) { cols = Math.max(cols, Math.floor(p.u / BLOCK) + 1); rows = Math.max(rows, Math.floor(p.v / BLOCK) + 1); }
  const width = cols * BLOCK + 20, frontage = rows * BLOCK, depth = frontage + 215;
  // Themed cities leave room for their waterfront on the right-hand edge.
  const minX = -depth * .72, maxX = width * .72 + (theme === 'classic' ? 0 : 150), maxY = (width + depth) * .35 + 25;
  let minY = -140;
  for (const p of buildings) minY = Math.min(minY, projectPoint(p.u, p.v, roofHeight(p, theme) + 70)[1]);
  const scale = Math.min((viewportWidth - 48) / (maxX - minX), (viewportHeight - 95) / (maxY - minY));
  return { cols, rows, width, depth, frontage, scale, viewportWidth, viewportHeight, theme,
    x: viewportWidth / 2 - (minX + maxX) / 2 * scale,
    y: 65 + (viewportHeight - 90) / 2 - (minY + maxY) / 2 * scale };
}
export type CityLayout = ReturnType<typeof cityLayout>;
export function labelPosition(p: CityBuilding, layout: CityLayout) {
  const [x, y] = projectPoint(p.u + p.w / 2, p.v + p.d / 2, roofHeight(p, layout.theme) + 48);
  return { left: `${(layout.x + x * layout.scale) / layout.viewportWidth * 100}%`,
    top: `${(layout.y + y * layout.scale) / layout.viewportHeight * 100}%` };
}
export function nextRunLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value)))
    return 'Next run not available';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
