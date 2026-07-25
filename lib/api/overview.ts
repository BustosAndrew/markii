import { apiGet } from "./client";
import type { OverviewResponse } from "./types";

export function getOverview(init?: RequestInit) {
  return apiGet<OverviewResponse>("/api/overview", undefined, init);
}
