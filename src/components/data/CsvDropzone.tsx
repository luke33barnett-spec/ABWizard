"use client";

import { useRef, useState } from "react";
import { FileSpreadsheet, Sparkles, Upload } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CsvDropzone({ compact = false }: { compact?: boolean }) {
  const { loadFiles, loadDemo, status } = useData();
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = status === "booting" || status === "loading";

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!busy) void loadFiles(Array.from(e.dataTransfer.files));
      }}
      className={cn(
        "rounded-lg border-2 border-dashed text-center transition-colors",
        compact ? "px-4 py-4" : "px-6 py-10",
        over ? "border-crimson-text bg-crimson/10" : "border-line-strong bg-surface",
      )}
    >
      <FileSpreadsheet className={cn("mx-auto text-ink-3", compact ? "size-6" : "size-9")} aria-hidden />
      <p className={cn("mt-2 font-medium text-ink", compact ? "text-sm" : "text-base")}>Drop TrackMan or TruMedia CSVs here (1 to 50+ files)</p>
      <p className="mt-1 text-xs text-ink-3">Files are parsed and stored only in this browser. Overlapping uploads are de-duplicated by pitch.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button variant="primary" onClick={() => input.current?.click()} disabled={busy}>
          <Upload aria-hidden /> Choose CSV files
        </Button>
        <Button variant="outline" onClick={() => void loadDemo()} disabled={busy}>
          <Sparkles aria-hidden /> Load Demo Alabama Hitter Dataset
        </Button>
      </div>
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void loadFiles(files);
        }}
      />
    </div>
  );
}
