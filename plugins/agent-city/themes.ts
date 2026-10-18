/** City artwork themes. Only illustration, palette and copy change; projects, counts and meaning stay identical. */
export const CITY_THEMES = {
  classic: { label: 'Green city', tagline: 'one city', commons: 'THE COMMONS', lots: [] as string[] },
  sf: { label: 'San Francisco', tagline: 'one city by the Bay', commons: 'SALESFORCE PARK', lots: ['#e8a3b5', '#b6d6c8', '#c9b7e3', '#f0d488', '#9fc3e6'] },
  zh: { label: 'Zürich', tagline: 'one city on the lake', commons: 'LINDENHOF', lots: ['#f1e2c0', '#e9b9a3', '#cfdcc1', '#f0d79c', '#d6dfe9'] }
};
export type CityTheme = keyof typeof CITY_THEMES;
export const isCityTheme = (value: unknown): value is CityTheme => typeof value === 'string' && Object.hasOwn(CITY_THEMES, value);
