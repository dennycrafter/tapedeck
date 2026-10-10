import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Tapedeck: test audio",
  description: "Two test tones for playback, Media Session and offline checks",
};

export default function TestAudioLayout({ children }: { children: ReactNode }) {
  return children;
}
