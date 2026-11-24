import { MicetSite } from "./micet-site";
import { micetMode } from "@/lib/micet-server";

export const dynamic = "force-dynamic";

export default function Page() {
  return <MicetSite mode={micetMode()} />;
}
