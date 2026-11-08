import type { ComponentChildren } from "preact";
import type { AgendaResponse, SourceHealth } from "./hub.js";
import { type HubSnapshot, type Poll, useHubPoll } from "./poll.js";
import { useView, type View } from "./view.js";
import { AgentsWidget } from "./widgets/agents.js";
import { AppointmentsWidget } from "./widgets/appointments.js";
import { Banner } from "./widgets/banner.js";
import { HealthWidget } from "./widgets/measurements.js";
import { NeedsYouWidget } from "./widgets/needs-you.js";
import { PapersWidget } from "./widgets/papers.js";
import { SourcesWidget } from "./widgets/sources.js";
import { TodosWidget } from "./widgets/todos.js";

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });

const TABS: Array<{ view: View; href: string; label: string }> = [
  { view: "today", href: "#today", label: "Today" },
  { view: "all", href: "#all", label: "All" },
];

/** What a view shows from its last good read: the hub's clock, the Sources the banner judges, and its widgets. */
interface Page {
  now: string;
  sources: SourceHealth[];
  widgets: ComponentChildren;
}

/** The visible view's page, or null until its first read succeeds. */
function page(view: View, { agenda, all }: Poll): Page | null {
  if (view === "today") return agenda && { now: agenda.now, sources: agenda.staleSources, widgets: <TodayView agenda={agenda} /> };
  return all && { now: all.now, sources: all.sources, widgets: <AllView snapshot={all} /> };
}

/**
 * The dashboard: the view the URL's hash names, fed by one poller that reads only what that
 * view shows; each widget gets its slice plus the hub's `now`.
 */
export function App() {
  const view = useView();
  const poll = useHubPoll(view);
  const shown = page(view, poll);
  const { error } = poll;

  return (
    <div class="shell">
      <header class="masthead">
        <h1>Manaʻo</h1>
        <nav class="tabs" aria-label="Views">
          {TABS.map((tab) => (
            <a key={tab.view} class="tab" href={tab.href} aria-current={tab.view === view ? "page" : undefined}>
              {tab.label}
            </a>
          ))}
        </nav>
        {shown && (
          <p class="today">
            <time dateTime={shown.now}>{DAY_FORMAT.format(new Date(shown.now))}</time>
          </p>
        )}
      </header>
      <Banner sources={shown?.sources ?? []} lastAnswerAt={shown?.now ?? null} error={error} />
      <main class="widgets" aria-busy={!shown && !error}>
        {!shown && !error && <p class="empty">Reading the hub…</p>}
        {shown?.widgets}
      </main>
    </div>
  );
}

/** The Agenda: what is on the user's plate Today, as the hub selected it. */
function TodayView({ agenda }: { agenda: AgendaResponse }) {
  return (
    <>
      <NeedsYouWidget items={agenda.attention} now={agenda.now} />
      <AppointmentsWidget appointments={agenda.appointments} now={agenda.now} agenda />
      <TodosWidget todos={agenda.todos} now={agenda.now} agenda />
    </>
  );
}

/** Everything the hub knows: one widget per kind of Item, the week's Measurements among them, then the Sources' Health. */
function AllView({ snapshot: { now, items, sources, measurements } }: { snapshot: HubSnapshot }) {
  return (
    <>
      <AgentsWidget items={items.filter((i) => i.type === "agent")} now={now} />
      <AppointmentsWidget appointments={items.filter((i) => i.type === "appointment")} now={now} />
      <TodosWidget todos={items.filter((i) => i.type === "todo")} now={now} />
      <HealthWidget measurements={measurements} now={now} />
      <PapersWidget papers={items.filter((i) => i.type === "paper")} now={now} />
      <SourcesWidget sources={sources} now={now} />
    </>
  );
}
