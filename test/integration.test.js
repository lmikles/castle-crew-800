"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { server, startServer, makeRoom, updateGame, updateHuntGame, publicState } = require("../server.js");

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitFor(socket, predicate, timeout = 2500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("Timed out waiting for a WebSocket message"));
    }, timeout);
    function onMessage(raw) {
      const message = JSON.parse(raw);
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    }
    socket.on("message", onMessage);
  });
}

test("movement and weapons operators share one live agent", async (t) => {
  await new Promise((resolve) => startServer(0, "127.0.0.1").once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}`;

  const legs = await openSocket(url);
  const legsJoined = waitFor(legs, (message) => message.type === "joined");
  legs.send(JSON.stringify({ type: "create", role: "movement" }));
  const { code } = await legsJoined;

  const arms = await openSocket(url);
  const armsJoined = waitFor(arms, (message) => message.type === "joined");
  arms.send(JSON.stringify({ type: "join", code, role: "weapons" }));
  await armsJoined;

  const initial = await waitFor(legs, (message) => message.type === "state" && message.status === "playing");
  legs.send(JSON.stringify({ type: "input", input: { right: true } }));
  arms.send(JSON.stringify({ type: "input", input: { right: true, fire: 1 } }));
  const changed = await waitFor(legs, (message) =>
    message.type === "state" && message.player.x > initial.player.x && message.player.ammo < initial.player.ammo
  );

  assert.equal(changed.connected.movement, true);
  assert.equal(changed.connected.weapons, true);
  assert.ok(changed.player.x > initial.player.x, "movement operator should move the shared agent");
  assert.equal(changed.player.ammo, initial.player.ammo - 1, "weapons operator should fire one shot");
  assert.ok(changed.bullets.length > 0, "a player bullet should exist in the shared state");

  legs.close();
  arms.close();
});

test("movement operator can search a container and recover its contents", () => {
  const room = makeRoom("TEST");
  room.game.status = "playing";
  room.game.enemies = [];
  const chest = room.game.chests.find((item) => item.content === "key");
  assert.ok(chest, "each floor should contain a key");
  room.game.player.x = chest.x - 1;
  room.game.player.y = chest.y;
  room.inputs.movement.search = true;

  for (let frame = 0; frame < 22; frame += 1) updateGame(room, 0.05);

  assert.equal(chest.searched, true);
  assert.equal(room.game.player.keys, 1);
  assert.equal(room.game.flash, "IRON KEY!");
});

test("four-player Manhunt supports team health, combat, and moonshine", () => {
  const room = makeRoom("HUNT", "versus");
  assert.deepEqual(Object.keys(room.sockets), [
    "intruder-movement", "intruder-weapons", "guard-movement", "guard-weapons"
  ]);
  assert.equal(room.game.chests.length, 12);
  assert.ok(room.game.chests.every((chest) => chest.content === "moonshine"));

  room.game.status = "playing";
  room.game.actors.intruder.x = 3;
  room.game.actors.intruder.y = 21;
  room.game.actors.intruder.aimX = 1;
  room.game.actors.intruder.aimY = 0;
  room.game.actors.guard.x = 4.2;
  room.game.actors.guard.y = 21;
  room.inputs["intruder-weapons"].fire = 1;
  for (let frame = 0; frame < 5; frame += 1) updateHuntGame(room, 0.05);
  assert.equal(room.game.actors.guard.health, 5, "intruder pistol should damage the guard body");

  const chest = room.game.chests[0];
  const intruder = room.game.actors.intruder;
  intruder.health = 2;
  intruder.x = chest.x - 1;
  intruder.y = chest.y;
  room.inputs["intruder-movement"].search = true;
  for (let frame = 0; frame < 15; frame += 1) updateHuntGame(room, 0.05);
  assert.equal(chest.opened, true, "moonshine chest should open after searching");
  assert.equal(intruder.health, 5, "moonshine should restore up to three health");

  const intruderView = publicState(room, "intruder-movement");
  const guardView = publicState(room, "guard-weapons");
  assert.equal(intruderView.viewerTeam, "intruder");
  assert.equal(guardView.viewerTeam, "guard");
  assert.equal(intruderView.player.team, "intruder");
  assert.equal(guardView.player.team, "guard");
  assert.deepEqual(intruderView.health, { intruder: 5, guard: 5, max: 6 });
});

test("Manhunt starts when all four online controller roles join", async (t) => {
  await new Promise((resolve) => startServer(0, "127.0.0.1").once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `ws://127.0.0.1:${server.address().port}`;
  const roles = ["intruder-movement", "intruder-weapons", "guard-movement", "guard-weapons"];
  const sockets = [];

  const creator = await openSocket(url);
  sockets.push(creator);
  const creatorJoined = waitFor(creator, (message) => message.type === "joined");
  creator.send(JSON.stringify({ type: "create", mode: "versus", role: roles[0] }));
  const { code } = await creatorJoined;

  for (const role of roles.slice(1, -1)) {
    const socket = await openSocket(url);
    sockets.push(socket);
    const joined = waitFor(socket, (message) => message.type === "joined");
    socket.send(JSON.stringify({ type: "join", code, mode: "versus", role }));
    await joined;
  }

  const liveState = waitFor(creator, (message) => message.type === "state" && message.status === "playing");
  const finalSocket = await openSocket(url);
  sockets.push(finalSocket);
  const finalJoined = waitFor(finalSocket, (message) => message.type === "joined");
  finalSocket.send(JSON.stringify({ type: "join", code, mode: "versus", role: roles.at(-1) }));
  await finalJoined;
  const state = await liveState;

  assert.equal(state.mode, "versus");
  assert.ok(roles.every((role) => state.connected[role]), "all four controller roles should be online");
  assert.equal(state.health.intruder, 6);
  assert.equal(state.health.guard, 6);
  for (const socket of sockets) socket.close();
});
