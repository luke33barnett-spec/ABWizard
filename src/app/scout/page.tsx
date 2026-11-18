import type { Metadata } from "next";
import { ScoutBoard } from "@/components/scout/ScoutBoard";

export const metadata: Metadata = { title: "Auto-Scout" };

export default function Page() {
  return <ScoutBoard />;
}
