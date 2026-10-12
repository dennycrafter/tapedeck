import type { Metadata, Viewport } from "next";
import { SerwistProvider } from "@serwist/next/react";
import { PlayerProvider } from "./components/PlayerProvider";
import { PlayerBar } from "./components/PlayerBar";
import { OverlaysProvider } from "./components/Overlays";
import { PhoneTabBar } from "./components/PhoneTabBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tapedeck",
  description: "A self-hosted music library and audio player.",
  icons: {
    // Emits <link rel="apple-touch-icon"> so iOS uses the 180x180 icon when
    // the app is added to the home screen (SPEC T0 step 5).
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  // viewport-fit=cover is what makes env(safe-area-inset-*) non-zero on the
  // iPhone notch/home indicator (SPEC 10 layout).
  viewportFit: "cover",
  themeColor: "#0b0b0d",
};

// Explicit prop type instead of Next's generated global `LayoutProps<"/">`:
// that global only exists after `next typegen`/`next build` writes
// .next/types, so a fresh clone (and plain `tsc --noEmit`) could not see it.
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-bg font-sans text-fg">
        <SerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV === "development"}>
          <PlayerProvider>
            <OverlaysProvider>
              <div className="mx-auto w-full max-w-[1760px] px-[clamp(16px,2.6vw,40px)]">
                <div className="flex flex-1 flex-col">{children}</div>
              </div>
              <PlayerBar />
              <PhoneTabBar />
            </OverlaysProvider>
          </PlayerProvider>
        </SerwistProvider>
      </body>
    </html>
  );
}
