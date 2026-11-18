import type { Metadata } from "next";
import { QueryWorkbench } from "@/components/QueryWorkbench";

export const metadata: Metadata = { title: "Ask ABWizard" };

export default function Page() {
  return <QueryWorkbench />;
}
