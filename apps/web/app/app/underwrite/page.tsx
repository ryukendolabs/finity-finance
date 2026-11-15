import type { Metadata } from "next";
import { UnderwriteView } from "@/components/app/views/UnderwriteView";

export const metadata: Metadata = { title: "Underwrite" };

export default async function UnderwritePage({ searchParams }: { searchParams: Promise<{ pool?: string }> }) {
  const { pool } = await searchParams;
  return <UnderwriteView venue={pool === "USBANK" ? "USBANK" : "XNYS"} />;
}
