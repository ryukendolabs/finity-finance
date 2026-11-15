import type { Metadata } from "next";
import { BorrowView } from "@/components/app/views/BorrowView";

export const metadata: Metadata = { title: "Borrow" };

export default async function BorrowPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const { m = "" } = await searchParams;
  return <BorrowView m={m} />;
}
