import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MiCet.cc · Minecraft PvP 战绩",
  description: "查询 MiCet 玩家战绩、查看 Elo 排行榜及选购游戏内装饰标签。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-Hans"><body>{children}</body></html>;
}
