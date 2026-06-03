"use client";

import { useEffect, useId, useRef } from "react";

export type ManagedBracketData = {
  stage: Array<{ id: number; name: string }>;
  group: Array<{ id: number; number: number }>;
  round: Array<{ id: number; group_id: number; number: number }>;
  match: Array<{ id: number; group_id: number; round_id: number; number: number }>;
  match_game: unknown[];
  participant: unknown[];
};

type Viewer = {
  render: (data: unknown, config?: unknown) => Promise<void>;
};

export function ManagedBracketViewer({ data }: { data: ManagedBracketData }) {
  const reactId = useId().replaceAll(":", "");
  const containerId = `brackets-viewer-${reactId}`;
  const viewerRef = useRef<Viewer | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderBracket() {
      const viewer = await loadViewer();
      if (cancelled) return;
      viewerRef.current = viewer;
      await viewer.render(
        {
          stages: data.stage,
          matches: data.match,
          matchGames: data.match_game,
          participants: data.participant
        },
        {
          clear: true,
          selector: `#${containerId}`,
          showSlotsOrigin: true,
          showLowerBracketSlotsOrigin: true
        }
      );
      addVisibleMatchLabels(containerId, data);
    }

    renderBracket().catch((error) => {
      const container = document.getElementById(containerId);
      if (container) container.textContent = error instanceof Error ? error.message : "Unable to render bracket.";
    });

    return () => {
      cancelled = true;
    };
  }, [containerId, data]);

  return <div id={containerId} className="brackets-viewer managed-brackets-viewer" />;
}

async function loadViewer(): Promise<Viewer> {
  if (window.bracketsViewer) return window.bracketsViewer;

  await import("brackets-viewer/dist/brackets-viewer.min.js");
  if (window.bracketsViewer) return window.bracketsViewer;

  throw new Error("Bracket viewer did not load.");
}

function addVisibleMatchLabels(containerId: string, data: ManagedBracketData) {
  const root = document.getElementById(containerId);
  if (!root) return;

  const groupsById = new Map(data.group.map((group) => [group.id, group]));
  const roundsById = new Map(data.round.map((round) => [round.id, round]));

  for (const match of data.match) {
    const matchElement = root.querySelector<HTMLElement>(`.match[data-match-id="${match.id}"]`);
    const round = roundsById.get(match.round_id);
    const group = groupsById.get(match.group_id);
    if (!matchElement || !round || !group) continue;

    matchElement.querySelector(".managed-match-label")?.remove();
    const label = document.createElement("div");
    label.className = "managed-match-label";
    label.textContent = matchLabel(group.number, round.number, match.number);
    matchElement.prepend(label);
  }
}

function matchLabel(groupNumber: number, roundNumber: number, matchNumber: number) {
  if (groupNumber === 1) return `WB ${roundNumber}.${matchNumber}`;
  if (groupNumber === 2) return `LB ${roundNumber}.${matchNumber}`;
  if (groupNumber === 3) return `GF ${matchNumber}`;
  return `M ${roundNumber}.${matchNumber}`;
}
