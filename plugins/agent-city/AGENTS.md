# Agent City plugin

Ordinary package.json `zcc` plugin, id `agent-city`. The root repository instructions apply.

- `city-app.tsx` registers the World view through `experimental_agentsView`; keep all city-specific artwork and behavior here, never in core.
- `model.ts` derives project populations and stable plots in one continuous city. `scene.js` draws the approved isometric illustration; `scene.d.ts` describes the canvas boundary. `use-city.ts` owns and releases the animation/observer resources.
- `themes.ts` lists the City themes; `theme-scene.js` draws their artwork through a kit passed from `scene.js`. A theme changes only illustration, palette (`--zc-*` overrides in `styles.ts`) and copy, never plots, counts or meaning. Themed lighting must come from real counts. Keep the themed `roofHeight` behind labels, fit and hit rects.
- `interior.ts` assigns exactly one worker per live session or non-running schedule plan to bounded pages and floors; `interior-scene.ts` draws cutaways in the same city animation loop. Interiors have no decorative crowd. Idle agents relax or stroll; working/needs-you/scheduled sessions and clearly labeled plans sit at desks. A running plan is represented by its live session. `interior-view.tsx` exposes real identities and schedule metadata. Preserve the exterior camera on return, keyboard focus, Escape and the complete roster.
- The host supplies scoped fleet projections. Never poll a second source or invent progress, success, agents, cooperation, or schedule fires.
- Decorative commuters may outnumber actual agents, but never enter rosters, status counts, or agent hit targets. Their routes belong to real populated buildings and their shirts use host-supplied harness metadata. Older-host thread metadata may come from the existing reactive sidebar hook, without polling or changing fleet membership.
- Preserve the distinction between an agent session, a schedule plan and an execution summary. Only live members grow a building.
- Keep the complete keyboard-accessible roster available even when the scene caps illustrated citizens.
- `use-camera.ts` owns bounded pan/zoom; all projects fit by default. Never bring back district pagination. Keep canvas hit testing and DOM labels aligned at every camera zoom and viewport size.
- `server.ts` is intentionally empty. This plugin does not need server permissions or backend persistence. `view-state.ts` stores bounded per-tab navigation preferences, separated by project/global scope, without fleet records or prompts.
- Use the commands in README.md. The built bundle is `app.js`; keep it ignored. Tests import the source `city-app.js` resolution so the bundle cannot shadow the source.
- Follow LIVE_TEST.md before claiming live verification. Do not restart the user's active installed app to adopt core changes without considering their running work.

- Prefer optional host `population` for geometry and occupants; filtered records remain search results. Never repopulate a filtered older host from sidebar membership. Reconcile interior seats by identity, prune departed occupants and compact on tier changes or large contractions.
