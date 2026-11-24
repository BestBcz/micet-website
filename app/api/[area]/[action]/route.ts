import { micetApi } from "@/lib/micet-server";

export const dynamic = "force-dynamic";
type Context = { params: Promise<{ area: string; action: string }> };

async function handle(request: Request, context: Context) {
  const { area, action } = await context.params;
  return micetApi(request, area, action);
}

export { handle as GET, handle as POST };
