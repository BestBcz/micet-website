import { MicetSite } from "./micet-site";
import { isPublicLaunch, isSelfHosted, micetMode } from "@/lib/micet-server";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  if (isPublicLaunch()) return {
    title: "MiCet.cc · Minecraft PvP",
    description: "加入 MiCet Minecraft PvP 服务器，查看实时 MOTD 和游戏内 Tag。",
  };
  if (isSelfHosted()) return {
    description: "查询 MiCet 玩家战绩和 Elo 排行榜，绑定游戏账号查看个人对局。",
  };
  return {};
}

export default function Page() {
  return <MicetSite mode={micetMode()} publicLaunch={isPublicLaunch()} selfHosted={isSelfHosted()} />;
}
