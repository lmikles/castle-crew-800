"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const os = require("node:os");
const { WebSocketServer, WebSocket } = require("ws");
const Shared = require("./public/shared.js");

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, "public");
const TICK_RATE = 30;
const BROADCAST_RATE = 15;
const rooms = new Map();
const COOP_ROLES = ["movement", "weapons"];
const HUNT_ROLES = ["intruder-movement", "intruder-weapons", "guard-movement", "guard-weapons"];

function normalizeMode(mode) {
  return mode === "versus" ? "versus" : "coop";
}

function rolesForMode(mode) {
  return mode === "versus" ? HUNT_ROLES : COOP_ROLES;
}

function teamForRole(role) {
  return String(role).startsWith("guard-") ? "guard" : "intruder";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  if (pathname === "/api/network") {
    const hostPort = String(req.headers.host || `localhost:${PORT}`).split(":").pop();
    const addresses = Object.values(os.networkInterfaces()).flat().filter((entry) =>
      entry && entry.family === "IPv4" && !entry.internal &&
      (/^192\.168\./.test(entry.address) || /^10\./.test(entry.address) || /^172\.(1[6-9]|2\d|3[01])\./.test(entry.address))
    );
    const body = JSON.stringify({ lanOrigins: addresses.map((entry) => `http://${entry.address}:${hostPort}`) });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(body);
    return;
  }
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function roomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from(crypto.randomBytes(4), (n) => alphabet[n % alphabet.length]).join("");
  } while (rooms.has(code));
  return code;
}

function makeInput() {
  return { up: false, down: false, left: false, right: false, sneak: false, search: false, fire: 0, grenade: 0 };
}

function makeLevel(level = 1) {
  const map = Shared.generateMap(level);
  const patrolPoints = [
    [5, 4], [15, 4], [25, 4], [35, 5], [5, 12], [15, 12],
    [25, 12], [35, 12], [6, 20], [16, 21], [26, 20], [35, 20]
  ];
  const count = Math.min(7 + level, 12);
  const enemies = patrolPoints.slice(0, count).map(([x, y], id) => ({
    id, x, y, dx: 0, dy: 0, facing: (id % 4) * Math.PI / 2,
    health: level >= 3 && id % 3 === 0 ? 2 : 1,
    elite: level >= 3 && id % 3 === 0,
    state: "patrol", cooldown: 0.8 + (id % 3) * 0.3,
    patrolX: x, patrolY: y, targetX: x, targetY: y,
    surrenderMeter: 0, searched: false,
    loot: id === 1 ? "key" : (["ammo", "nothing", "uniform", "grenade"][id % 4])
  }));
  const chestSpots = [];
  for (let y = 0; y < map.length; y += 1) {
    for (let x = 0; x < map[y].length; x += 1) {
      if (map[y][x] === "C") chestSpots.push([x + 0.5, y + 0.5]);
    }
  }
  const planCandidates = chestSpots.filter(([x, y]) => x > 20 && y < 16);
  const keyCandidates = chestSpots.filter(([x, y]) => x < 20 && y > 8);
  const planSpot = planCandidates[(level * 3) % planCandidates.length] || chestSpots[chestSpots.length - 1];
  const keySpot = keyCandidates[(level * 5) % keyCandidates.length] || chestSpots[0];
  const contents = ["nothing", "ammo", "nothing", "grenade", "nothing", "uniform"];
  const chests = chestSpots.map(([x, y], id) => ({
    id, x, y, opened: false, searched: false, searchProgress: 0,
    locked: x === planSpot[0] && y === planSpot[1],
    content: x === planSpot[0] && y === planSpot[1]
      ? "plans"
      : (x === keySpot[0] && y === keySpot[1] ? "key" : contents[(id + level) % contents.length])
  }));
  return { map, enemies, chests, intel: [], ammo: [] };
}

function makeGame() {
  const levelData = makeLevel(1);
  return {
    status: "waiting",
    level: 1,
    time: 720,
    score: 0,
    alert: 0,
    flash: "",
    flashUntil: 0,
    player: {
      x: 2.5, y: Shared.MAP_HEIGHT - 2.5, aimX: 1, aimY: 0,
      health: 4, ammo: 10, grenades: 3, intel: 0, keys: 0, disguise: false,
      invulnerable: 0, firing: 0, searching: false
    },
    bullets: [],
    enemyBullets: [],
    thrown: [],
    explosions: [],
    ...levelData
  };
}

