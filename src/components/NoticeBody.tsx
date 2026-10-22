/**
 * Renders a plain-text notice (## headings, - bullets, paragraphs) the way a
 * member should read it: no markdown syntax left on screen.
 */
export function NoticeBody({ body }: { body: string }) {
  const blocks = body.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);

  const nodes: React.ReactNode[] = [];
  let bullets: string[] = [];

  const flush = (key: string) => {
    if (bullets.length === 0) return;
    nodes.push(
      <ul key={`ul-${key}`} className="list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-muted-foreground">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  blocks.forEach((block, index) => {
    if (block.startsWith("## ")) {
      flush(`h${index}`);
      nodes.push(
        <h2 key={index} className="pt-2 font-display text-xl font-semibold tracking-tight text-foreground">
          {block.slice(3).trim()}
        </h2>,
      );
      return;
    }
    if (block.startsWith("- ")) {
      block
        .split("\n")
        .map((l) => l.replace(/^-\s*/, "").trim())
        .filter(Boolean)
        .forEach((l) => bullets.push(l));
      return;
    }
    flush(`p${index}`);
    nodes.push(
      <p key={index} className="text-sm leading-relaxed text-muted-foreground">
        {block}
      </p>,
    );
  });
  flush("end");

  return <div className="space-y-3">{nodes}</div>;
}
