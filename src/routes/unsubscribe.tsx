import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PUBLIC_SITE_URL } from "@/lib/site";
import { checkUnsubscribeToken, confirmUnsubscribe } from "@/lib/unsubscribe.functions";

export const Route = createFileRoute("/unsubscribe")({
  head: () => ({
    meta: [
      { title: "Unsubscribe \u2014 Sthenos" },
      { name: "description", content: "Stop receiving marketing emails from your gym." },
      { property: "og:title", content: "Unsubscribe \u2014 Sthenos" },
      { property: "og:description", content: "Stop receiving marketing emails from your gym." },
      { property: "og:type", content: "website" },
      { property: "og:url", content: `${PUBLIC_SITE_URL}/unsubscribe` },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "Unsubscribe \u2014 Sthenos" },
      { name: "twitter:description", content: "Stop receiving marketing emails from your gym." },
      { name: "robots", content: "noindex" },
    ],
    links: [{ rel: "canonical", href: `${PUBLIC_SITE_URL}/unsubscribe` }],
  }),
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : "",
  }),
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { token } = useSearch({ from: "/unsubscribe" });
  const check = useServerFn(checkUnsubscribeToken);
  const confirm = useServerFn(confirmUnsubscribe);

  const { data, isLoading } = useQuery({
    queryKey: ["unsubscribe", token],
    queryFn: () => check({ data: { token } }),
    enabled: !!token,
  });

  const apply = useMutation({ mutationFn: () => confirm({ data: { token } }) });

  const done = apply.data?.state === "done" || data?.state === "already";

  return (
    <main className="mx-auto flex min-h-screen max-w-lg items-center px-4">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Marketing emails</CardTitle>
          <CardDescription>
            {!token || data?.state === "invalid"
              ? "This unsubscribe link is not valid."
              : done
                ? "You're unsubscribed."
                : "Confirm you'd like to stop receiving marketing emails."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading && token ? <p className="text-sm text-muted-foreground">Checking your link…</p> : null}

          {done ? (
            <p className="text-sm text-muted-foreground">
              {(apply.data?.email ?? data?.email) ?? "Your address"} will no longer receive marketing emails.
              You'll still get essential account and billing messages, and replies to conversations with your gym.
            </p>
          ) : null}

          {data?.state === "valid" && !done ? (
            <>
              <p className="text-sm text-muted-foreground">
                Unsubscribing <span className="font-medium">{data.email}</span> from marketing emails.
              </p>
              <Button onClick={() => apply.mutate()} disabled={apply.isPending}>
                {apply.isPending ? "Unsubscribing…" : "Unsubscribe me"}
              </Button>
            </>
          ) : null}

          {(!token || data?.state === "invalid") && !isLoading ? (
            <p className="text-sm text-muted-foreground">
              Please use the unsubscribe link from a recent email, or reply to your gym directly.
            </p>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