function makeHunter(team, x, y, aimX) {
  return {
    team, x, y, aimX, aimY: 0, health: 6, maxHealth: 6,
    ammo: 99, grenades: 5, invulnerable: 0, firing: 0, searching: false
  };
}

function makeHuntGame() {
  const map = Shared.generateMap(1);
  const chestSpots = [];
  for (let y = 0; y < map.length; y += 1) {
    for (let x = 0; x < map[y].length; x += 1) {
      if (map[y][x] === "C") chestSpots.push([x + 0.5, y + 0.5]);
    }
  }
  for (let i = chestSpots.length - 1; i > 0; i -= 1) {
    const swap = crypto.randomInt(i + 1);
    [chestSpots[i], chestSpots[swap]] = [chestSpots[swap], chestSpots[i]];
  }
  const chests = chestSpots.slice(0, Math.min(12, chestSpots.length)).map(([x, y], id) => ({
    id, x, y, opened: false, searched: false, searchProgress: 0,
    searchingTeam: null, locked: false, content: "moonshine"
  }));
  return {
    mode: "versus",
    status: "waiting",
    winner: null,
    level: 1,
    time: 600,
    score: 0,
    alert: 0,
    flash: "",
    flashUntil: 0,
    map,
    actors: {
      intruder: makeHunter("intruder", 2.5, Shared.MAP_HEIGHT - 2.5, 1),
      guard: makeHunter("guard", Shared.MAP_WIDTH - 2.5, 2.5, -1)
    },
    bullets: [],
    thrown: [],
    explosions: [],
    chests,
    enemies: [],
    intel: [],
    ammo: []
  };
}

function makeRoom(code, mode = "coop") {
  const normalizedMode = normalizeMode(mode);
  const roles = rolesForMode(normalizedMode);
  return {
    code,
    mode: normalizedMode,
    sockets: Object.fromEntries(roles.map((role) => [role, null])),
    inputs: Object.fromEntries(roles.map((role) => [role, makeInput()])),
    game: normalizedMode === "versus" ? makeHuntGame() : makeGame(),
    emptySince: null,
    lastBroadcast: 0
  };
}

function serializeLobby(room) {
  return {
    type: "lobby",
    code: room.code,
    mode: room.mode,
    players: Object.fromEntries(Object.entries(room.sockets).map(([role, socket]) => [role, Boolean(socket)])),
    status: room.game.status
  };
}

function broadcast(room, message) {
  for (const socket of Object.values(room.sockets)) if (socket) send(socket, message);
}

function announce(room, text, duration = 2.2) {
  room.game.flash = text;
  room.game.flashUntil = Date.now() / 1000 + duration;
}

function maybeStart(room) {
  broadcast(room, serializeLobby(room));
  const ready = rolesForMode(room.mode).every((role) => room.sockets[role]);
  if (ready && room.game.status === "waiting") {
    room.game = room.mode === "versus" ? makeHuntGame() : makeGame();
    room.game.status = "playing";
    announce(room, room.mode === "versus" ? "ALL FOUR ONLINE — THE HUNT BEGINS!" : "BOTH OPERATORS ONLINE — INFILTRATE!", 3);
    broadcast(room, { type: "start", code: room.code, mode: room.mode });
  }
}

function claimRoom(ws, code, role, recoverMissing = false, requestedMode = "coop") {
  let room = rooms.get(code);
  let recovered = false;
  if (!room && recoverMissing && /^[A-Z0-9]{4}$/.test(code)) {
    room = makeRoom(code, requestedMode);
    rooms.set(code, room);
    recovered = true;
  }
  if (!room) return send(ws, { type: "error", message: "No mission uses that code." });
  if (!rolesForMode(room.mode).includes(role)) return send(ws, { type: "error", message: `Choose a ${room.mode === "versus" ? "Manhunt" : "mission"} operator role.` });
  if (room.sockets[role] && room.sockets[role] !== ws) {
    return send(ws, { type: "error", message: "That controller is already occupied." });
  }
  if (ws.room && ws.role) ws.room.sockets[ws.role] = null;
  room.sockets[role] = ws;
  room.emptySince = null;
  ws.room = room;
  ws.role = role;
  send(ws, { type: "joined", code, role, mode: room.mode, recovered });
  maybeStart(room);
}

