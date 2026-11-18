"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Stat } from "@/components/ui/stat";
import { FIELD_LABELS, KEY_FIELDS } from "@/lib/schema-mapper";
import { displayName } from "@/lib/metrics";
import { OUR_TEAM_CODE } from "@/lib/filters";

/** Feature A: instant Dataset Health & Schema Mapping modal. */
export function DatasetHealthModal() {
  const { healthOpen, setHealthOpen, summary, reports, hitters, filters } = useData();
  return (
    <Dialog open={healthOpen} onOpenChange={setHealthOpen}>
      <DialogContent title="Dataset Health & Schema Mapping" description="What was loaded, how each file's columns were mapped, and what was skipped.">
        <div className="space-y-5 p-5">
          {summary ? (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Pitches" value={summary.pitches.toLocaleString()} />
              <Stat label="Plate appearances" value={summary.pas.toLocaleString()} />
              <Stat label="Games" value={summary.games} />
              <Stat label="Hitters (all)" value={summary.hitters} />
              <Stat label={`${OUR_TEAM_CODE} hitters`} value={summary.ourHitters} />
              <Stat label="Date range" value={<span className="text-sm">{summary.minDate ?? "?"}</span>} sub={`→ ${summary.maxDate ?? "?"}`} />
            </div>
          ) : null}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">Files &amp; column mapping</h3>
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-2 text-ink-3">
                  <tr>
                    <th className="px-3 py-2 font-medium">File</th>
                    <th className="px-3 py-2 font-medium">Format</th>
                    <th className="px-3 py-2 text-right font-medium">Rows → pitches</th>
                    <th className="px-3 py-2 font-medium">Key columns</th>
                    <th className="px-3 py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.map((r) => {
                    const missing = KEY_FIELDS.filter((f) => !r.mapping.mapped[f]);
                    return (
                      <tr key={r.fileName} className="border-t border-line align-top">
                        <td className="max-w-[16rem] truncate px-3 py-2 text-ink" title={r.fileName}>
                          {r.fileName}
                        </td>
                        <td className="px-3 py-2">
                          <Badge tone={r.format === "TrackMan" ? "info" : r.format === "TruMedia" ? "good" : "neutral"}>{r.format}</Badge>
                        </td>
                        <td className="num px-3 py-2 text-right text-ink-2">
                          {r.totalRecords.toLocaleString()} → {r.mappedRows.toLocaleString()}
                          {r.skipped ? <div className="text-warn">{r.skipped} skipped</div> : null}
                        </td>
                        <td className="px-3 py-2">
                          {missing.length === 0 ? (
                            <span className="inline-flex items-center gap-1 text-[#5fd35f]">
                              <CheckCircle2 className="size-3.5" aria-hidden /> all {KEY_FIELDS.length} mapped
                            </span>
                          ) : (
                            <span className="inline-flex items-start gap-1 text-warn">
                              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                              <span>missing: {missing.map((f) => FIELD_LABELS[f] ?? f).join(", ")}</span>
                            </span>
                          )}
                          <details className="mt-1 text-ink-3">
                            <summary className="cursor-pointer select-none">Mapped columns</summary>
                            <ul className="mt-1 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                              {Object.entries(r.mapping.mapped).map(([field, header]) => (
                                <li key={field} className="num truncate">
                                  {header} → <span className="text-ink-2">{field}</span>
                                </li>
                              ))}
                            </ul>
                            {r.mapping.unmapped.length ? <p className="mt-1">Ignored: {r.mapping.unmapped.join(", ")}</p> : null}
                          </details>
                        </td>
                        <td className="px-3 py-2 text-ink-3">
                          {r.error ? <span className="text-[#f08080]">{r.error}</span> : null}
                          <div>Location: {r.units}{r.sideConvention === "flipped" ? ", side flipped to catcher's view (RelSide check)" : r.sideConvention === "assumed-flipped" ? ", side flipped (TrackMan default)" : ""}</div>
                          {Object.entries(r.skipReasons).map(([why, n]) => (
                            <div key={why}>
                              {n} × {why}
                            </div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                  {reports.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-ink-3">
                        No file reports saved for this dataset.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
              Detected hitters {filters.team !== "ALL" ? `(${filters.team})` : "(all teams)"}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {hitters.map((h) => (
                <Badge key={h.batter_name} tone="neutral">
                  {displayName(h.batter_name)} <span className="num text-ink-3">{h.pas} PA</span>
                </Badge>
              ))}
            </div>
            {summary && summary.teams.length > 1 ? (
              <p className="mt-2 text-xs text-ink-3">
                Batter teams in files: {summary.teams.map((t) => `${t.batter_team ?? "unknown"} (${t.pitches.toLocaleString()})`).join(", ")}. Switch the Batters filter to
                “All” to scout opponents.
              </p>
            ) : null}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
