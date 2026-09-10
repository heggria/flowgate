import { useEffect, useState } from "react";
export function useResourceSearch(page: string) {
  const [query, setQuery] = useState(
    () => sessionStorage.getItem(`flowgate.search.${page}`) ?? "",
  );
  useEffect(() => {
    sessionStorage.removeItem(`flowgate.search.${page}`);
    const receive = (event: Event) => {
      const entry = (event as CustomEvent).detail;
      if (entry?.page === page) {
        setQuery(entry.query);
        sessionStorage.removeItem(`flowgate.search.${page}`);
      }
    };
    window.addEventListener("flowgate:search", receive);
    return () => window.removeEventListener("flowgate:search", receive);
  }, [page]);
  return [query, setQuery] as const;
}