wss.on("connection", (ws) => {
  send(ws, { type: "hello" });
  ws.on("message", (raw) => {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type === "create") {
      const code = roomCode();
      const room = makeRoom(code, message.mode);
      rooms.set(code, room);
      claimRoom(ws, code, message.role);
      return;
    }
    if (message.type === "join") {
      claimRoom(ws, String(message.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4), message.role, true, message.mode);
      return;
    }
    if (!ws.room || !ws.role) return;
    if (message.type === "input") {
      const input = ws.room.inputs[ws.role];
      const next = message.input || {};
      for (const key of ["up", "down", "left", "right", "sneak", "search"]) input[key] = Boolean(next[key]);
      input.fire = Math.max(input.fire, Number(next.fire) || 0);
      input.grenade = Math.max(input.grenade, Number(next.grenade) || 0);
    }
    if (message.type === "restart" && (["won", "lost", "finished"].includes(ws.room.game.status))) {
      ws.room.game = ws.room.mode === "versus" ? makeHuntGame() : makeGame();
      ws.room.game.status = "playing";
      announce(ws.room, ws.room.mode === "versus" ? "REMATCH — HUNT!" : "SECOND ATTEMPT — STAY SHARP!", 2.5);
    }
  });
  ws.on("close", () => {
    const room = ws.room;
    if (!room || !ws.role) return;
    if (room.sockets[ws.role] === ws) {
      room.sockets[ws.role] = null;
      room.inputs[ws.role] = makeInput();
    }
    if (!Object.values(room.sockets).some(Boolean)) room.emptySince = Date.now();
    else broadcast(room, serializeLobby(room));
  });
});

function collides(map, x, y, radius = 0.28) {
  return Shared.isSolid(map, x - radius, y - radius) || Shared.isSolid(map, x + radius, y - radius) ||
    Shared.isSolid(map, x - radius, y + radius) || Shared.isSolid(map, x + radius, y + radius);
}

function moveEntity(map, entity, vx, vy, dt, radius = 0.28) {
  const nextX = entity.x + vx * dt;
  if (!collides(map, nextX, entity.y, radius)) entity.x = nextX;
  const nextY = entity.y + vy * dt;
  if (!collides(map, entity.x, nextY, radius)) entity.y = nextY;
}

function lineClear(map, ax, ay, bx, by) {
  const distance = Math.hypot(bx - ax, by - ay);
  const steps = Math.ceil(distance * 4);
  for (let i = 1; i < steps; i += 1) {
    const ratio = i / steps;
    if (Shared.isSolid(map, ax + (bx - ax) * ratio, ay + (by - ay) * ratio)) return false;
  }
  return true;
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  return length ? [x / length, y / length] : [0, 0];
}

function damagePlayer(game) {
  if (game.player.invulnerable > 0) return;
  game.player.health -= 1;
  game.player.disguise = false;
  game.player.invulnerable = 1.25;
  game.alert = 1;
  announce({ game }, "HIT! MOVE, LEGS!", 1.1);
  if (game.player.health <= 0) {
    game.status = "lost";
    announce({ game }, "MISSION FAILED — PRESS R TO REGROUP", 999);
  }
}

function nextLevel(game) {
  game.level += 1;
  if (game.level > 5) {
    game.status = "won";
    game.score += Math.ceil(game.time) * 10;
    announce({ game }, "DOSSIER EXTRACTED — CASTLE CLEARED!", 999);
    return;
  }
  const levelData = makeLevel(game.level);
  Object.assign(game, levelData);
  Object.assign(game.player, {
    x: 2.5, y: Shared.MAP_HEIGHT - 2.5, intel: 0, keys: 0, disguise: false,
    ammo: Math.min(20, game.player.ammo + 5), grenades: Math.min(5, game.player.grenades + 1)
  });
  game.bullets = [];
  game.enemyBullets = [];
  game.thrown = [];
  game.explosions = [];
  game.time += 150;
  announce({ game }, `FLOOR ${game.level} — SECURITY TIGHTENED`, 3);
}

