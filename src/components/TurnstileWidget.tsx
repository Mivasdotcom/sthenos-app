import { useEffect, useRef } from "react";

const SITE_KEY = import.meta.env['VITE_TURNSTILE_SITE_KEY'] as string | undefined;

/** True when a bot check is configured for this deployment. */
export const turnstileEnabled = !!SITE_KEY;

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT_SRC}"]`);
  if (existing) {
    return new Promise((resolve) => existing.addEventListener("load", () => resolve()));
  }
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = SCRIPT_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("turnstile script failed"));
    document.head.appendChild(s);
  });
}

/**
 * Cloudflare Turnstile bot check for the public signup form. Renders nothing
 * when no site key is configured, so the form still works before setup.
 */
export function TurnstileWidget({ onToken }: { onToken: (token: string | null) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!SITE_KEY || !ref.current) return;
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !ref.current || !window.turnstile) return;
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: SITE_KEY,
          callback: (token: string) => onToken(token),
          "expired-callback": () => onToken(null),
          "error-callback": () => onToken(null),
        });
      })
      .catch(() => onToken(null));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetId.current);
        } catch {
          /* widget already gone */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!SITE_KEY) return null;
  return <div ref={ref} className="flex justify-center" />;
}
