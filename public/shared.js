(function attachCastleShared(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CastleShared = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function castleSharedFactory() {
  "use strict";

  const MAP_WIDTH = 40;
  const MAP_HEIGHT = 25;
  const TILE = 16;

  function seeded(seed) {
    let value = seed >>> 0;
    return function random() {
      value = (value * 1664525 + 1013904223) >>> 0;
      return value / 4294967296;
    };
  }

  function generateMap(level, mapSeed) {
    const random = seeded(Number.isFinite(mapSeed) ? mapSeed : 800 + level * 2600);
    const grid = Array.from({ length: MAP_HEIGHT }, (_, y) =>
      Array.from({ length: MAP_WIDTH }, (_, x) =>
        x === 0 || y === 0 || x === MAP_WIDTH - 1 || y === MAP_HEIGHT - 1 ? "#" : "."
      )
    );

    const verticals = [10, 20, 30];
    const horizontals = [8, 16];
    for (const x of verticals) {
      for (let y = 1; y < MAP_HEIGHT - 1; y += 1) grid[y][x] = "#";
      const doorwayBands = [[3, 5], [11, 13], [19, 21]];
      for (const band of doorwayBands) {
        const doorY = band[0] + Math.floor(random() * (band[1] - band[0] + 1));
        grid[doorY][x] = "+";
      }
    }
    for (const y of horizontals) {
      for (let x = 1; x < MAP_WIDTH - 1; x += 1) grid[y][x] = "#";
      const doorwayBands = [[4, 7], [13, 17], [23, 27], [33, 36]];
      for (const band of doorwayBands) {
        const doorX = band[0] + Math.floor(random() * (band[1] - band[0] + 1));
        grid[y][doorX] = "+";
      }
    }

    // Period furniture and cover. Keep the starting room graciously open.
    for (let roomY = 0; roomY < 3; roomY += 1) {
      for (let roomX = 0; roomX < 4; roomX += 1) {
        if (roomX === 0 && roomY === 2) continue;
        const left = roomX * 10 + 2;
        const top = roomY * 8 + 2;
        const furniture = random() > 0.5
          ? [[left, top], [left + 1, top], [left + 6, top + 3]]
          : [[left + 3, top], [left + 3, top + 1], [left + 7, top + 4]];
        for (const [x, y] of furniture) {
          if (y < MAP_HEIGHT - 1) grid[y][x] = "C";
        }
      }
    }

    // Short internal partitions give every screen its own silhouette without
    // sealing off a route. They echo the sparse, angular rooms of early 8-bit games.
    for (let roomY = 0; roomY < 3; roomY += 1) {
      for (let roomX = 0; roomX < 4; roomX += 1) {
        if (roomX === 0 && roomY === 2) continue;
        const left = roomX * 10;
        const top = roomY * 8;
        const candidates = (roomX + roomY + level) % 2
          ? [[left + 5, top + 3], [left + 5, top + 4]]
          : [[left + 4, top + 5], [left + 5, top + 5]];
        for (const [x, y] of candidates) if (grid[y]?.[x] === ".") grid[y][x] = "#";
      }
    }

    // Entry and extraction stairs.
    grid[MAP_HEIGHT - 3][2] = "S";
    grid[2][MAP_WIDTH - 3] = "E";
    return grid.map((row) => row.join(""));
  }

  function isSolid(map, x, y) {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= MAP_WIDTH || ty >= MAP_HEIGHT) return true;
    return map[ty][tx] === "#" || map[ty][tx] === "C";
  }

  return { MAP_WIDTH, MAP_HEIGHT, TILE, generateMap, isSolid };
});