function roomPosition(entity) {
  return {
    x: Math.max(0, Math.min(3, Math.floor(entity.x / 10))),
    y: Math.max(0, Math.min(2, Math.floor(entity.y / 8)))
  };
}

function sameRoom(a, b) {
  const roomA = roomPosition(a);
  const roomB = roomPosition(b);
  return roomA.x === roomB.x && roomA.y === roomB.y;
}

function resolveLoot(room, content) {
  const game = room.game;
  const player = game.player;
  if (content === "ammo") {
    player.ammo = Math.min(24, player.ammo + 6);
    announce(room, "AMMUNITION!", 1.4);
  } else if (content === "grenade") {
    player.grenades = Math.min(6, player.grenades + 2);
    announce(room, "GRENADES!", 1.4);
  } else if (content === "key") {
    player.keys += 1;
    announce(room, "IRON KEY!", 1.4);
  } else if (content === "uniform") {
    player.disguise = true;
    announce(room, "GUARD COAT — DISGUISE ON", 2);
  } else if (content === "plans") {
    player.intel = 1;
    game.score += 1000;
    announce(room, "SECRET WAR PLANS!", 2.4);
  } else {
    announce(room, "NOTHING!", 1.3);
  }
}

function updateSearch(room, active, dt) {
  const game = room.game;
  const player = game.player;
  player.searching = false;
  const targets = [
    ...game.chests.filter((chest) => !chest.searched && sameRoom(chest, player) && Math.hypot(chest.x - player.x, chest.y - player.y) < 1.25),
    ...game.enemies.filter((enemy) => !enemy.searched && (enemy.health <= 0 || enemy.state === "surrendered") && sameRoom(enemy, player) && Math.hypot(enemy.x - player.x, enemy.y - player.y) < 1.2)
  ].sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y));

  for (const chest of game.chests) if (chest !== targets[0]) chest.searchProgress = 0;
  for (const enemy of game.enemies) if (enemy !== targets[0]) enemy.searchProgress = 0;
  if (!active || !targets.length) return;

  const target = targets[0];
  player.searching = true;
  if (target.locked) {
    if (player.keys > 0) {
      player.keys -= 1;
      target.locked = false;
      announce(room, "THE KEY FITS…", 1.2);
    } else {
      if (game.searchNotice <= 0) announce(room, "LOCKED — FIND A KEY", 1.2);
      game.searchNotice = 0.8;
      return;
    }
  }
  target.searchProgress = (target.searchProgress || 0) + dt;
  if (target.searchProgress < 0.9) return;
  target.searchProgress = 1;
  target.searched = true;
  if (Object.hasOwn(target, "opened")) target.opened = true;
  game.score += 50;
  resolveLoot(room, target.content || target.loot || "nothing");
}

