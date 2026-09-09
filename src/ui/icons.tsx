const paths: Record<string, string> = {
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  connections: "M2 12h4l3-8 6 16 3-8h4",
  nodes: "M4 5h16v5H4z M4 14h16v5H4z M7 7.5h.01 M7 16.5h.01",
  rules: "M6 3v12a4 4 0 0 0 4 4h8 M14 15l4 4-4 4 M6 7h12 M14 3l4 4-4 4",
  network:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
  activity: "M8 3H4v18h16V3h-4 M8 2h8v4H8z M8 11h8 M8 16h6",
  settings: "M4 7h16 M4 17h16 M9 4v6 M15 14v6",
  extensions: "M9 3H3v6h3a3 3 0 0 1 0 6H3v6h6v-3a3 3 0 0 1 6 0v3h6v-6h-3a3 3 0 0 1 0-6h3V3h-6v3a3 3 0 0 1-6 0z",
  search: "M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  refresh: "M20 7V2 M20 7h-5 M20 7a9 9 0 1 0 1 8",
  power: "M12 2v10 M6 5a9 9 0 1 0 12 0",
  down: "M12 3v18 M6 15l6 6 6-6",
  up: "M12 21V3 M6 9l6-6 6 6",
  arrow: "M4 12h16 M14 6l6 6-6 6",
  chevron: "M9 5l7 7-7 7",
  close: "M6 6l12 12 M18 6L6 18",
  sun: "M12 3v1 M12 20v1 M3 12h1 M20 12h1 M5.6 5.6l.7.7 M17.7 17.7l.7.7 M5.6 18.4l.7-.7 M17.7 6.3l.7-.7 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  sidebar: "M3 3h18v18H3z M9 3v18",
};
export function Icon({ name, size = 17 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.network} />
    </svg>
  );
}
