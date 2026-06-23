"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

type ScrollSnapshot = {
  windowX: number;
  windowY: number;
  gridLeft: number;
  gridTop: number;
};

export function ScheduleGridDisplayRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter();
  const snapshotRef = useRef<ScrollSnapshot | null>(null);

  useEffect(() => {
    const previousRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previousRestoration;
    };
  }, []);

  useEffect(() => {
    function activeScheduleView() {
      const view = new URLSearchParams(window.location.search).get("view");
      return !view || view === "schedule";
    }

    function captureScroll() {
      const grid = document.querySelector<HTMLElement>(".schedule-grid-wrap");
      snapshotRef.current = {
        windowX: window.scrollX,
        windowY: window.scrollY,
        gridLeft: grid?.scrollLeft || 0,
        gridTop: grid?.scrollTop || 0
      };
    }

    function restoreScroll() {
      const snapshot = snapshotRef.current;
      if (!snapshot) return;
      const grid = document.querySelector<HTMLElement>(".schedule-grid-wrap");
      if (grid) {
        grid.scrollLeft = snapshot.gridLeft;
        grid.scrollTop = snapshot.gridTop;
      }
      window.scrollTo(snapshot.windowX, snapshot.windowY);
    }

    function refreshWithoutMovingDisplay() {
      if (!activeScheduleView()) return;
      captureScroll();
      router.refresh();

      let frames = 0;
      const restoreForSeveralFrames = () => {
        restoreScroll();
        frames += 1;
        if (frames < 12) window.requestAnimationFrame(restoreForSeveralFrames);
      };
      window.requestAnimationFrame(restoreForSeveralFrames);
      window.setTimeout(restoreScroll, 750);
      window.setTimeout(restoreScroll, 1500);
    }

    const intervalId = window.setInterval(refreshWithoutMovingDisplay, seconds * 1000);
    return () => window.clearInterval(intervalId);
  }, [router, seconds]);

  return null;
}