function updateGame(room, dt) {
  const game = room.game;
  if (game.status !== "playing") return;
  const movement = room.inputs.movement;
  const weapons = room.inputs.weapons;
  const player = game.player;
  const previousRoom = roomPosition(player);
  game.time = Math.max(0, game.time - dt);
  game.searchNotice = Math.max(0, (game.searchNotice || 0) - dt);
  game.voiceCooldown = Math.max(0, (game.voiceCooldown || 0) - dt);
  player.invulnerable = Math.max(0, player.invulnerable - dt);
  player.firing = Math.max(0, player.firing - dt);
  game.alert = Math.max(0, game.alert - dt * 0.1);
  game.explosions = game.explosions.filter((item) => (item.life -= dt) > 0);

  if (game.time <= 0) {
    game.status = "lost";
    announce(room, "LOCKDOWN — PRESS R TO REGROUP", 999);
    return;
  }

  let moveX = movement.search ? 0 : Number(movement.right) - Number(movement.left);
  let moveY = movement.search ? 0 : Number(movement.down) - Number(movement.up);
  [moveX, moveY] = normalize(moveX, moveY);
  const moveSpeed = movement.sneak ? 0.82 : 1.52;
  moveEntity(game.map, player, moveX * moveSpeed, moveY * moveSpeed, dt, 0.3);
  if ((moveX || moveY) && !movement.sneak) game.alert = Math.min(1, game.alert + dt * 0.13);

  const currentRoom = roomPosition(player);
  if (currentRoom.x !== previousRoom.x || currentRoom.y !== previousRoom.y) {
    game.bullets = [];
    game.enemyBullets = [];
    game.thrown = [];
    const roomNumber = (game.level - 1) * 12 + currentRoom.y * 4 + currentRoom.x + 1;
    announce(room, `ROOM ${String(roomNumber).padStart(2, "0")} / 60`, 1.2);
  }

  let aimX = Number(weapons.right) - Number(weapons.left);
  let aimY = Number(weapons.down) - Number(weapons.up);
  if (aimX || aimY) [player.aimX, player.aimY] = normalize(aimX, aimY);

  if (weapons.fire > 0 && player.firing <= 0) {
    if (player.ammo > 0) {
      player.ammo -= 1;
      player.firing = 0.42;
      player.disguise = false;
      game.alert = 1;
      game.bullets.push({
        x: player.x + player.aimX * 0.46, y: player.y + player.aimY * 0.46,
        vx: player.aimX * 8, vy: player.aimY * 8, life: 1.2
      });
    } else announce(room, "CLICK!", 0.7);
  }
  weapons.fire = 0;

  if (weapons.grenade > 0) {
    if (player.grenades > 0) {
      player.grenades -= 1;
      player.disguise = false;
      game.alert = 1;
      game.thrown.push({
        x: player.x + player.aimX * 0.5, y: player.y + player.aimY * 0.5,
        vx: player.aimX * 4.2, vy: player.aimY * 4.2, fuse: 1.35
      });
    } else announce(room, "NO GRENADES!", 0.8);
  }
  weapons.grenade = 0;

  for (const bullet of game.bullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;
    if (Shared.isSolid(game.map, bullet.x, bullet.y)) bullet.life = 0;
    for (const enemy of game.enemies) {
      if (enemy.health > 0 && sameRoom(enemy, bullet) && Math.hypot(enemy.x - bullet.x, enemy.y - bullet.y) < 0.46) {
        enemy.health -= 1;
        enemy.state = "down";
        bullet.life = 0;
        game.score += enemy.health <= 0 ? 200 : 50;
      }
    }
  }
  game.bullets = game.bullets.filter((bullet) => bullet.life > 0);

  for (const grenade of game.thrown) {
    const nextX = grenade.x + grenade.vx * dt;
    const nextY = grenade.y + grenade.vy * dt;
    if (collides(game.map, nextX, grenade.y, 0.16)) grenade.vx *= -0.55;
    else grenade.x = nextX;
    if (collides(game.map, grenade.x, nextY, 0.16)) grenade.vy *= -0.55;
    else grenade.y = nextY;
    grenade.vx *= 0.982;
    grenade.vy *= 0.982;
    grenade.fuse -= dt;
    if (grenade.fuse <= 0) {
      game.explosions.push({ x: grenade.x, y: grenade.y, life: 0.48 });
      for (const enemy of game.enemies) {
        if (enemy.health > 0 && sameRoom(enemy, grenade) && Math.hypot(enemy.x - grenade.x, enemy.y - grenade.y) < 2.35) {
          enemy.health = 0;
          enemy.state = "down";
          game.score += 200;
        }
      }
      if (Math.hypot(player.x - grenade.x, player.y - grenade.y) < 2) damagePlayer(game);
    }
  }
  game.thrown = game.thrown.filter((grenade) => grenade.fuse > 0);

  for (const enemy of game.enemies) {
    if (enemy.health <= 0 || !sameRoom(enemy, player) || enemy.state === "surrendered") continue;
    enemy.cooldown -= dt;
    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const distance = Math.hypot(dx, dy);
    const toEnemyX = enemy.x - player.x;
    const toEnemyY = enemy.y - player.y;
    const aimDot = distance ? (toEnemyX * player.aimX + toEnemyY * player.aimY) / distance : 0;
    const threatened = !enemy.elite && player.ammo > 0 && distance < 5.5 && aimDot > 0.94 &&
      lineClear(game.map, player.x, player.y, enemy.x, enemy.y) && game.alert < 0.78;

    if (threatened) {
      enemy.state = "threatened";
      enemy.facing = Math.atan2(dy, dx);
      enemy.surrenderMeter += dt;
      if (enemy.surrenderMeter >= 0.65) {
        enemy.state = "surrendered";
        announce(room, "KAMERAD! SEARCH HIM", 2);
      }
      continue;
    }
    enemy.surrenderMeter = Math.max(0, enemy.surrenderMeter - dt * 2);

    const seesThroughDisguise = !player.disguise || enemy.elite || game.alert > 0.55 || distance < 1.35;
    const canSee = seesThroughDisguise && distance < 6.6 && lineClear(game.map, enemy.x, enemy.y, player.x, player.y);
    if (canSee) {
      if (enemy.state !== "alert" && game.voiceCooldown <= 0) {
        announce(room, "ACHTUNG!", 1.1);
        game.voiceCooldown = 1.8;
      }
      enemy.state = "alert";
      enemy.facing = Math.atan2(dy, dx);
      game.alert = Math.min(1, game.alert + dt * 0.24);
      const [nx, ny] = normalize(dx, dy);
      if (distance > 3) moveEntity(game.map, enemy, nx * (0.62 + game.level * 0.05), ny * (0.62 + game.level * 0.05), dt, 0.28);
      if (enemy.cooldown <= 0 && distance < 6.2) {
        enemy.cooldown = Math.max(1.05, 2.15 - game.level * 0.13) + (enemy.id % 3) * 0.16;
        game.enemyBullets.push({ x: enemy.x, y: enemy.y, vx: nx * 4.8, vy: ny * 4.8, life: 1.6 });
      }
    } else {
      enemy.state = "patrol";
      if (Math.hypot(enemy.targetX - enemy.x, enemy.targetY - enemy.y) < 0.35) {
        const angle = ((enemy.id * 2.2 + Date.now() / 3600) % 6.28);
        enemy.targetX = enemy.patrolX + Math.cos(angle) * 1.3;
        enemy.targetY = enemy.patrolY + Math.sin(angle) * 1.3;
      }
      const [nx, ny] = normalize(enemy.targetX - enemy.x, enemy.targetY - enemy.y);
      enemy.facing = Math.atan2(ny, nx);
      moveEntity(game.map, enemy, nx * 0.36, ny * 0.36, dt, 0.28);
    }
    if (distance < 0.58) damagePlayer(game);
  }

  for (const bullet of game.enemyBullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;
    if (Shared.isSolid(game.map, bullet.x, bullet.y)) bullet.life = 0;
    if (Math.hypot(player.x - bullet.x, player.y - bullet.y) < 0.38) {
      bullet.life = 0;
      damagePlayer(game);
    }
  }
  game.enemyBullets = game.enemyBullets.filter((bullet) => bullet.life > 0);

  updateSearch(room, movement.search, dt);
  const atStairs = Math.hypot(player.x - (Shared.MAP_WIDTH - 2.5), player.y - 2.5) < 1.15;
  if (atStairs && player.intel === 1) nextLevel(game);
  else if (atStairs && game.searchNotice <= 0) {
    announce(room, "FIND THE WAR PLANS!", 1.3);
    game.searchNotice = 1;
  }
  if (game.flash && Date.now() / 1000 > game.flashUntil) game.flash = "";
}

