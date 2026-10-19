// Section anchors on /config. A plain module, not settings-panels.tsx: a server
// page importing a value from a "use client" file gets a client reference, not
// the array.
export const SETTINGS_SECTIONS = [
  { id: "profiles", label: "Profiles" },
  { id: "digest", label: "Email digest" },
  { id: "filters", label: "Scan filters" },
  { id: "lanes", label: "Lanes" },
  { id: "preferences", label: "Preferences" },
] as const;
