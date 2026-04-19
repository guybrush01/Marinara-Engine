import type { GameMap } from "@marinara-engine/shared";

function normalizeLocationValue(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\b(?:the|a|an)\b/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreAliasMatch(location: string, alias: string): number {
  const locationKey = normalizeLocationValue(location);
  const aliasKey = normalizeLocationValue(alias);
  if (!locationKey || !aliasKey) return 0;
  if (locationKey === aliasKey) return 100;

  const shortest = Math.min(locationKey.length, aliasKey.length);
  if (shortest >= 4 && (locationKey.includes(aliasKey) || aliasKey.includes(locationKey))) {
    return 80;
  }

  const locationTokens = locationKey.split(" ").filter((token) => token.length >= 3);
  const aliasTokens = aliasKey.split(" ").filter((token) => token.length >= 3);
  if (locationTokens.length === 0 || aliasTokens.length === 0) return 0;

  const sharedTokens = aliasTokens.filter((token) => locationTokens.includes(token));
  const requiredOverlap = Math.min(2, locationTokens.length, aliasTokens.length);
  if (sharedTokens.length >= requiredOverlap) {
    return 50 + sharedTokens.length;
  }

  return 0;
}

function findBestMatch<T>(
  location: string,
  entries: readonly T[],
  aliasesFor: (entry: T) => string[],
): { entry: T; score: number } | null {
  let best: { entry: T; score: number } | null = null;

  for (const entry of entries) {
    const score = aliasesFor(entry).reduce((highest, alias) => Math.max(highest, scoreAliasMatch(location, alias)), 0);
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }

  return best && best.score > 0 ? best : null;
}

export function syncGameMapPartyPosition(map: GameMap | null, location: string | null | undefined): GameMap | null {
  const locationName = location?.trim();
  if (!map || !locationName) return map;

  if (map.type === "node") {
    const nodes = map.nodes ?? [];
    const bestMatch = findBestMatch(locationName, nodes, (node) => [node.id, node.label]);
    if (!bestMatch) return map;

    const node = bestMatch.entry;
    const currentNodeId = typeof map.partyPosition === "string" ? map.partyPosition : null;
    if (currentNodeId === node.id && node.discovered) return map;

    return {
      ...map,
      partyPosition: node.id,
      nodes: nodes.map((entry) => (entry.id === node.id ? { ...entry, discovered: true } : entry)),
    };
  }

  const cells = map.cells ?? [];
  const bestMatch = findBestMatch(locationName, cells, (cell) => [
    cell.label,
    `${cell.x},${cell.y}`,
    `${cell.x}:${cell.y}`,
  ]);
  if (!bestMatch) return map;

  const cell = bestMatch.entry;
  const currentCell = typeof map.partyPosition === "object" ? map.partyPosition : null;
  if (currentCell?.x === cell.x && currentCell?.y === cell.y && cell.discovered) return map;

  return {
    ...map,
    partyPosition: { x: cell.x, y: cell.y },
    cells: cells.map((entry) => (entry.x === cell.x && entry.y === cell.y ? { ...entry, discovered: true } : entry)),
  };
}