function damageHunter(room, team, amount = 1) {
  const game = room.game;
  const actor = game.actors[team];
  if (actor.invulnerable > 0 || actor.health <= 0) return;
  actor.health = Math.max(0, actor.health - amount);
  actor.invulnerable = 0.72;
  announce(room, `${team === "guard" ? "GUARD" : "INTRUDER"} HIT!`, 1);
  if (actor.health <= 0) {
    game.status = "finished";
    game.winner = team === "guard" ? "intruder" : "guard";
    announce(room, `${game.winner === "guard" ? "GUARDS" : "INTRUDERS"} WIN — PRESS R FOR REMATCH`, 999);
  }
}

function updateMoonshine(room, team, active, dt) {
  const game = room.game;
  const actor = game.actors[team];
  actor.searching = false;
  const target = game.chests
    .filter((chest) => !chest.opened && sameRoom(chest, actor) && Math.hypot(chest.x - actor.x, chest.y - actor.y) < 1.3)
    .sort((a, b) => Math.hypot(a.x - actor.x, a.y - actor.y) - Math.hypot(b.x - actor.x, b.y - actor.y))[0];
  for (const chest of game.chests) {
    if (chest.searchingTeam === team && chest !== target) {
      chest.searchingTeam = null;
      chest.searchProgress = 0;
    }
  }
  if (!active || !target || (target.searchingTeam && target.searchingTeam !== team)) return;
  actor.searching = true;
  target.searchingTeam = team;
  target.searchProgress += dt;
  if (target.searchProgress < 0.65) return;
  target.opened = true;
  target.searched = true;
  target.searchProgress = 1;
  const recovered = Math.min(3, actor.maxHealth - actor.health);
  actor.health += recovered;
  announce(room, `${team === "guard" ? "GUARDS" : "INTRUDERS"} FOUND MOONSHINE${recovered ? ` — +${recovered} HEALTH` : " — ALREADY FIT"}`, 2);
}

