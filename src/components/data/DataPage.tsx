"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useData } from "@/components/providers/DataProvider";
import { CsvDropzone } from "@/components/data/CsvDropzone";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Stat } from "@/components/ui/stat";
import { ENRICHED_COLUMNS } from "@/lib/sql/schema";

export function DataPage() {
  const { summary, savedAt, setHealthOpen, clearData, status } = useData();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold tracking-tight">Data &amp; Schema</h1>
      <CsvDropzone />
      {summary ? (
        <Card>
          <CardHeader
            title="Loaded dataset"
            subtitle={savedAt ? `Saved in this browser (IndexedDB) at ${new Date(savedAt).toLocaleString()}` : "Not yet persisted"}
            actions={
              <>
                <Button size="sm" onClick={() => setHealthOpen(true)}>
                  Dataset health &amp; mapping
                </Button>
                {confirm ? (
                  <>
                    <span className="text-xs text-warn">Remove all pitches from this browser?</span>
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        setConfirm(false);
                        void clearData();
                      }}
                    >
                      Yes, clear
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirm(true)} disabled={status !== "ready"}>
                    <Trash2 aria-hidden /> Clear data
                  </Button>
                )}
              </>
            }
          />
          <CardBody className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Pitches" value={summary.pitches.toLocaleString()} />
            <Stat label="PAs" value={summary.pas.toLocaleString()} />
            <Stat label="Files" value={summary.files.length} />
            <Stat label="Hitters" value={summary.hitters} sub={`${summary.ourHitters} Alabama`} />
          </CardBody>
        </Card>
      ) : null}
      <Card>
        <CardHeader title="enriched_pitches columns" subtitle="The table every panel, the Auto-Scout and Ask ABWizard query. Also exactly what the AI sees about your data." />
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 bg-surface-2 text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">Column</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 font-medium">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {ENRICHED_COLUMNS.map((c) => (
                <tr key={c.name} className="border-t border-line">
                  <td className="num px-3 py-1.5 text-ink">{c.name}</td>
                  <td className="num px-3 py-1.5 text-ink-3">{c.type}</td>
                  <td className="px-3 py-1.5 text-ink-2">{c.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
