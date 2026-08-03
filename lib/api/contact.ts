import { apiPost } from "./client";

export type ContactPayload = {
  name: string;
  email: string;
  topic?: "general" | "sales" | "support" | "billing";
  message: string;
  /** Honeypot field — leave empty. */
  company?: string;
};

export function sendContactMessage(body: ContactPayload, init?: RequestInit) {
  return apiPost<{ ok: true }>("/api/contact", body, init);
}