function updateHuntGame(room, dt) {
  const game = room.game;
  if (game.status !== "playing") return;
  game.time = Math.max(0, game.time - dt);
  game.explosions = game.explosions.filter((item) => (item.life -= dt) > 0);
  for (const actor of Object.values(game.actors)) {
    actor.invulnerable = Math.max(0, actor.invulnerable - dt);
    actor.firing = Math.max(0, actor.firing - dt);
  }

  if (game.time <= 0) {
    game.status = "finished";
    const intruderHealth = game.actors.intruder.health;
    const guardHealth = game.actors.guard.health;
    game.winner = intruderHealth === guardHealth ? null : (intruderHealth > guardHealth ? "intruder" : "guard");
    announce(room, game.winner ? `${game.winner === "guard" ? "GUARDS" : "INTRUDERS"} WIN ON HEALTH — PRESS R` : "STALEMATE — PRESS R FOR REMATCH", 999);
    return;
  }

  for (const team of ["intruder", "guard"]) {
    const actor = game.actors[team];
    const movement = room.inputs[`${team}-movement`];
    const weapons = room.inputs[`${team}-weapons`];
    let moveX = movement.search ? 0 : Number(movement.right) - Number(movement.left);
    let moveY = movement.search ? 0 : Number(movement.down) - Number(movement.up);
    [moveX, moveY] = normalize(moveX, moveY);
    const speed = movement.sneak ? 0.95 : 1.62;
    moveEntity(game.map, actor, moveX * speed, moveY * speed, dt, 0.3);

    let aimX = Number(weapons.right) - Number(weapons.left);
    let aimY = Number(weapons.down) - Number(weapons.up);
    if (aimX || aimY) [actor.aimX, actor.aimY] = normalize(aimX, aimY);

    if (weapons.fire > 0 && actor.firing <= 0 && actor.ammo > 0) {
      actor.ammo -= 1;
      actor.firing = 0.34;
      game.bullets.push({
        team,
        x: actor.x + actor.aimX * 0.46,
        y: actor.y + actor.aimY * 0.46,
        vx: actor.aimX * 8.4,
        vy: actor.aimY * 8.4,
        life: 1.45
      });
    }
    weapons.fire = 0;

    if (weapons.grenade > 0 && actor.grenades > 0) {
      actor.grenades -= 1;
      game.thrown.push({
        team,
        x: actor.x + actor.aimX * 0.5,
        y: actor.y + actor.aimY * 0.5,
        vx: actor.aimX * 4.2,
        vy: actor.aimY * 4.2,
        fuse: 1.35
      });
    }
    weapons.grenade = 0;
    updateMoonshine(room, team, movement.search, dt);
  }

  for (const bullet of game.bullets) {
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;
    bullet.life -= dt;
    if (Shared.isSolid(game.map, bullet.x, bullet.y)) bullet.life = 0;
    const targetTeam = bullet.team === "guard" ? "intruder" : "guard";
    const target = game.actors[targetTeam];
    if (bullet.life > 0 && sameRoom(target, bullet) && Math.hypot(target.x - bullet.x, target.y - bullet.y) < 0.42) {
      bullet.life = 0;
      damageHunter(room, targetTeam, 1);
    }
  }
  game.bullets = game.bullets.filter((bullet) => bullet.life > 0);

  for (const grenade of game.thrown) {
    const nextX = grenade.x + grenade.vx * dt;
    const nextY = grenade.y + grenade.vy * dt;
    if (collides(game.map, nextX, grenade.y, 0.16)) grenade.vx *= -0.55;
    else grenade.x = nextX;
    if (collides(game.map, grenade.x, nextY, 0.16)) grenade.vy *= -0.55;
    else grenade.y = nextY;
    grenade.vx *= 0.982;
    grenade.vy *= 0.982;
    grenade.fuse -= dt;
    if (grenade.fuse <= 0) {
      game.explosions.push({ x: grenade.x, y: grenade.y, life: 0.48 });
      const targetTeam = grenade.team === "guard" ? "intruder" : "guard";
      const target = game.actors[targetTeam];
      if (sameRoom(target, grenade) && Math.hypot(target.x - grenade.x, target.y - grenade.y) < 2.25) damageHunter(room, targetTeam, 2);
    }
  }
  game.thrown = game.thrown.filter((grenade) => grenade.fuse > 0);
  if (game.flash && Date.now() / 1000 > game.flashUntil) game.flash = "";
}

