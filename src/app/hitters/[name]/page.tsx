import { Suspense } from "react";
import type { Metadata } from "next";
import { HitterProfile } from "@/components/hitter/HitterProfile";

export async function generateMetadata({ params }: PageProps<"/hitters/[name]">): Promise<Metadata> {
  const { name } = await params;
  const decoded = decodeURIComponent(name);
  const [last, first] = decoded.split(",").map((s) => s.trim());
  return { title: first ? `${first} ${last}` : decoded };
}

async function Resolved({ params }: { params: PageProps<"/hitters/[name]">["params"] }) {
  const { name } = await params;
  return <HitterProfile hitter={decodeURIComponent(name)} />;
}

export default function Page({ params }: PageProps<"/hitters/[name]">) {
  return (
    <Suspense fallback={<div className="skeleton h-96 w-full" />}>
      <Resolved params={params} />
    </Suspense>
  );
}
