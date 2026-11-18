"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ArrowLeft, ExternalLink, Route } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { StrikeZoneLegend, StrikeZonePlot, type ColorBy } from "@/components/StrikeZonePlot";
import { useDuckQuery } from "@/hooks/useDuckQuery";
import { PITCH_POINT_COLS, paDetailSql, type PitchPoint } from "@/lib/queries";
import { PITCH_TYPE_NAME, displayName, pct } from "@/lib/metrics";
import { cn } from "@/lib/utils";

export type InspectTarget =
  | { kind: "pa"; paUid: string }
  | {
      kind: "set";
      title: string;
      subtitle?: string;
      /** full WHERE clause selecting the pitches to show */
      where: string;
      /** SQL boolean marking the pitches to emphasize (others dimmed) */
      highlightSql?: string;
      highlightLabel?: string;
    };

interface InspectorCtx {
  openPa: (paUid: string) => void;
  openSet: (t: Omit<Extract<InspectTarget, { kind: "set" }>, "kind">) => void;
}

const Ctx = createContext<InspectorCtx | null>(null);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [stack, setStack] = useState<InspectTarget[]>([]);
  const openPa = useCallback((paUid: string) => setStack((s) => [...s, { kind: "pa", paUid }]), []);
  const openSet = useCallback((t: Omit<Extract<InspectTarget, { kind: "set" }>, "kind">) => setStack([{ kind: "set", ...t }]), []);
  const value = useMemo(() => ({ openPa, openSet }), [openPa, openSet]);
  const top = stack[stack.length - 1];

  return (
    <Ctx.Provider value={value}>
      {children}
      <Dialog open={stack.length > 0} onOpenChange={(o) => !o && setStack([])}>
        {top ? (
          <DialogContent
            side="right"
            title={
              <span className="flex items-center gap-2">
                {stack.length > 1 ? (
                  <Button size="sm" variant="ghost" onClick={() => setStack((s) => s.slice(0, -1))} aria-label="Back">
                    <ArrowLeft aria-hidden /> Back
                  </Button>
                ) : null}
                {top.kind === "pa" ? "PA Sequence Inspector" : top.title}
              </span>
            }
            description={top.kind === "set" ? top.subtitle : "Pitch-by-pitch story of the plate appearance"}
          >
            {top.kind === "pa" ? <PaDetail paUid={top.paUid} /> : <PitchSet target={top} onOpenPa={openPa} />}
          </DialogContent>
        ) : null}
      </Dialog>
    </Ctx.Provider>
  );
}

export function useInspector(): InspectorCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useInspector must be used inside <InspectorProvider>");
  return c;
}

type HlPoint = PitchPoint & { hl: boolean };