function publicState(room, viewerRole = "movement") {
  const game = room.game;
  if (room.mode === "versus") {
    const viewerTeam = teamForRole(viewerRole);
    const opponentTeam = viewerTeam === "guard" ? "intruder" : "guard";
    const player = game.actors[viewerTeam];
    const currentRoom = roomPosition(player);
    let status = game.status;
    if (game.status === "finished") status = game.winner === viewerTeam ? "won" : "lost";
    return {
      type: "state",
      mode: "versus",
      viewerTeam,
      status,
      level: 1,
      time: game.time,
      score: 0,
      alert: 1,
      flash: game.flash,
      room: { x: currentRoom.x, y: currentRoom.y, number: currentRoom.y * 4 + currentRoom.x + 1 },
      player,
      opponent: game.actors[opponentTeam],
      health: {
        intruder: game.actors.intruder.health,
        guard: game.actors.guard.health,
        max: game.actors.intruder.maxHealth
      },
      enemies: [],
      bullets: game.bullets.filter((bullet) => bullet.team === viewerTeam),
      enemyBullets: game.bullets.filter((bullet) => bullet.team !== viewerTeam),
      thrown: game.thrown,
      explosions: game.explosions,
      chests: game.chests,
      intel: [],
      ammo: [],
      connected: Object.fromEntries(Object.entries(room.sockets).map(([role, socket]) => [role, Boolean(socket)]))
    };
  }
  const currentRoom = roomPosition(game.player);
  return {
    type: "state",
    mode: "coop",
    status: game.status,
    level: game.level,
    time: game.time,
    score: game.score,
    alert: game.alert,
    flash: game.flash,
    room: {
      x: currentRoom.x,
      y: currentRoom.y,
      number: (game.level - 1) * 12 + currentRoom.y * 4 + currentRoom.x + 1
    },
    player: game.player,
    enemies: game.enemies,
    bullets: game.bullets,
    enemyBullets: game.enemyBullets,
    thrown: game.thrown,
    explosions: game.explosions,
    chests: game.chests,
    intel: game.intel,
    ammo: game.ammo,
    connected: {
      movement: Boolean(room.sockets.movement),
      weapons: Boolean(room.sockets.weapons)
    }
  };
}

let previous = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - previous) / 1000);
  previous = now;
  for (const [code, room] of rooms) {
    if (room.emptySince && now - room.emptySince > 10 * 60 * 1000) {
      rooms.delete(code);
      continue;
    }
    const ready = rolesForMode(room.mode).every((role) => room.sockets[role]);
    if (ready) {
      if (room.mode === "versus") updateHuntGame(room, dt);
      else updateGame(room, dt);
    }
    if (now - room.lastBroadcast >= 1000 / BROADCAST_RATE) {
      for (const [role, socket] of Object.entries(room.sockets)) if (socket) send(socket, publicState(room, role));
      room.lastBroadcast = now;
    }
  }
}, 1000 / TICK_RATE);

function startServer(port = PORT, host = "0.0.0.0") {
  return server.listen(port, host, () => {
    const address = server.address();
    console.log(`CASTLE CREW // 800 listening on http://localhost:${address.port}`);
  });
}

if (require.main === module) startServer();

module.exports = { server, startServer, makeGame, makeHuntGame, updateGame, updateHuntGame, makeRoom, publicState };
