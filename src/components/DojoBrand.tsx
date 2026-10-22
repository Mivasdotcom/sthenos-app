import { useState } from "react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/Logo";
import { useDojoLogoUrl } from "@/hooks/use-dojo-logo";

type DojoBrandProps = {
  name?: string | null;
  logoPath?: string | null;
  /** Show the Sthenos tagline when falling back to default branding. */
  showTagline?: boolean;
  className?: string;
  markClassName?: string;
  wordmarkClassName?: string;
  taglineClassName?: string;
  logoSizeClassName?: string;
};

/**
 * Renders a gym's own logo + name, falling back to the Sthenos branding when
 * the gym hasn't uploaded a logo (or when the image fails to load).
 */
export function DojoBrand({
  name,
  logoPath,
  showTagline = false,
  className,
  markClassName,
  wordmarkClassName,
  taglineClassName,
  logoSizeClassName = "size-9",
}: DojoBrandProps) {
  const url = useDojoLogoUrl(logoPath);
  const [broken, setBroken] = useState(false);

  if (!url || broken) {
    return (
      <Logo
        className={className}
        markClassName={markClassName}
        wordmarkClassName={wordmarkClassName}
        taglineClassName={taglineClassName}
        showTagline={showTagline}
      />
    );
  }

  return (
    <span className={cn("flex min-w-0 items-center gap-3", className)}>
      <img
        src={url}
        alt={`${name ?? "Dojo"} logo`}
        onError={() => setBroken(true)}
        className={cn("shrink-0 rounded-md object-contain", logoSizeClassName)}
      />
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-display text-lg font-semibold leading-tight tracking-tight",
            wordmarkClassName,
          )}
        >
          {name ?? "Dojo"}
        </span>
      </span>
    </span>
  );
}
