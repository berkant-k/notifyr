import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Notifyr – FHIR Subscription Tester",
  description:
    "A disposable webhook endpoint for testing FHIR Subscription rest-hook notifications.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex flex-col">
          {/*
            Off-screen until focused. Without it a keyboard user crosses the
            header on every page load, and on the dashboard that is the only
            thing between them and a list they may be watching for minutes.
            Styled in globals.css rather than with utilities — see the note on
            .skip-link, including how to test it.
          */}
          <a href="#main" className="skip-link">
            Skip to content
          </a>
          <header className="border-b border-slate-200 bg-white">
            <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4 lg:max-w-6xl">
              <Link href="/" className="text-sm font-semibold tracking-tight">
                Notifyr
              </Link>
              <span className="text-xs text-slate-500">FHIR Subscription Tester</span>
            </div>
          </header>
          <main id="main" className="mx-auto w-full max-w-4xl flex-1 px-6 py-10 lg:max-w-6xl">
            {children}
          </main>
          <footer className="border-t border-slate-200 bg-white">
            <div className="mx-auto max-w-4xl px-6 py-4 text-xs text-slate-500 lg:max-w-6xl">
              Anyone with an endpoint URL can read its dashboard. Do not send real patient data.
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
