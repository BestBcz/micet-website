import { MicetSite } from "./micet-site";
import { isSelfHosted, micetMode } from "@/lib/micet-server";

export const dynamic = "force-dynamic";

export function generateMetadata() {
  if (isSelfHosted()) return {
    description: "查询 MiCet 玩家战绩和 Elo 排行榜，绑定游戏账号查看个人对局。",
  };
  return {};
}

export default function Page() {
  return <MicetSite mode={micetMode()} selfHosted={isSelfHosted()} />;
}
