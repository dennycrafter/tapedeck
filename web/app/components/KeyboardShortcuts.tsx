"use client";

/**
 * Desktop shortcuts (SPEC 10): Space play/pause, Shift+Right/Left next and
 * previous, "/" focuses search. Ignored while typing in a field or when a
 * dialog is open, so they never steal keys.
 */
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { usePlayer } from "./PlayerProvider";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return type !== "range" && type !== "checkbox" && type !== "button";
  }
  return false;
}

export const SEARCH_INPUT_ID = "library-search-input";

export function KeyboardShortcuts() {
  const player = usePlayer();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (document.querySelector("[aria-modal=true]")) return;
      if (event.key === " " || event.code === "Space") {
        // Space on a focused button should press that button, not the player.
        if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement) return;
        if (player.getState().index < 0) return;
        event.preventDefault();
        player.toggle();
      } else if (event.shiftKey && event.key === "ArrowRight") {
        event.preventDefault();
        player.next();
      } else if (event.shiftKey && event.key === "ArrowLeft") {
        event.preventDefault();
        player.previous();
      } else if (event.key === "/") {
        event.preventDefault();
        const input = document.getElementById(SEARCH_INPUT_ID);
        if (input) input.focus();
        else router.push("/search?focus=1");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, router, pathname]);

  return null;
}
