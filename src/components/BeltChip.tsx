import { beltClassMap, type Belt } from "@/lib/belt-colors";
import { cn } from "@/lib/utils";

interface Props {
  belt: Belt;
  discipline?: string;
  className?: string;
  showStripes?: boolean;
}

export function BeltChip({ belt, discipline, className, showStripes = true }: Props) {
  const c = beltClassMap[belt.color] ?? beltClassMap.white;
  const isBJJ = discipline === "BJJ" || discipline === "Brazilian Jiu-Jitsu" || discipline === "No-Gi Jiu-Jitsu";
  const showDan = !isBJJ && belt.dan;
  const stripes = belt.stripes ?? 0;
  const isBeginner = belt.color === "beginner";
  const displayLabel = isBeginner ? "BEGINNER" : belt.label;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2 py-0.5 ring-1 ring-inset border-transparent",
        c.bg,
        c.ring,
        className,
      )}
    >
      <div className={cn("h-1 w-3 rounded-full", c.dot)} />
      <span className={cn("text-[10px] font-bold uppercase tracking-tight", c.text)}>
        {displayLabel}
        {showDan ? ` · ${belt.dan} Dan` : ""}
      </span>
      {!isBeginner && showStripes && stripes > 0 ? (
        <span
          className="flex items-center gap-0.5 rounded-sm bg-black/15 px-1 py-0.5 ring-1 ring-inset ring-black/10"
          aria-label={`${stripes} stripe${stripes > 1 ? "s" : ""}`}
          title={`${stripes} stripe${stripes > 1 ? "s" : ""}`}
        >
          {Array.from({ length: stripes }).map((_, i) => (
            <span key={i} className="h-2.5 w-[3px] rounded-[1px] bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.25)]" />
          ))}
        </span>
      ) : null}
    </div>
  );
}

export function MemberAvatar({ name, className }: { name: string; className?: string }) {
  const initials = name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("");
  return (
    <div
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full bg-zinc-200 text-[10px] font-semibold text-zinc-700 ring-1 ring-inset ring-black/5",
        className,
      )}
    >
      {initials}
    </div>
  );
}