function PitchSet({ target, onOpenPa }: { target: Extract<InspectTarget, { kind: "set" }>; onOpenPa: (uid: string) => void }) {
  const [colorBy, setColorBy] = useState<ColorBy>("outcome");
  const [tunnels, setTunnels] = useState(false);
  const sql = `SELECT ${PITCH_POINT_COLS}, coalesce((${target.highlightSql ?? "TRUE"}), FALSE) AS hl
    FROM enriched_pitches WHERE ${target.where} ORDER BY game_date DESC, pa_uid, pa_pitch_seq LIMIT 3000`;
  const { data, loading, error } = useDuckQuery<HlPoint>(sql);
  const pitches = useMemo(() => (data ?? []).filter((p) => p.plate_loc_side !== null && p.plate_loc_height !== null), [data]);
  const pas = useMemo(() => {
    const m = new Map<string, { uid: string; date: string; pitcher: string | null; seq: string | null; result: string | null; hl: number; n: number }>();
    for (const p of data ?? []) {
      const cur = m.get(p.pa_uid) ?? { uid: p.pa_uid, date: p.game_date, pitcher: p.pitcher_name, seq: p.pitch_sequence_str, result: p.pa_result, hl: 0, n: 0 };
      cur.n += 1;
      if (p.hl) cur.hl += 1;
      if ((p.pitch_sequence_str?.length ?? 0) > (cur.seq?.length ?? 0)) cur.seq = p.pitch_sequence_str;
      m.set(p.pa_uid, cur);
    }
    return [...m.values()];
  }, [data]);
  const hlCount = (data ?? []).filter((p) => p.hl).length;

  return (
    <div className="grid gap-5 p-5 lg:grid-cols-[minmax(0,380px)_1fr]">
      <div>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Segmented value={colorBy} onChange={setColorBy} options={[{ value: "outcome", label: "By outcome" }, { value: "group", label: "By pitch group" }]} size="xs" />
          <button type="button" onClick={() => setTunnels((t) => !t)} className={cn("inline-flex h-6 items-center gap-1 rounded border px-2 text-[11px]", tunnels ? "border-crimson-text text-ink" : "border-line-strong text-ink-2")} aria-pressed={tunnels}>
            <Route className="size-3" aria-hidden /> Show previous pitch tunnel vectors
          </button>
        </div>
        {loading ? <div className="skeleton aspect-[4/5] w-full" /> : <StrikeZonePlot pitches={pitches} colorBy={colorBy} showTunnels={tunnels} highlight={target.highlightSql ? (p) => (p as HlPoint).hl : undefined} onPitchClick={(p) => onOpenPa(p.pa_uid)} />}
        <div className="mt-2">
          <StrikeZoneLegend colorBy={colorBy} />
        </div>
      </div>
      <div className="min-w-0">
        {error ? <p className="text-sm text-[#f08080]">{error}</p> : null}
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <Badge tone="neutral" className="num">n = {(data ?? []).length} pitches across {pas.length} PAs</Badge>
          {target.highlightSql ? (
            <Badge tone="crimson" className="num">
              {target.highlightLabel ?? "Highlighted"}: {hlCount}/{(data ?? []).length} ({pct((data ?? []).length ? hlCount / (data ?? []).length : null)})
            </Badge>
          ) : null}
        </div>
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-ink-3">Plate appearances — click to replay</h3>
        <ul className="divide-y divide-line rounded-md border border-line">
          {pas.slice(0, 200).map((pa) => (
            <li key={pa.uid}>
              <button type="button" onClick={() => onOpenPa(pa.uid)} className="w-full px-3 py-2 text-left hover:bg-surface-2">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="num text-ink-2">
                    {pa.date} · vs {displayName(pa.pitcher)}
                  </span>
                  <ResultBadge result={pa.result} />
                </div>
                <div className="num mt-0.5 truncate text-[11px] text-ink-3">{pa.seq}</div>
              </button>
            </li>
          ))}
          {!loading && pas.length === 0 ? <li className="px-3 py-4 text-center text-xs text-ink-3">No pitches match.</li> : null}
        </ul>
      </div>
    </div>
  );
}

export function ResultBadge({ result }: { result: string | null }) {
  if (!result) return null;
  const tone = ["Single", "Double", "Triple", "HomeRun"].includes(result) ? "good" : result === "Strikeout" ? "critical" : result === "Walk" || result === "HitByPitch" ? "info" : "neutral";
  return <Badge tone={tone}>{result === "HomeRun" ? "Home Run" : result}</Badge>;
}

type DetailRow = PitchPoint & {
  balls: number;
  strikes: number;
  outs: number | null;
  base_state: string | null;
  top_bottom: string | null;
  game_id: string;
  spin_rate: number | null;
  induced_vert_break: number | null;
  horz_break: number | null;
  loc_vertical: string | null;
  loc_horizontal_rel: string | null;
  velo_delta_from_prev: number | null;
  pa_pitch_count: number;
  is_pa_terminal_pitch: boolean;
};

const CALL_LABEL: Record<string, string> = {
  BallCalled: "Ball",
  StrikeCalled: "Called strike",
  StrikeSwinging: "Swinging strike",
  FoulBall: "Foul",
  InPlay: "In play",
  HitByPitch: "HBP",
};

