import type { Metadata } from "next";
import { DataPage } from "@/components/data/DataPage";

export const metadata: Metadata = { title: "Data & Schema" };

export default function Page() {
  return <DataPage />;
}
