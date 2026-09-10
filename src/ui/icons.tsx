import brand from "../../assets/brand/mark.json";
const paths: Record<string, string> = {
  brand: brand.gate + " " + brand.streams,
  overview: "M4 4h6v7H4z M14 4h6v4h-6z M14 12h6v8h-6z M4 15h6v5H4z",
  connections: "M4 8h12 M13 5l3 3-3 3 M20 16H8 M11 13l-3 3 3 3",
  nodes:
    "M6 4h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M6 15h12a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2z M7.5 7.5h.01 M7.5 17.5h.01",
  rules: "M5 4v12a3 3 0 0 0 3 3h11 M5 8h14 M16 5l3 3-3 3 M16 16l3 3-3 3",
  network:
    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18",
  activity:
    "M8 4h8a3 3 0 0 1 3 3v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a3 3 0 0 1 3-3z M9 4V3h6v3H9V4 M9 11h6 M9 15h4",
  settings: "M4 7h16 M4 17h16 M9 4v6 M15 14v6",
  extensions: "M5 5h5v5H5z M14 5h5v5h-5z M5 14h5v5H5z M16.5 13v7 M13 16.5h7",
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
      strokeWidth={name === "brand" ? brand.strokeWidth : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name] ?? paths.network} />
    </svg>
  );
}
