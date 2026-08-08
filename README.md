# Castle Crew // 800

A browser-based, two-player co-op infiltration game inspired by the split-controller feel of early home-computer games. One player controls movement; the other independently aims, shoots, and throws grenades.

## Play locally

```bash
npm install
npm start
```

Open `http://localhost:8080`, create a mission, and send the generated room code or invite URL to the second player. Players on another device on the same Wi-Fi can use the host computer's LAN address in place of `localhost`.

## Controls

- Movement operator: `W A S D` to move, `Shift` to sneak, `E` to search a chest or subdued guard.
- Weapons operator: arrow keys to aim, `Space` to fire, `G` or `Enter` to throw a grenade.
- Gamepads: directional pad/left stick, shoulder button to sneak, A/right trigger to fire, B/left trigger to throw.
- Either operator can press `R` after a win or loss to restart.

## Mission

Search the castle for a key, unlock the chest holding the secret war plans, then reach the northern stairs. Clear five floors—sixty rooms—before the lockdown timer expires. Ordinary guards can be held at gunpoint and searched, disguises fool most patrols, and gunfire or grenades expose you immediately.

## Put it online

Deploy the whole Node project to a host that supports persistent WebSocket connections. The server uses `process.env.PORT` automatically. Rooms live in memory, so keep the service to one instance unless the room state is later moved to a shared store.
