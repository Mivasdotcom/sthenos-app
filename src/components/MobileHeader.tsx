import { useState } from "react";
import { Menu } from "lucide-react";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { AppSidebar } from "@/components/AppSidebar";
import { DojoBrand } from "@/components/DojoBrand";
import { useCurrentDojo } from "@/hooks/use-current-dojo";

export function MobileHeader() {
  const [open, setOpen] = useState(false);
  const { activeDojo } = useCurrentDojo();
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background px-3 md:hidden">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger
          aria-label="Open menu"
          className="grid size-9 place-items-center rounded-md hover:bg-accent"
        >
          <Menu className="size-5" />
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div onClick={() => setOpen(false)}>
            <AppSidebar variant="drawer" />
          </div>
        </SheetContent>
      </Sheet>
      <DojoBrand
        className="gap-2"
        name={activeDojo?.name}
        logoPath={activeDojo?.logoPath}
        showTagline={false}
        markClassName="size-7 text-brand-strong"
        logoSizeClassName="size-7"
        wordmarkClassName="text-base"
      />
    </header>
  );
}
