import { MicetSite } from "./micet-site";
import { isPublicLaunch, micetMode } from "@/lib/micet-server";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  return isPublicLaunch() ? {
    title: "MiCet.cc · Minecraft PvP",
    description: "加入 MiCet Minecraft PvP 服务器，查看实时 MOTD 和游戏内 Tag。",
  } : {};
}

export default function Page() {
  return <MicetSite mode={micetMode()} publicLaunch={isPublicLaunch()} />;
}
