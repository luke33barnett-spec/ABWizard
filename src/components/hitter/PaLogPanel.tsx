"use client";

import { useState } from "react";
import { useData } from "@/components/providers/DataProvider";
import { useInspector, ResultBadge } from "@/components/providers/InspectorProvider";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { Card, CardHeader } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { paLogSql } from "@/lib/queries";
import { displayName } from "@/lib/metrics";

const FILTERS = {
  all: "TRUE",
  k: "pa_is_k",
  kl: "pa_is_k_looking",
  hit: "pa_is_hit",
  bb: "pa_is_bb",
  brk3: "pa_max_breaking_streak >= 3",
  long: "pa_pitch_count >= 6",
} as const;
type F = keyof typeof FILTERS;

interface PaRow {
  pa_uid: string;
  game_date: string;
  inning: number | null;
  top_bottom: string | null;
  pitcher_name: string | null;
  pitcher_throws: string | null;
  batter_side: string | null;
  pa_result: string | null;
  pa_final_count: string | null;
  pa_pitch_count: number;
  pa_sequence_full: string | null;
  pa_start_outs: number | null;
  pa_start_base_state: string | null;
  exit_speed: number | null;
}

export function PaLogPanel({ hitter }: { hitter: string }) {
  const { status, where } = useData();
  const { openPa } = useInspector();
  const [f, setF] = useState<F>("all");
  const q = useDuckQuery<PaRow>(status === "ready" ? paLogSql(where, hitter, FILTERS[f]) : null);
  return (
    <Card>
      <CardHeader
        title="Plate appearance log"
        subtitle={`${(q.data ?? []).length} PAs (latest first). Click any PA for the pitch-by-pitch replay.`}
        actions={
          <Segmented
            value={f}
            onChange={setF}
            options={[
              { value: "all", label: "All" },
              { value: "k", label: "K" },
              { value: "kl", label: "Looking K" },
              { value: "hit", label: "Hits" },
              { value: "bb", label: "BB" },
              { value: "brk3", label: "3+ breaking in a row" },
              { value: "long", label: "6+ pitches" },
            ]}
          />
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-xs">
          <thead className="bg-surface-2 text-ink-3">
            <tr>
              <th className="px-3 py-2 font-medium">Date</th>
              <th className="px-3 py-2 font-medium">Inn</th>
              <th className="px-3 py-2 font-medium">Pitcher</th>
              <th className="px-3 py-2 font-medium">Situation</th>
              <th className="px-3 py-2 font-medium">Sequence</th>
              <th className="px-3 py-2 font-medium">Final count</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((r) => (
              <tr key={r.pa_uid} className="cursor-pointer border-t border-line hover:bg-surface-2" onClick={() => openPa(r.pa_uid)}>
                <td className="num px-3 py-1.5 text-ink-2">{r.game_date}</td>
                <td className="num px-3 py-1.5 text-ink-2">
                  {r.top_bottom === "Top" ? "T" : "B"}
                  {r.inning}
                </td>
                <td className="px-3 py-1.5 text-ink-2">
                  {displayName(r.pitcher_name)} <span className="text-ink-3">{r.pitcher_throws}HP</span>
                </td>
                <td className="num px-3 py-1.5 text-ink-3">
                  {r.pa_start_outs ?? "?"} out{r.pa_start_base_state ? ` · ${r.pa_start_base_state}` : ""}
                </td>
                <td className="num max-w-[28rem] truncate px-3 py-1.5 text-ink-2" title={r.pa_sequence_full ?? ""}>
                  {r.pa_sequence_full}
                </td>
                <td className="num px-3 py-1.5 text-ink-2">
                  {r.pa_final_count} <span className="text-ink-3">({r.pa_pitch_count}p)</span>
                </td>
                <td className="px-3 py-1.5">
                  <ResultBadge result={r.pa_result} />
                  {r.exit_speed ? <span className="num ml-1 text-ink-3">{r.exit_speed.toFixed(0)} mph</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.loading ? <div className="skeleton m-4 h-40" /> : null}
      </div>
    </Card>
  );
}
