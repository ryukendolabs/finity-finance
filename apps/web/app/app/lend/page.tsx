import type { Metadata } from "next";
import { LendView } from "@/components/app/views/LendView";

export const metadata: Metadata = { title: "Lend" };

export default function LendPage() {
  return <LendView />;
}
