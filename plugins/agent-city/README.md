# Agent City

A living isometric city, contributed as **World**, the fourth layout in global and project **Agents** views.

- Only projects with live agents or scheduled plans become buildings. Empty registered projects, exited-only projects and execution summaries alone have no plot. One live agent uses a house with an attached garage; two to four use a small office; five or more use a seven-floor-or-taller tower. Idle agents belong to that live population. Scheduled-only projects keep a starter house. Exited processes do not make buildings grow.
- Working agents light windows and walk; idle citizens gather in the park. Requests are amber and open the existing agent inspector.
- The Scheduler station lists plans and active runs. A plan is never counted as another agent. It follows the host's calendar toggle.
- The Done pavilion contains exited/error sessions. An exit is not a claim that a task succeeded.
- Every populated project appears in one continuous city, fitted to the available map area by default. Roads, plots and the rail line expand as projects arrive. Existing plots stay stable across arrivals, reordering and activity changes while the view is open. Vacant plots are reused.
- Zoom buttons and keyboard +/− enlarge the map; drag or arrow keys pan. Fit city (or Home/0) restores the whole city. Clicking a building opens an enlarged isometric cutaway with the city faintly visible behind it. Back to city or Escape restores the previous map camera and keyboard focus.
- Garages have a workshop, tools, bicycle and coffee corner. Offices have desks and a lounge; towers add a lobby, elevator, office floors and a roof garden. The floor selector explores the building. Named worker buttons and canvas people open the existing agent or schedule inspector, with truthful status labels and harness colors. Exited sessions remain in the complete roster.
- Interiors contain exactly one worker per live agent or non-running schedule plan. Idle agents lounge on the sofa, get coffee and stroll; working, needs-you and scheduled agents stay at desks. Planned workers have a clock badge and a clear Scheduled plan label, and never inflate live counts. A running plan's worker is its live session. Up to four workers appear per floor/page; floor controls, worker pages and the complete roster reach large teams. Furniture, coffee steam and elevator motion remain ambient scenery.
- Full host population keeps buildings, occupied plots and interior workers stable while search highlights matching buildings and filters rosters. On older hosts without `population`, the supplied fleet is already filtered; this search behavior requires an app update.
- Interior seats stay tied to worker identities across ordinary arrivals/departures. Vacancies are reused. Building-tier upgrades and large population contractions deterministically compact seats.
- Amber building beacons remain visible in compact and phone layouts. Floor choices show requests; Find worker and Find next request jump to and highlight the right floor/page. Hovering a person shows its name and status. Clicking a tower elevator or its keyboard-accessible button advances to the next floor.
- The City theme picker switches the artwork between Green city, San Francisco (Salesforce Tower, Victorians, Ferry Building, Salesforce Park, Muni, Caltrain, Golden Gate, fog) and Zürich (Prime Tower, Old Town houses, St. Peter's clock, Hauptbahnhof, Lindenhof, tram, S-Bahn, lake and Alps). Towers, offices and houses still follow the same live counts, landmark clocks show the real time, and lit floors follow working agents. Themes change only illustration, palette and copy; plots, counts, hit targets and rosters stay the same. The choice is saved in the per-tab snapshot.
- A bounded per-tab navigation snapshot restores the building, floor, worker page, pause state, camera and city theme after opening a conversation. Global and project views have separate snapshots; no prompts or fleet records are persisted.
- Project selection, status filters, search, and paginated rosters reach every item, including plans in their owning building. A bounded set of actual citizens retains agent inspection; all agents remain accessible in rosters.
- A proportional crowd (eight miniature employees per live agent, four for a scheduled-only house) commutes along sidewalks from the station and neighborhood bus stops to the owning office door and back. Buses dwell at each stop. Employee shirts use harness colors, with a legend below the map. The crowd is decorative, with a 220-worker city budget shared proportionally across projects. Garage traffic stays light, and towers receive larger crowds.
- Cars, buses, and a train provide ambient motion. They do not claim that a task was launched or a result delivered.
- Motion can be paused; reduced motion is respected. Indoors the exterior is a cached still backdrop. Rendering stops offscreen/hidden and cleans up on unmount or reload.

## Run

The host must include `PluginAppSlots.experimental_agentsView`. This checkout adds that generic slot; the artwork and behavior live entirely in this plugin. Manage the plugin under Plugins → Installed plugins. It contributes no separate navigation page. Older hosts keep it installed, but need an app update before World is available.

From the repository root:

```sh
node packages/plugin-build/scripts/build-app.mjs plugins/agent-city
node packages/cli/dist/bin/zcc plugin install plugins/agent-city
node packages/cli/dist/bin/zcc plugin dev plugins/agent-city --once
```

Open **Agents → World** in an updated Zana build. A source install follows this directory. No credentials, backend polling, databases, or agent launches are added by the plugin.

The repository CLI targets the same running app. Harness names are optional host fleet metadata. For older hosts, the plugin can enrich existing thread members from the host’s reactive sidebar store without polling or adding members; CLI and schedule harness metadata needs the updated host projection.

## Verify

From the repository root:

```sh
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec vitest run plugins/agent-city apps/app/src/plugins/agents-view-model.test.ts packages/domain/src/agents-view.test.ts
pnpm test:e2e -- e2e/agent-city-plugin.spec.ts
```

The E2E uses a private built Electron app and a fake provider, with no model spend. It installs the actual plugin, enters garages, offices and towers, tests floors and planned-only rooms, opens a real thread inspector through a canvas workstation and mobile desk button, restores map navigation, reloads the UI, checks persisted selection and reduced motion, exercises the mobile gateway, then disables and re-enables the plugin.
