import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SerwistProvider } from "@serwist/next/react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tapedeck",
  description: "A self-hosted music library and audio player.",
  icons: {
    // Emits <link rel="apple-touch-icon"> so iOS uses the 180x180 icon when
    // the app is added to the home screen (SPEC T0 step 5).
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/* Registers /sw.js in the browser (SPEC 8.9); the build step writes
            it only in production, so development disables the provider. */}
        <SerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV === "development"}>
          {children}
        </SerwistProvider>
      </body>
    </html>
  );
}
