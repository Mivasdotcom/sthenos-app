import { createFileRoute } from "@tanstack/react-router";
import type {} from "@tanstack/react-start";

const BODY = `# Sthenos

> Revenue Engine for martial arts gyms: members, attendance, ranks, classes, billing, and retention insight.

Sthenos is a CRM and operations platform for martial arts schools (BJJ, Judo, Karate, Muay Thai, etc.). Gym owners and coaches use it to manage their roster, run class check-ins, track belt and stripe promotions, send billing, automate retention emails, and forecast revenue. Athletes use the member portal to view their attendance and plan.

## Pages

- [Home](/): Product overview for Sthenos.
- [Sign in](/login): Sign in or create a manager account.
`;

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: async () =>
        new Response(BODY, {
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "public, max-age=3600",
          },
        }),
    },
  },
});
