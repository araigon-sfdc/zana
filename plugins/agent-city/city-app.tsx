import { useEffect, useMemo, useRef, useState } from 'react';
import { definePluginApp, experimental_useSidebarThreads, type PluginAgentsViewProps } from '@zana-ai/zcc-plugin-sdk/app';
import { projectCity, cityBuildings, cityLayout, reconcileLots, labelPosition, STATUS_LABELS, nextRunLabel, type StatusFilter } from './model.js';
import { cityStyles } from './styles.js';
import { useCityCanvas } from './use-city.js';
import { useCityCamera } from './use-camera.js';
import { commuterCounts, harnessLegend, withThreadHarnesses } from './commuters.js';
import { buildingInterior, interiorTier, reconcileSeats, workerLocation } from './interior.js';
import { readViewState, saveViewState, type CityViewState } from './view-state.js';
import { InteriorDetails } from './interior-view.js';
import { CITY_THEMES, isCityTheme, type CityTheme } from './themes.js';
const PAGE_SIZE = 40;
export function AgentCity(props: PluginAgentsViewProps) {
  return <CityView key={props.projectId ?? 'global'} {...props}/>;
}
function CityView(props: PluginAgentsViewProps) {
  const scope = props.projectId ?? 'global';
  const [saved] = useState(() => readViewState(scope));
  const population = props.population ?? props;
  const root = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const { threads } = experimental_useSidebarThreads();
  const projectedMembers = useMemo(() => withThreadHarnesses(population.members, threads), [population.members, threads]);
  const projects = useMemo(() => projectCity({ ...props, ...population, members: projectedMembers }), [props.projects, projectedMembers, population.schedules, population.executions]);
  const [selected, setSelected] = useState(saved.selected), [filter, setFilter] = useState<StatusFilter>(saved.filter);
  const [inspecting, setInspecting] = useState(saved.inspecting);
  const [inside, setInside] = useState(saved.inside), [floorChoice, setFloor] = useState<number | undefined>(saved.floor), [deskPage, setDeskPage] = useState(saved.deskPage);
  const [focusedKey, setFocusedKey] = useState(saved.focusedKey), [hovered, setHovered] = useState<string>();
  const returnFocus = useRef<HTMLElement | null>(null), back = useRef<HTMLButtonElement>(null), returning = useRef(false);
  const lotAssignments = useRef(new Map<string, number>());
  lotAssignments.current = reconcileLots(lotAssignments.current, projects);
  const buildings = useMemo(() => cityBuildings(projects, lotAssignments.current), [projects]);
  const harnesses = useMemo(() => harnessLegend(buildings), [buildings]);
  const crowds = useMemo(() => commuterCounts(buildings), [buildings]);
  const seatAssignments = useRef(new Map<string, { tier: string; seats: Map<string, number> }>());
  const seatsByBuilding = useMemo(() => {
    const next = new Map<string, { tier: string; seats: Map<string, number> }>();
    for (const building of buildings) {
      const tier = interiorTier(building), previous = seatAssignments.current.get(building.id);
      next.set(building.id, { tier, seats: reconcileSeats(previous?.tier === tier ? previous.seats : new Map(), building) });
    }
    seatAssignments.current = next; return next;
  }, [buildings]);
  const locations = useMemo(() => new Map(buildings.flatMap((b) => [...seatsByBuilding.get(b.id)!.seats].map(([key, seat]) => [key, { building: b.id, ...workerLocation(b, seat) }] as const))), [buildings, seatsByBuilding]);
  const { camera, dragging, zoomBy, fit, handlers } = useCityCamera(saved.camera);
  const [theme, setTheme] = useState<CityTheme>(saved.theme);
  const [paused, setPaused] = useState(saved.paused), [search, setSearch] = useState(saved.search), [pageChoice, setPage] = useState(saved.page);
  const place = selected === 'all' || selected === 'station' || selected === 'library' || selected === 'attention' ? selected
    : projects.some((p) => p.id === selected) ? selected : 'all';
  const project = projects.find((p) => p.id === place);
  const buildingIndex = buildings.findIndex((p) => p.id === place);
  const interior = useMemo(() => inside && buildingIndex >= 0 ? buildingInterior(buildings[buildingIndex], { floor: floorChoice, page: deskPage, seats: seatsByBuilding.get(place)?.seats, focusedKey }) : undefined,
    [inside, buildingIndex, buildings, floorChoice, deskPage, seatsByBuilding, focusedKey]);
  const interiorId = interior?.building.id;
  useEffect(() => {
    if (interiorId) back.current?.focus({ preventScroll: true });
    else if (returning.current) {
      returning.current = false;
      const label = [...root.current?.querySelectorAll<HTMLElement>('.city-label') ?? []].find((el) => el.dataset.projectId === selected);
      (returnFocus.current?.isConnected ? returnFocus.current : label ?? root.current?.querySelector<HTMLElement>('.city-world'))?.focus({ preventScroll: true });
    }
  }, [interiorId]);
  function leaveBuilding() { returning.current = true; setInside(false); setInspecting(false); }
  useEffect(() => {
    if (!interiorId) return;
    const escape = (event: KeyboardEvent) => {
      // Inspectors live in host portals and may return focus outside the plugin.
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]')) return;
      event.preventDefault(); leaveBuilding();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [interiorId]);
  const snapshot = (focus = focusedKey): CityViewState => ({ selected, inside, floor: interior?.floor.id ?? floorChoice, deskPage: interior?.page ?? deskPage, inspecting, filter, search, page: pageChoice, paused, camera, focusedKey: focus, theme });
  useEffect(() => { saveViewState(scope, snapshot()); }, [scope, selected, inside, floorChoice, deskPage, inspecting, filter, search, pageChoice, paused, camera, focusedKey, theme]);
  useEffect(() => {
    if (focusedKey && !document.querySelector('[role="dialog"], [role="alertdialog"], dialog[open]') && interior?.workers.some((w) => w.occupant.item.key === focusedKey)) root.current?.querySelector<HTMLElement>('.city-workstation[data-highlighted=true]')?.focus({ preventScroll: true });
  }, [focusedKey, interiorId, interior?.floor.id, interior?.page]);
  function inspect(key: string) { setFocusedKey(key); saveViewState(scope, snapshot(key)); props.onInspect(key); }
  function findWorker(key: string) {
    const location = locations.get(key); if (!location) return;
    if (!inside) returnFocus.current = root.current?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    setSelected(location.building); setInside(true); setInspecting(true); setFilter('all'); setSearch(''); setPage(0);
    setFloor(location.floor); setDeskPage(location.page); setFocusedKey(key);
  }
  function select(key: string) {
    if (interior && key.startsWith('city-floor:')) {
      const floor = Number(key.slice(11));
      if (interior.levels.some((f) => f.id === floor)) { setFloor(floor); setDeskPage(0); setFocusedKey(undefined); }
      return;
    }
    if (key === 'all' || key === 'station' || key === 'library' || key === 'attention' || projects.some((p) => p.id === key)) {
      setFocusedKey(undefined);
      setSelected(key);
      setInspecting(true);
      setFilter('all');
      setSearch('');
      setPage(0);
      const entering = projects.some((p) => p.id === key);
      if (entering && !inside) returnFocus.current = root.current?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
      setInside(entering);
      setFloor(undefined);
      setDeskPage(0);
    }
    else
      inspect(key);
  }
  const { available, reduced, viewport } = useCityCanvas(root, canvas, buildings, place, paused, select, interior, setHovered, theme);
  const layout = cityLayout(buildings, viewport.width, viewport.height, theme);
  const counts = useMemo(() => props.members.reduce((acc, m) => ({ ...acc, [m.status]: acc[m.status] + 1 }), { working: 0, 'needs-you': 0, idle: 0, done: 0, error: 0, unknown: 0 }), [props.members]);
  const requests = projectedMembers.filter((m) => m.live && m.status === 'needs-you');
  const attention = requests.length + population.executions.filter((e) => e.needsAttention).length;
  const query = props.searchQuery.trim().toLowerCase();
  const matches = new Set([...props.members, ...props.schedules, ...props.executions].map((m) => m.key));
  const matchingProjects = new Set([...props.members, ...props.schedules, ...props.executions].map((m) => m.projectId));
  const hoverItem = [...projectedMembers, ...population.schedules].find((m) => m.key === hovered);
  const hoverFloor = hovered?.startsWith('city-floor:') ? interior?.levels.find((f) => f.id === Number(hovered.slice(11))) : undefined;
  const nextFloor = interior ? interior.levels[(interior.floor.id + 1) % interior.levels.length] : undefined;
  const buildingRequests = requests.filter((m) => m.projectId === project?.id);
  const members = (place === 'library' ? props.members.filter((m) => !m.live)
    : place === 'attention' ? requests
      : project?.members ?? projectedMembers).filter((m) => (!query || place === 'attention' || matches.has(m.key)) && (filter === 'all' || m.status === filter) && m.title.toLowerCase().includes(search.toLowerCase()));
  const schedules = population.schedules.filter((s) => (!query || matches.has(s.key)) && (!project || s.projectId === project.id) && s.title.toLowerCase().includes(search.toLowerCase()));
  const jobs = population.executions.filter((e) => (!query || place === 'attention' || matches.has(e.key)) && (place === 'attention' ? e.needsAttention : e.projectId === project?.id) && e.title.toLowerCase().includes(search.toLowerCase()));
  const roster = place === 'station' ? schedules.map((s) => ({ key: s.key, title: s.title, status: s.running ? 'working' : 'idle', detail: s.running ? 'Running' : !s.enabled ? 'Paused' : nextRunLabel(s.nextRunAt), meta: props.projects.find((p) => p.id === s.projectId)?.name }))
    : [...members.map((m) => ({ key: m.key, title: m.title, status: m.status, detail: m.detail, meta: `${m.harness ? `${m.harness} · ` : ''}${m.kind === 'thread' ? 'Thread' : 'CLI Agent'}${m.scheduled ? ' · Scheduled' : ''}${m.teamId ? ' · Team' : ''}` })),
      ...(project ? schedules.map((s) => ({ key: s.key, title: s.title, status: s.running ? 'working' : 'idle', detail: s.running ? 'Running' : !s.enabled ? 'Paused' : nextRunLabel(s.nextRunAt), meta: 'Scheduled plan' })) : []),
      ...jobs.map((e) => ({ key: e.key, title: e.title, status: e.needsAttention ? 'needs-you' : 'unknown', detail: `Team run · ${e.state.toLowerCase()}`, meta: 'Execution' }))];
  const pages = Math.max(1, Math.ceil(roster.length / PAGE_SIZE)), page = Math.min(pageChoice, pages - 1);
  const title = place === 'all' ? 'All agents' : place === 'station' ? 'Scheduler station' : place === 'library' ? 'Done pavilion' : place === 'attention' ? 'Needs you' : project?.name ?? 'Your city';
  return <section className="agent-city" ref={root} aria-label="Agent City" data-testid="agent-city" data-city-theme={theme}>
  <style>{cityStyles}</style>
  <div className="city-toolbar">
   <h2>Your agents, a little more alive.</h2>
   <select className="city-control city-project-select" aria-label="Find a project building" value={project?.id ?? ''} onChange={(e) => select(e.target.value)}>
    <option value="" disabled>Find a project…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.count} live{p.schedules.length ? ` · ${p.schedules.length} planned` : ''}</option>)}
   </select>
   <select className="city-control city-theme-select" aria-label="City theme" value={theme} onChange={(e) => { if (isCityTheme(e.target.value)) setTheme(e.target.value); }}>
    {Object.entries(CITY_THEMES).map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
   </select>
   <button type="button" className="city-control" onClick={() => setPaused(!paused)} aria-pressed={paused || reduced} disabled={reduced}>{reduced ? 'Reduced motion' : paused ? 'Resume motion' : 'Pause motion'}</button>
  </div>
  <div className="city-stats" aria-label="Agent status filters">
   <button type="button" className="city-stat" aria-pressed={filter === 'all'} onClick={() => { setInside(false); setInspecting(true); setSelected('all'); setFilter('all'); setPage(0); }}>All <strong>{props.members.length}</strong></button>
   {Object.entries(STATUS_LABELS).map(([status, label]) => <button key={status} type="button" className="city-stat" data-status={status} aria-pressed={filter === status} onClick={() => { setInside(false); setInspecting(true); setSelected('all'); setFilter(status as StatusFilter); setPage(0); }}><i className="city-dot" aria-hidden="true"/>{label} <strong>{counts[status as keyof typeof counts]}</strong></button>)}
   {attention > 0 && <button type="button" className="city-stat city-badge" onClick={() => select('attention')}>Review requests · {attention}</button>}
  </div>
  <div className={`city-layout${inspecting ? ' city-inspecting' : ''}`}>
   <div>
    <div className={`city-world${interior ? ' city-inside' : ''}`} data-interior-workers={interior?.workers.length} data-desk-workers={interior?.workers.filter((w) => w.atDesk).length} data-idle-workers={interior?.workers.filter((w) => !w.atDesk).length} role="group" aria-label={interior ? `${interior.building.name} interior. Select an agent or a floor. Escape returns to the city.` : 'City map. Use plus and minus to zoom, arrow keys to pan, and Home to fit the city.'} tabIndex={0} {...(interior ? {} : handlers)} data-zoomed={!interior && camera.zoom > 1} data-dragging={!interior && dragging}>
     {interior ? <div className="city-interior-head">
       <button type="button" ref={back} className="city-control" onClick={leaveBuilding}>← Back to city</button>
       <div><h3>{interior.building.name}</h3><span>{interior.workers.length} on this floor{interior.pages > 1 ? ' page' : ''} · {interior.building.count} live {interior.building.count === 1 ? 'agent' : 'agents'} in building{interior.building.schedules.filter((s) => !s.running).length > 0 ? ` · ${interior.building.schedules.filter((s) => !s.running).length} planned` : ''}</span></div>
       {buildingRequests.length > 0 && <button type="button" className="city-control city-request-jump" onClick={() => { const index = buildingRequests.findIndex((m) => m.key === focusedKey); findWorker(buildingRequests[(index + 1) % buildingRequests.length].key); }}>Find next request · {buildingRequests.length}</button>}
     </div> : <div className="city-maphead">A living view of your projects<strong>{projects.length} projects · {CITY_THEMES[theme].tagline}</strong></div>}
     <div className="city-maplayer" style={{ transform: interior ? 'none' : `translate(${camera.x}%, ${camera.y}%) scale(${camera.zoom})` }}>
      <canvas ref={canvas} aria-hidden="true"/>
      {!interior && buildings.map((p, i) => <button type="button" key={p.id} data-project-id={p.id} data-search-match={!query || matchingProjects.has(p.id)} data-needs-you={p.needs > 0} data-building-form={p.form} data-commuters={crowds[i]} className={`city-label${buildings.length > 6 ? ' city-label-compact' : ''}`} style={labelPosition(p, layout)} onClick={() => select(p.id)} aria-pressed={place === p.id} aria-label={`${p.name}, ${p.count} live agents, ${p.needs} need you${p.schedules.length ? `, ${p.schedules.length} scheduled plans` : ''}`}>
       {p.needs > 0 && <i className="city-attention-beacon" aria-hidden="true">!</i>}<strong>{p.name}</strong><span>{p.count ? `${p.count} live` : p.schedules.length ? `${p.schedules.length} planned` : `${p.members.length} exited`} {p.needs > 0 && <em>{p.needs} need you</em>}</span>
      </button>)}
     </div>
     {(hoverItem || hoverFloor) && <div className="city-hover" aria-hidden="true">{hoverItem ? `${hoverItem.title} · ${'status' in hoverItem ? STATUS_LABELS[hoverItem.status] : 'Scheduled plan'}` : `Elevator → ${hoverFloor!.label}`}</div>}
     {!available && <div className="city-empty">The city illustration is unavailable. Use the project selector or status filters to explore your agents.</div>}
     {interior ? <div className="city-floorbar">
       {interior.levels.length > 1 ? <label>{interior.building.form === 'tower' ? 'Take the elevator' : 'Explore the building'} <select className="city-control" aria-label="Building floor" value={interior.floor.id} onChange={(event) => { setFloor(Number(event.target.value)); setDeskPage(0); setFocusedKey(undefined); }}>
         {interior.levels.map((f) => <option key={f.id} value={f.id}>{f.label}{f.count ? ` · ${f.count} agents` : ''}{f.planned ? ` · ${f.planned} planned` : ''}{f.needs ? ` · ${f.needs} need you` : ''}</option>)}
       </select></label> : <span>Garage workshop · a little room to build</span>}
       {interior.building.form === 'tower' && <button type="button" className="city-control" aria-label={`Take elevator to ${nextFloor!.label}`} onClick={() => select(`city-floor:${nextFloor!.id}`)}>Elevator ↑</button>}
       {interior.pages > 1 && <div className="city-desk-pages"><button type="button" className="city-control" aria-label="Previous workstations" disabled={interior.page === 0} onClick={() => setDeskPage(interior.page - 1)}>←</button><span>Workers {interior.page + 1} / {interior.pages}</span><button type="button" className="city-control" aria-label="Next workstations" disabled={interior.page === interior.pages - 1} onClick={() => setDeskPage(interior.page + 1)}>→</button></div>}
     </div> : <div className="city-mapfoot"><span>Buildings grow with their teams</span><span>{camera.zoom > 1 ? 'Drag to explore · Home to fit the city' : 'The whole city · zoom in to explore'}</span></div>}
    </div>
    {interior && <InteriorDetails model={interior} onInspect={inspect}/>}
    {harnesses.length > 0 && <div className="city-harnesses" aria-label="Worker colors by harness">{harnesses.map((h) => <span key={h.name}><i style={{ background: h.color }} aria-hidden="true"/>{h.name}</span>)}</div>}
    <div className="city-places">
     <button type="button" className="city-control" onClick={() => select('station')} aria-pressed={place === 'station'}>Scheduler station · {props.schedules.length}</button>
     <button type="button" className="city-control" onClick={() => select('library')} aria-pressed={place === 'library'}>Done pavilion · {props.members.filter((m) => !m.live).length}</button>
     {!interior && <div className="city-camera" role="group" aria-label="Map zoom">
      <button type="button" className="city-control" disabled={camera.zoom <= 1} aria-label="Zoom out" onClick={() => zoomBy(.8)}>−</button>
      <output aria-label="Map zoom level">{Math.round(camera.zoom * 100)}%</output>
      <button type="button" className="city-control" disabled={camera.zoom >= 4} aria-label="Zoom in" onClick={() => zoomBy(1.25)}>+</button>
      <button type="button" className="city-control" onClick={fit}>Fit city</button>
     </div>}
    </div>
   </div>
   {inspecting && <aside className="city-panel" aria-label="Building roster">
    <div className="city-panel-head"><button type="button" className="city-close" aria-label="Close roster" onClick={() => setInspecting(false)}>×</button><h3>{title}</h3><div className="city-muted">{place === 'station' ? (props.includeScheduled ? 'Upcoming plans and active runs' : 'Use the calendar toggle above to include scheduled agents.')
      : place === 'library' ? 'Exited sessions · inspect to check the outcome' : project ? `${project.count} live · ${project.working} working · ${project.needs} need you` : `${roster.length} items`}</div>
     <input className="city-roster-search" aria-label="Search this roster" placeholder="Find an agent or task…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }}/>
    </div>
    <div className="city-roster">
     {roster.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item) => <div className="city-roster-row" key={item.key}><button type="button" className="city-member" data-status={item.status} key={item.key} onClick={() => inspect(item.key)}>
      <i className="city-dot" aria-hidden="true"/><span className="city-member-text"><strong>{item.title}</strong><small>{item.detail}</small><small>{item.meta}</small></span><span aria-hidden="true">↗</span>
     </button>{locations.has(item.key) && <button type="button" className="city-find-worker" aria-label={`Find worker ${item.title}`} title="Find this worker in the building" onClick={() => findWorker(item.key)}>⌖</button>}</div>)}
     {roster.length === 0 && <div className="city-empty">{props.searchQuery || search || filter !== 'all' ? 'No matches in this roster.' : place === 'station' ? 'No schedules to display.' : projects.length === 0 ? 'Your projects will appear here. Start an agent to bring the city to life.' : 'A quiet corner of the city. No agents here yet.'}</div>}
    </div>
    {pages > 1 && <div className="city-pagination"><button type="button" className="city-control" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous roster page">←</button><span>{page + 1} / {pages}</span><button type="button" className="city-control" disabled={page === pages - 1} onClick={() => setPage(page + 1)} aria-label="Next roster page">→</button></div>}
   </aside>}
  </div>
  <div className="city-footer"><span>{projectedMembers.filter((m) => m.live).length} live agents · {projects.length} projects{props.searchQuery ? ' · filtered' : ''}</span><span>{interior ? 'One worker per agent or scheduled plan' : 'City commuters are ambient · rosters show real agents'}</span></div>
 </section>;
}
export default definePluginApp((app) => {
  // Older hosts keep the plugin in the installed catalogue without adding navigation.
  app.slots.experimental_agentsView?.({ id: 'world', title: 'World', icon: 'Building2', component: AgentCity });
});
