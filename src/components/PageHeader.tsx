import type { ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, actions }: Props) {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-zinc-950/5 bg-background/80 px-8 backdrop-blur-md">
      <div className="min-w-0">
        <h1 className="truncate font-display text-lg font-medium text-balance">{title}</h1>
        {subtitle && (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
