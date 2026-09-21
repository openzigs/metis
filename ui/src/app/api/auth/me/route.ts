import type { NextRequest } from "next/server";
import { proxyAuth } from "@/lib/auth-proxy";

export async function GET(request: NextRequest) {
  return proxyAuth(request, "me");
}
