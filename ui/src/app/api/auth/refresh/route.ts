import type { NextRequest } from "next/server";
import { proxyAuth } from "@/lib/auth-proxy";

export async function POST(request: NextRequest) {
  return proxyAuth(request, "refresh");
}
