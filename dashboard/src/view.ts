import { useEffect, useState } from "preact/hooks";

/** Today (`#today`, and the home, with no hash) renders the Agenda; All (`#all`) every widget. */
export type View = "today" | "all";

const viewOf = (hash: string): View => (hash === "#all" ? "all" : "today");

/** The view the URL's hash names, following it as the tabs or the back button change it. */
export function useView(): View {
  const [view, setView] = useState(() => viewOf(window.location.hash));
  useEffect(() => {
    const onHashChange = () => setView(viewOf(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return view;
}
