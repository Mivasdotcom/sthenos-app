import { cn } from "@/lib/utils";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={cn("size-9", className)}
    >
      <path
        d="M8 8h14v6a3 3 0 0 0 6 0V8h12v14h-6a3 3 0 0 0 0 6h6v12H28v-6a3 3 0 0 0-6 0v6H8V28h6a3 3 0 0 0 0-6H8V8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type LogoProps = {
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  taglineClassName?: string;
  showTagline?: boolean;
};

export function Logo({
  className,
  markClassName,
  wordmarkClassName,
  taglineClassName,
  showTagline = true,
}: LogoProps) {
  return (
    <span className={cn("flex items-center gap-3", className)}>
      <LogoMark className={cn("shrink-0 text-brand-strong", markClassName)} />
      <span>
        <span
          className={cn(
            "block font-display text-lg font-semibold leading-none tracking-tight",
            wordmarkClassName,
          )}
        >
          STHENOS
        </span>
        {showTagline && (
          <span
            className={cn(
              "mt-1 block text-[10px] uppercase tracking-[0.18em] opacity-60",
              taglineClassName,
            )}
          >
            Revenue Engine
          </span>
        )}
      </span>
    </span>
  );
}
