import type { Metadata } from "next";
import { MainnetView } from "@/components/app/views/MainnetView";

export const metadata: Metadata = { title: "Mainnet" };

export default function MainnetPage() {
  return <MainnetView />;
}
