"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { WebSocket } = require("ws");
const { server, startServer, makeRoom, updateGame } = require("../server.js");

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
