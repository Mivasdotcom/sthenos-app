import { createClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { handleEmailQueue } from "@/lib/email-queue-handler.server";
import { sendEmail } from "@/lib/email-provider.server";

export const Route = createFileRoute("/api/public/hooks/email-queue")({
  server: {
    handlers: {
      POST: ({ request }) =>
        handleEmailQueue(request, {
          env: process.env,
          createSupabase: (url, serviceKey) => createClient(url, serviceKey),
          send: sendEmail,
          now: () => Date.now(),
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }),
    },
  },
});
