"use client";

/**
 * Playlist import (V2-PLAN T13): /import. The steps live in
 * components/import/ImportFlow.tsx; the address carries the step.
 */
import { Suspense } from "react";
import { ImportFlow } from "../components/import/ImportFlow";

export default function ImportPage() {
  return (
    <Suspense fallback={null}>
      <ImportFlow />
    </Suspense>
  );
}
