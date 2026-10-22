import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getPublicPrivacyNotice } from "@/lib/privacy.functions";
import { NoticeBody } from "@/components/NoticeBody";
import { LogoMark } from "@/components/Logo";
import { Skeleton } from "@/components/ui/skeleton";
import { Info } from "lucide-react";

export const Route = createFileRoute("/j/$slug/privacy")({
  head: () => ({
    meta: [
      { title: "Member privacy notice" },
      {
        name: "description",
        content:
          "How your gym handles your member information: what is held, why, who processes it, how long it is kept, and how to exercise your rights.",
      },
      { property: "og:title", content: "Member privacy notice" },
      {
        property: "og:description",
        content: "How your gym handles your member information and how to exercise your rights.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GymPrivacyPage,
});

function GymPrivacyPage() {
  const { slug } = Route.useParams();
  const query = useQuery({
    queryKey: ["public-privacy-notice", slug],
    queryFn: () => getPublicPrivacyNotice({ data: { slug } }),
  });

  const dojo = query.data?.dojo;
  const notice = query.data?.notice;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-6 py-5">
          <LogoMark className="size-7 text-brand-strong" />
          <span className="font-display text-lg font-semibold tracking-tight">
            {dojo?.name ?? "Privacy notice"}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-8 px-6 py-10">
        {query.isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : query.isError || !dojo ? (
          <p className="text-sm text-muted-foreground">We couldn't find this gym's privacy notice.</p>
        ) : !notice ? (
          <div className="space-y-4">
            <h1 className="font-display text-3xl font-semibold tracking-tight">Privacy notice</h1>
            <div className="flex items-start gap-3 rounded-xl bg-surface p-4 ring-1 ring-zinc-950/10">
              <Info className="mt-0.5 size-5 flex-none text-brand" />
              <p className="text-sm text-muted-foreground">
                {dojo.name} has not published its privacy notice here yet. For any question about
                how your information is handled, or to make a request about your data, contact{" "}
                {dojo.contactEmail ? (
                  <a
                    href={`mailto:${dojo.contactEmail}`}
                    className="font-medium text-brand-strong underline underline-offset-2"
                  >
                    {dojo.contactEmail}
                  </a>
                ) : (
                  <span className="font-medium text-foreground">{dojo.name}</span>
                )}
                . {dojo.name} is responsible for your member information; Sthenos provides the
                membership software on its behalf.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="space-y-2">
              <h1 className="font-display text-3xl font-semibold tracking-tight">{notice.title}</h1>
              <p className="text-sm text-muted-foreground">
                {dojo.name} — version {notice.version}
                {notice.published_at
                  ? `, published ${new Date(notice.published_at).toLocaleDateString()}`
                  : ""}
                .
              </p>
            </div>
            <NoticeBody body={notice.body_markdown} />
          </div>
        )}

        <div className="border-t border-border pt-6 text-sm">
          <Link to="/j/$slug/signup" params={{ slug }} className="text-brand-strong hover:underline">
            Back to signup
          </Link>
        </div>
      </main>
    </div>
  );
}
