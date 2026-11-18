"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Activity, Database, LayoutGrid, Loader2, MessageSquareText, Radar } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { DatasetHealthModal } from "@/components/data/DatasetHealthModal";
import { Segmented } from "@/components/ui/segmented";
import { OUR_TEAM_CODE } from "@/lib/filters";
import { displayName } from "@/lib/metrics";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Team", icon: LayoutGrid },
  { href: "/scout", label: "Auto-Scout", icon: Radar },
  { href: "/ask", label: "Ask ABWizard", icon: MessageSquareText },
  { href: "/data", label: "Data", icon: Database },
];

function NavLinks({ pathname }: { pathname: string | null }) {
  return (
    <nav className="flex items-center gap-0.5 overflow-x-auto" aria-label="Main">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname !== null && (href === "/" ? pathname === "/" : pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors",
              active ? "bg-crimson/20 text-ink" : "text-ink-2 hover:bg-surface-3 hover:text-ink",
            )}
          >
            <Icon className="size-4" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function ActiveNav() {
  return <NavLinks pathname={usePathname()} />;
}

function HitterSelect({ current }: { current: string | null }) {
  const { hitters, status } = useData();
  const router = useRouter();
  return (
    <label className="flex min-w-0 items-center gap-2 text-xs text-ink-3">
      <span className="hidden sm:inline">Hitter</span>
      <select
        className="h-8 min-w-0 max-w-[14rem] rounded-md border border-line-strong bg-surface-2 px-2 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-crimson-text"
        value={current ?? ""}
        disabled={status !== "ready" || hitters.length === 0}
        onChange={(e) => e.target.value && router.push(`/hitters/${encodeURIComponent(e.target.value)}`)}
        aria-label="Select hitter"
      >
        <option value="">{hitters.length ? `Select hitter (${hitters.length})` : "No hitters loaded"}</option>
        {hitters.map((h) => (
          <option key={h.batter_name} value={h.batter_name}>
            {displayName(h.batter_name)} · {h.pas} PA
          </option>
        ))}
      </select>
    </label>
  );
}

function RoutedHitterSelect() {
  const pathname = usePathname();
  const m = pathname?.match(/^\/hitters\/([^/]+)/);
  return <HitterSelect current={m ? decodeURIComponent(m[1]) : null} />;
}

function FilterBar() {
  const { filters, setFilters, summary, status, setHealthOpen } = useData();
  const teams = summary?.teams.map((t) => t.batter_team).filter((t): t is string => !!t) ?? [];
  const hasOurTeam = teams.includes(OUR_TEAM_CODE);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-xs text-ink-3 sm:px-6">
      <div className="flex items-center gap-2">
        <span>Batters</span>
        <Segmented
          label="Batter team"
          value={filters.team === "ALL" ? "ALL" : "OURS"}
          onChange={(v) => setFilters({ team: v === "ALL" ? "ALL" : OUR_TEAM_CODE })}
          options={[
            { value: "OURS", label: "Alabama", title: hasOurTeam || !summary ? "BatterTeam = ALA_CRI" : "No ALA_CRI batters in these files" },
            { value: "ALL", label: "All" },
          ]}
        />
      </div>
      <div className="flex items-center gap-2">
        <span>Pitcher</span>
        <Segmented
          label="Pitcher handedness"
          value={filters.pitcherHand}
          onChange={(v) => setFilters({ pitcherHand: v })}
          options={[
            { value: "ALL", label: "All" },
            { value: "R", label: "vs RHP" },
            { value: "L", label: "vs LHP" },
          ]}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span>Dates</span>
        <input
          type="date"
          aria-label="From date"
          value={filters.dateFrom ?? ""}
          min={summary?.minDate ?? undefined}
          max={summary?.maxDate ?? undefined}
          onChange={(e) => setFilters({ dateFrom: e.target.value || null })}
          className="num h-6 rounded border border-line-strong bg-surface-2 px-1.5 text-ink [color-scheme:dark]"
        />
        <span>→</span>
        <input
          type="date"
          aria-label="To date"
          value={filters.dateTo ?? ""}
          min={summary?.minDate ?? undefined}
          max={summary?.maxDate ?? undefined}
          onChange={(e) => setFilters({ dateTo: e.target.value || null })}
          className="num h-6 rounded border border-line-strong bg-surface-2 px-1.5 text-ink [color-scheme:dark]"
        />
      </div>
      <label className="flex items-center gap-1.5">
        <span>Min sample</span>
        <select
          value={filters.minN}
          onChange={(e) => setFilters({ minN: Number(e.target.value) })}
          className="num h-6 rounded border border-line-strong bg-surface-2 px-1 text-ink"
        >
          {[1, 3, 5, 8, 10, 15, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n} pitches
            </option>
          ))}
        </select>
      </label>
      <div className="ml-auto flex items-center gap-2">
        {status === "ready" && summary ? (
          <button type="button" onClick={() => setHealthOpen(true)} className="num inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-ink-2 hover:bg-surface-3 hover:text-ink">
            <Activity className="size-3.5 text-good" aria-hidden />
            {summary.pitches.toLocaleString()} pitches · {summary.pas.toLocaleString()} PA · {summary.games} G
          </button>
        ) : null}
      </div>
    </div>
  );
}

function StatusBanner() {
  const { status, progress, error } = useData();
  if (progress && (status === "booting" || status === "loading" || progress)) {
    return (
      <div className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-1.5 text-xs text-ink-2 sm:px-6" role="status">
        <Loader2 className="size-3.5 animate-spin text-crimson-text" aria-hidden />
        {progress}…
      </div>
    );
  }
  if (status === "error" && error) {
    return (
      <div className="border-b border-critical/40 bg-critical/10 px-4 py-1.5 text-xs text-[#f5a3a3] sm:px-6" role="alert">
        DuckDB error: {error}
      </div>
    );
  }
  return null;
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
          <Link href="/" className="flex items-center gap-2" aria-label="ABWizard home">
            <span className="grid size-7 place-items-center rounded bg-crimson text-sm font-black tracking-tighter text-white">AB</span>
            <span className="text-[15px] font-semibold tracking-tight">
              ABWizard <span className="hidden font-normal text-ink-3 md:inline">· Alabama Baseball</span>
            </span>
          </Link>
          <Suspense fallback={<NavLinks pathname={null} />}>
            <ActiveNav />
          </Suspense>
          <div className="ml-auto min-w-0">
            <Suspense fallback={<HitterSelect current={null} />}>
              <RoutedHitterSelect />
            </Suspense>
          </div>
        </div>
        <FilterBar />
        <StatusBanner />
      </header>
      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5 sm:px-6">{children}</main>
      <DatasetHealthModal />
      <footer className="border-t border-line px-6 py-3 text-[11px] text-ink-3">
        All pitch data stays in this browser (DuckDB-WASM + IndexedDB). Only schema, questions and small result summaries are sent to the AI route.
      </footer>
    </div>
  );
}