function PaDetail({ paUid }: { paUid: string }) {
  const { data, loading, error } = useDuckQuery<DetailRow>(paDetailSql(paUid));
  const rows = data ?? [];
  const first = rows[0];
  const plotted = rows.filter((r) => r.plate_loc_side !== null && r.plate_loc_height !== null);
  if (loading) return <div className="skeleton m-5 h-80" />;
  if (error) return <p className="p-5 text-sm text-[#f08080]">{error}</p>;
  if (!first) return <p className="p-5 text-sm text-ink-3">PA not found in the current dataset.</p>;
  return (
    <div className="space-y-4 p-5">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-semibold text-ink">{displayName(first.batter_name)}</span>
        <span className="text-ink-3">({first.batter_side}HH)</span>
        <span className="text-ink-3">vs</span>
        <span className="text-ink">{displayName(first.pitcher_name)}</span>
        <span className="text-ink-3">({first.pitcher_throws}HP)</span>
        <ResultBadge result={first.pa_result} />
      </div>
      <div className="num flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        <span>{first.game_date}</span>
        <span>
          {first.top_bottom} {first.inning}
        </span>
        <span>{first.outs ?? "?"} out</span>
        {first.base_state ? <span>Bases {first.base_state}</span> : null}
        <span>{first.pa_pitch_count} pitches</span>
      </div>
      <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="Pitch sequence">
        {rows.map((r, i) => (
          <li key={r.pitch_uid} className="flex items-center gap-1">
            {i > 0 ? <span className="text-ink-3">→</span> : null}
            <span className="num rounded border border-line-strong bg-surface-2 px-1.5 py-0.5 text-ink-2">
              {r.pa_pitch_seq}. {r.pitch_type ?? "??"} <span className="text-ink-3">{CALL_LABEL[r.pitch_call] ?? r.pitch_call}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,340px)_1fr]">
        <div>
          <StrikeZonePlot pitches={plotted} colorBy="group" numbered />
          <div className="mt-2">
            <StrikeZoneLegend colorBy="group" />
          </div>
        </div>
        <div className="min-w-0 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-ink-3">
              <tr className="border-b border-line">
                <th className="py-1.5 pr-2 font-medium">#</th>
                <th className="py-1.5 pr-2 font-medium">Count</th>
                <th className="py-1.5 pr-2 font-medium">Pitch</th>
                <th className="py-1.5 pr-2 text-right font-medium">Velo</th>
                <th className="py-1.5 pr-2 text-right font-medium">Δ prev</th>
                <th className="py-1.5 pr-2 font-medium">Location</th>
                <th className="py-1.5 pr-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pitch_uid} className="border-b border-line/60">
                  <td className="num py-1.5 pr-2 text-ink-3">{r.pa_pitch_seq}</td>
                  <td className="num py-1.5 pr-2 text-ink">{r.count_str}</td>
                  <td className="py-1.5 pr-2 text-ink">{r.pitch_type ? PITCH_TYPE_NAME[r.pitch_type] ?? r.pitch_type : "—"}</td>
                  <td className="num py-1.5 pr-2 text-right text-ink-2">{r.rel_speed?.toFixed(1) ?? "—"}</td>
                  <td className="num py-1.5 pr-2 text-right text-ink-3">{r.velo_delta_from_prev !== null ? `${r.velo_delta_from_prev > 0 ? "+" : ""}${r.velo_delta_from_prev.toFixed(1)}` : ""}</td>
                  <td className="py-1.5 pr-2 text-ink-2">
                    {r.loc_vertical && r.loc_horizontal_rel ? `${r.loc_vertical}-${r.loc_horizontal_rel}` : "—"}
                    {r.in_zone === false ? <span className="text-ink-3"> (out)</span> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-ink-2">
                    {CALL_LABEL[r.pitch_call] ?? r.pitch_call}
                    {r.play_result ? <span className="text-ink"> → {r.play_result}</span> : null}
                    {r.exit_speed ? <span className="num text-ink-3"> · {r.exit_speed.toFixed(0)} mph</span> : null}
                    {r.video_url ? (
                      /^https?:\/\//.test(r.video_url) ? (
                        <a href={r.video_url} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 text-crimson-text hover:underline">
                          video <ExternalLink className="size-3" aria-hidden />
                        </a>
                      ) : (
                        <span className="ml-1 rounded border border-line-strong px-1 text-[10px] text-ink-3" title={`Clip ID from the export: ${r.video_url}`}>
                          clip
                        </span>
                      )
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
