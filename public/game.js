(() => {
  "use strict";

  const canvas = document.querySelector("#game");
  const ctx = canvas.getContext("2d", { alpha: false });
  const minimap = document.querySelector("#minimap");
  const mapCtx = minimap.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = false;
  mapCtx.imageSmoothingEnabled = false;

  const ui = {
    signal: document.querySelector("#signal"),
    create: document.querySelector("#create-button"),
    join: document.querySelector("#join-button"),
    dialog: document.querySelector("#mission-dialog"),
    form: document.querySelector("#mission-form"),
    dialogEyebrow: document.querySelector("#dialog-eyebrow"),
    dialogTitle: document.querySelector("#dialog-title"),
    dialogCopy: document.querySelector("#dialog-copy"),
    dialogSubmit: document.querySelector("#dialog-submit"),
    dialogError: document.querySelector("#dialog-error"),
    roomField: document.querySelector("#room-field"),
    roomInput: document.querySelector("#room-code-input"),
    mission: document.querySelector("#mission-panel"),
    missionStatus: document.querySelector("#mission-status"),
    missionOrder: document.querySelector("#mission-order"),
    objectiveStep: document.querySelector("#objective-step"),
    objectiveText: document.querySelector("#objective-text"),
    coopHealth: document.querySelector("#coop-health"),
    agentHealth: document.querySelector("#agent-health"),
    huntHealth: document.querySelector("#hunt-health"),
    intruderHealth: document.querySelector("#intruder-health"),
    guardHealth: document.querySelector("#guard-health"),
    mapPanel: document.querySelector("#map-panel"),
    mapFloor: document.querySelector("#map-floor"),
    copyCode: document.querySelector("#copy-code"),
    leave: document.querySelector("#leave-button"),
    movementCard: document.querySelector("#movement-card"),
    weaponsCard: document.querySelector("#weapons-card"),
    guardMovementCard: document.querySelector("#guard-movement-card"),
    guardWeaponsCard: document.querySelector("#guard-weapons-card"),
    guardGrid: document.querySelector("#guard-operator-grid"),
    intruderTeamLabel: document.querySelector("#intruder-team-label"),
    guardTeamLabel: document.querySelector("#guard-team-label"),
    score: document.querySelector("#score"),
    floor: document.querySelector("#floor"),
    timer: document.querySelector("#timer"),
    gameMessage: document.querySelector("#game-message"),
    endScreen: document.querySelector("#end-screen"),
    endKicker: document.querySelector("#end-kicker"),
    endTitle: document.querySelector("#end-title"),
    danceFloor: document.querySelector("#dance-floor"),
    finalScore: document.querySelector("#final-score"),
    scoreForm: document.querySelector("#score-form"),
    scoreInitials: document.querySelector("#score-initials"),
    scoreList: document.querySelector("#score-list"),
    rematch: document.querySelector("#rematch-button"),
    toast: document.querySelector("#toast")
  };

  const media = {
    background: document.querySelector("#music-background"),
    win: document.querySelector("#sound-win"),
    death: document.querySelector("#sound-death"),
    key: document.querySelector("#sound-key")
  };

  const PALETTE = {
    dark: "#08090d",
    deepest: "#020309",
    floor: "#090a10",
    floorDark: "#11131c",
    wall: "#d9d6d0",
    mortar: "#7e7d86",
    red: "#b56d6d",
    rust: "#7b5961",
    glow: "#e1dda9",
    paper: "#d9d6d0",
    blue: "#7683b5",
    white: "#f6f2e9"
  };

  let socket;
  let pendingAction = null;
  let roomCode = "";
  let myRole = "";
  let myMode = "coop";
  let gameState = null;
  let lobbyState = null;
  let dialogMode = "create";
  let lastFrame = performance.now();
  let attractTime = 0;
  let lastBulletCount = 0;
  let lastExplosionCount = 0;
  let lastFlash = "";
  let lastRoomNumber = 0;
  let roomChangeAt = 0;
  let audioContext = null;
  let toastTimer;
  let lanOrigin = "";
  let visitedMapKey = "";
  let visitedRooms = new Set();
  let lastStatus = "";
  let endScreenStatus = "";

  const held = new Set();
  const impulses = { fire: 0, grenade: 0 };
  const gamepadHeld = { fire: false, grenade: false };

  const HUNT_ROLES = ["intruder-movement", "intruder-weapons", "guard-movement", "guard-weapons"];

  function isMovementRole(role = myRole) {
    return role === "movement" || role.endsWith("-movement");
  }

  function isWeaponsRole(role = myRole) {
    return role === "weapons" || role.endsWith("-weapons");
  }

  function roleTeam(role = myRole) {
    return role.startsWith("guard-") ? "guard" : "intruder";
  }

  function toast(message) {
    ui.toast.textContent = message;
    ui.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove("show"), 1600);
  }

  function initAudio() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    media.background.volume = 0.22;
    if (media.background.paused) media.background.play().catch(() => {});
  }

  function playTrack(track, volume = .7) {
    track.volume = volume;
    track.currentTime = 0;
    track.play().catch(() => {});
  }

  function tone(frequency, length, type = "square", volume = 0.035, slide = 0) {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (slide) oscillator.frequency.exponentialRampToValueAtTime(Math.max(30, frequency + slide), now + length);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + length);
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + length);
  }

  function noiseBurst(length = 0.18, volume = 0.05) {
    if (!audioContext) return;
    const frames = Math.ceil(audioContext.sampleRate * length);
    const buffer = audioContext.createBuffer(1, frames, audioContext.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    source.buffer = buffer;
    gain.gain.value = volume;
    source.connect(gain).connect(audioContext.destination);
    source.start();
  }

  function voiceCue(text) {
    if (!audioContext || !window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.72;
    utterance.pitch = 0.45;
    utterance.volume = 0.42;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function connect() {
    if (socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${protocol}//${location.host}`);
    ui.signal.querySelector("span").textContent = "CONNECTING";
    socket.addEventListener("open", () => {
      ui.signal.classList.add("online");
      ui.signal.querySelector("span").textContent = "LINK READY";
      if (pendingAction) {
        socket.send(JSON.stringify(pendingAction));
        pendingAction = null;
      }
    });
    socket.addEventListener("close", () => {
      ui.signal.classList.remove("online");
      ui.signal.querySelector("span").textContent = "LINK LOST";
      if (roomCode) {
        ui.gameMessage.hidden = false;
        ui.gameMessage.textContent = "RADIO LINK LOST — RELOADING…";
        setTimeout(() => location.reload(), 1800);
      } else {
        setTimeout(connect, 1400);
      }
    });
    socket.addEventListener("message", ({ data }) => handleMessage(JSON.parse(data)));
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    else {
      pendingAction = message;
      connect();
    }
  }

  function handleMessage(message) {
    if (message.type === "error") {
      ui.dialogError.textContent = message.message;
      if (!ui.dialog.open) ui.dialog.showModal();
      tone(90, .2, "square", .04, -25);
      return;
    }
    if (message.type === "joined") {
      roomCode = message.code;
      myRole = message.role;
      myMode = message.mode || "coop";
      sessionStorage.setItem("castleCrewMission", JSON.stringify({ code: roomCode, role: myRole, mode: myMode }));
      ui.dialog.close();
      ui.copyCode.textContent = roomCode;
      ui.mission.hidden = false;
      ui.missionOrder.hidden = false;
      ui.mapPanel.hidden = false;
      document.body.classList.add("in-mission");
      document.body.classList.toggle("versus-mode", myMode === "versus");
      applyModePresentation();
      updateRoleCards();
      document.querySelector("#hero").scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", `?room=${roomCode}&mode=${myMode}`);
      tone(220, .09, "square", .03, 110);
      setTimeout(() => tone(440, .12, "square", .025), 100);
      if (message.recovered) toast("MISSION LINK RECOVERED");
      return;
    }
    if (message.type === "lobby") {
      myMode = message.mode || myMode;
      lobbyState = message;
      updateRoleCards();
      return;
    }
    if (message.type === "start") {
      ui.missionStatus.textContent = message.mode === "versus" ? "All four operators online. The hunt is live." : "Both operators online. The castle is live.";
      tone(180, .1, "square", .035, 170);
      setTimeout(() => tone(360, .18, "square", .035, 180), 120);
      return;
    }
    if (message.type === "state") {
      if (message.bullets.length > lastBulletCount) tone(130, .075, "square", .035, -75);
      if (message.explosions.length > lastExplosionCount) noiseBurst(.25, .075);
      if (message.flash && message.flash !== lastFlash) {
        if (message.flash.includes("ACHTUNG")) voiceCue("Achtung!");
        if (message.flash.includes("KAMERAD")) voiceCue("Kamerad!");
        if (message.flash.includes("WAR PLANS")) {
          tone(240, .1, "square", .03, 220);
          setTimeout(() => tone(480, .16, "square", .03, 180), 120);
        }
        if (message.flash.includes("IRON KEY")) playTrack(media.key, .72);
      }
      if (message.room?.number && message.room.number !== lastRoomNumber) {
        roomChangeAt = performance.now();
        tone(72, .08, "square", .025, 30);
      }
      lastBulletCount = message.bullets.length;
      lastExplosionCount = message.explosions.length;
      lastFlash = message.flash;
      lastRoomNumber = message.room?.number || lastRoomNumber;
      const nextMapKey = `${message.mode}:${message.level}:${message.mapSeed || 0}`;
      if (nextMapKey !== visitedMapKey) {
        visitedMapKey = nextMapKey;
        visitedRooms = new Set();
      }
      if (message.room) visitedRooms.add(`${message.room.x},${message.room.y}`);
      gameState = message;
      updateHud();
      updateObjective(message);
      drawMinimap(message);
      if (["won", "lost"].includes(message.status) && message.status !== lastStatus) showEndScreen(message.status, message.score);
      if (message.status === "playing" && ["won", "lost"].includes(lastStatus)) hideEndScreen();
      lastStatus = message.status;
    }
  }

  function roleCards() {
    return myMode === "versus"
      ? {
          "intruder-movement": ui.movementCard,
          "intruder-weapons": ui.weaponsCard,
          "guard-movement": ui.guardMovementCard,
          "guard-weapons": ui.guardWeaponsCard
        }
      : { movement: ui.movementCard, weapons: ui.weaponsCard };
  }

  function applyModePresentation() {
    const hunt = myMode === "versus";
    ui.coopHealth.hidden = hunt;
    ui.huntHealth.hidden = !hunt;
    ui.guardGrid.hidden = !hunt;
    ui.intruderTeamLabel.hidden = !hunt;
    ui.guardTeamLabel.hidden = !hunt;
    const movementKicker = ui.movementCard.querySelector(".operator-kicker");
    const weaponsKicker = ui.weaponsCard.querySelector(".operator-kicker");
    movementKicker.textContent = hunt ? "INTRUDER MOVEMENT" : "MOVEMENT OPERATOR";
    weaponsKicker.textContent = hunt ? "INTRUDER WEAPONS" : "WEAPONS OPERATOR";
    ui.movementCard.querySelector("h3").textContent = hunt ? "Intruder Legs" : "The Legs";
    ui.weaponsCard.querySelector("h3").textContent = hunt ? "Intruder Arms" : "The Arms";
    document.querySelector(".mission-footer .objective").innerHTML = hunt
      ? "<span>OBJECTIVE</span> Hunt the opposing team. Search chests for healing moonshine."
      : "<span>OBJECTIVE</span> Find a key, recover the war plans, then reach the northern stairs.";
    ui.mapPanel.querySelector(".map-legend span:last-child").lastChild.textContent = hunt ? "MOONSHINE" : "STAIRS";
  }

  function updateRoleCards() {
    const cards = roleCards();
    const players = lobbyState?.players || lobbyState?.connected || Object.fromEntries(Object.keys(cards).map((role) => [role, myRole === role]));
    for (const [role, card] of Object.entries(cards)) {
      const online = Boolean(players[role]);
      card.classList.toggle("online", online);
      card.classList.toggle("you", myRole === role);
      card.querySelector(".operator-status").textContent = online ? "ONLINE" : "WAITING";
    }
    const ready = Object.keys(cards).every((role) => players[role]);
    if (ready) ui.missionStatus.textContent = myMode === "versus" ? "All four operators online. The hunt is live." : "Both operators online. The castle is live.";
    else if (myRole) {
      const count = Object.values(players).filter(Boolean).length;
      ui.missionStatus.textContent = myMode === "versus"
        ? `You are ${myRole.replace("-", " ")}. ${count}/4 operators online — share ${roomCode}.`
        : `You are ${myRole === "movement" ? "the Legs" : "the Arms"}. Share ${roomCode} with your partner.`;
    }
  }

  function updateHud() {
    if (!gameState) return;
    ui.score.textContent = String(gameState.score).padStart(6, "0");
    ui.floor.textContent = gameState.mode === "versus" ? "MANHUNT" : `${String(gameState.level).padStart(2, "0")} / 05`;
    const seconds = Math.max(0, Math.ceil(gameState.time));
    ui.timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    updateRoleCardsFromConnected(gameState.connected);
    const required = gameState.mode === "versus" ? HUNT_ROLES : ["movement", "weapons"];
    const ready = required.every((role) => gameState.connected[role]);
    if (gameState.mode === "versus" && gameState.health) {
      const healthGlyphs = (value) => "■".repeat(value) + "□".repeat(Math.max(0, gameState.health.max - value));
      ui.intruderHealth.textContent = healthGlyphs(gameState.health.intruder);
      ui.guardHealth.textContent = healthGlyphs(gameState.health.guard);
    } else {
      const health = Math.max(0, gameState.player.health || 0);
      ui.agentHealth.textContent = "■".repeat(health) + "□".repeat(Math.max(0, 4 - health));
      ui.coopHealth.classList.toggle("danger", health <= 1);
    }
    if (!ready && roomCode) {
      ui.gameMessage.hidden = false;
      ui.gameMessage.textContent = gameState.mode === "versus" ? "AWAITING FOUR OPERATORS…" : "AWAITING SECOND OPERATOR…";
    } else if (gameState.flash) {
      ui.gameMessage.hidden = false;
      ui.gameMessage.textContent = gameState.flash;
    } else if (["won", "lost"].includes(gameState.status)) {
      ui.gameMessage.hidden = false;
      ui.gameMessage.textContent = gameState.mode === "versus"
        ? (gameState.status === "won" ? "YOUR TEAM WINS — PRESS R FOR REMATCH" : "YOUR TEAM IS DOWN — PRESS R FOR REMATCH")
        : (gameState.status === "won" ? "CASTLE CLEARED — PRESS R TO PLAY AGAIN" : "MISSION FAILED — PRESS R TO REGROUP");
    } else {
      ui.gameMessage.hidden = true;
    }
  }

  function updateObjective(state) {
    if (state.mode === "versus") {
      const enemy = state.viewerTeam === "guard" ? "intruders" : "guards";
      ui.objectiveStep.textContent = "MANHUNT";
      ui.objectiveText.textContent = `Track and eliminate the ${enemy}. Hold E at moonshine chests to restore health.`;
      return;
    }
    let step = 1;
    let text = "Find a key. Search guards and containers.";
    if ((state.player.keys || 0) > 0 && !state.player.intel) {
      step = 2;
      text = "Key acquired. Find and unlock the war plans chest.";
    } else if (state.player.intel) {
      step = 3;
      text = "War plans secured. Reach the northern stairs.";
    }
    ui.objectiveStep.textContent = `0${step} / 03`;
    ui.objectiveText.textContent = text;
  }

  function renderScores(scores) {
    ui.scoreList.innerHTML = "";
    const entries = scores.length ? scores.slice(0, 5) : [{ initials: "---", score: 0 }];
    for (const entry of entries) {
      const item = document.createElement("li");
      const initials = document.createElement("b");
      const score = document.createElement("em");
      initials.textContent = entry.initials;
      score.textContent = String(entry.score).padStart(6, "0");
      item.append(initials, score);
      ui.scoreList.append(item);
    }
  }

  async function loadScores() {
    try {
      const response = await fetch("/api/scores", { cache: "no-store" });
      const data = await response.json();
      renderScores(data.scores || []);
    } catch { renderScores([]); }
  }

  function showEndScreen(status, score) {
    endScreenStatus = status;
    const won = status === "won";
    ui.endScreen.hidden = false;
    ui.endScreen.classList.toggle("defeat", !won);
    ui.endKicker.textContent = won ? "MISSION COMPLETE" : "OPERATOR DOWN";
    ui.endTitle.textContent = won ? "YOU WIN" : "YOU DIED";
    ui.danceFloor.hidden = !won;
    ui.scoreForm.hidden = !won;
    ui.finalScore.textContent = String(score || 0).padStart(6, "0");
    const postButton = ui.scoreForm.querySelector("button");
    postButton.disabled = false;
    postButton.textContent = "POST SCORE";
    media.background.pause();
    playTrack(won ? media.win : media.death, won ? .8 : .72);
    loadScores();
    if (won) setTimeout(() => ui.scoreInitials.select(), 250);
  }

  function hideEndScreen() {
    ui.endScreen.hidden = true;
    endScreenStatus = "";
    if (audioContext) media.background.play().catch(() => {});
  }

  function drawMinimap(state) {
    const map = CastleShared.generateMap(state.level, state.mapSeed);
    const width = minimap.width;
    const height = minimap.height;
    const padding = 8;
    const scale = Math.min(
      (width - padding * 2) / CastleShared.MAP_WIDTH,
      (height - padding * 2) / CastleShared.MAP_HEIGHT
    );
    const offsetX = Math.floor((width - CastleShared.MAP_WIDTH * scale) / 2);
    const offsetY = Math.floor((height - CastleShared.MAP_HEIGHT * scale) / 2);

    mapCtx.fillStyle = "#020609";
    mapCtx.fillRect(0, 0, width, height);

    mapCtx.strokeStyle = "#18201e";
    mapCtx.lineWidth = 1;
    for (let roomY = 0; roomY < 3; roomY += 1) {
      for (let roomX = 0; roomX < 4; roomX += 1) {
        mapCtx.strokeRect(
          Math.round(offsetX + roomX * ROOM_WIDTH * scale) + .5,
          Math.round(offsetY + roomY * ROOM_HEIGHT * scale) + .5,
          Math.round(ROOM_WIDTH * scale) - 1,
          Math.round(ROOM_HEIGHT * scale) - 1
        );
      }
    }

    const room = state.room || roomOf(state.player);
    mapCtx.fillStyle = "rgba(219, 229, 108, .07)";
    mapCtx.fillRect(
      offsetX + room.x * ROOM_WIDTH * scale,
      offsetY + room.y * ROOM_HEIGHT * scale,
      ROOM_WIDTH * scale,
      ROOM_HEIGHT * scale
    );
    mapCtx.strokeStyle = "rgba(219, 229, 108, .42)";
    mapCtx.lineWidth = 1;
    mapCtx.strokeRect(
      Math.round(offsetX + room.x * ROOM_WIDTH * scale) + .5,
      Math.round(offsetY + room.y * ROOM_HEIGHT * scale) + .5,
      Math.round(ROOM_WIDTH * scale) - 1,
      Math.round(ROOM_HEIGHT * scale) - 1
    );

    for (let y = 0; y < CastleShared.MAP_HEIGHT; y += 1) {
      for (let x = 0; x < CastleShared.MAP_WIDTH; x += 1) {
        const tileRoom = `${Math.max(0, Math.min(3, Math.floor(x / ROOM_WIDTH)))},${Math.max(0, Math.min(2, Math.floor(y / ROOM_HEIGHT)))}`;
        if (!visitedRooms.has(tileRoom)) continue;
        const tile = map[y][x];
        const px = offsetX + x * scale;
        const py = offsetY + y * scale;
        if (tile === "#") {
          mapCtx.fillStyle = "#677478";
          mapCtx.fillRect(Math.floor(px), Math.floor(py), Math.ceil(scale), Math.ceil(scale));
        } else if (tile === "+") {
          mapCtx.fillStyle = "#dbe56c";
          mapCtx.fillRect(Math.floor(px + scale * .3), Math.floor(py + scale * .3), Math.max(1, scale * .4), Math.max(1, scale * .4));
        } else if (tile === "E") {
          mapCtx.strokeStyle = "#c94b37";
          mapCtx.lineWidth = 1.5;
          mapCtx.strokeRect(Math.floor(px) - 1, Math.floor(py) - 1, Math.ceil(scale) + 2, Math.ceil(scale) + 2);
        }
      }
    }

    if (state.mode === "versus") {
      mapCtx.fillStyle = "#b56d6d";
      for (const chest of state.chests || []) {
        if (chest.opened) continue;
        const chestRoom = roomOf(chest);
        if (!visitedRooms.has(`${chestRoom.x},${chestRoom.y}`)) continue;
        mapCtx.fillRect(
          Math.round(offsetX + chest.x * scale) - 1,
          Math.round(offsetY + chest.y * scale) - 1,
          3,
          3
        );
      }
    }

    const playerX = offsetX + state.player.x * scale;
    const playerY = offsetY + state.player.y * scale;
    mapCtx.fillStyle = "#dbe56c";
    mapCtx.fillRect(Math.round(playerX) - 2, Math.round(playerY) - 2, 5, 5);
    mapCtx.fillStyle = "#f6f2e9";
    mapCtx.fillRect(Math.round(playerX), Math.round(playerY), 1, 1);

    ui.mapFloor.textContent = String(state.level).padStart(2, "0");
    minimap.setAttribute("aria-label", state.mode === "versus"
      ? `Fog-of-war Manhunt map. ${visitedRooms.size} of 12 rooms explored; visible moonshine chests are marked in red.`
      : `Fog-of-war floor ${state.level} map. ${visitedRooms.size} of 12 rooms explored.`);
  }

  function updateRoleCardsFromConnected(connected) {
    if (!connected) return;
    for (const [role, card] of Object.entries(roleCards())) {
      card.classList.toggle("online", connected[role]);
      card.classList.toggle("you", myRole === role);
      card.querySelector(".operator-status").textContent = connected[role] ? "ONLINE" : "WAITING";
    }
  }

  function syncModeChoices(gameMode, preferredRole = "") {
    const normalized = gameMode === "versus" ? "versus" : "coop";
    const modeInput = ui.form.querySelector(`input[name="mode"][value="${normalized}"]`);
    if (modeInput) modeInput.checked = true;
    const available = [];
    for (const choice of ui.form.querySelectorAll(".role-choice[data-mode]")) {
      const visible = choice.dataset.mode === normalized;
      choice.hidden = !visible;
      const input = choice.querySelector("input[name='role']");
      input.disabled = !visible;
      if (visible) available.push(input);
    }
    const preferred = available.find((input) => input.value === preferredRole);
    const current = available.find((input) => input.checked);
    (preferred || current || available[0]).checked = true;
    ui.dialogCopy.textContent = normalized === "versus"
      ? "Four operators control two bodies. Choose your side and controller."
      : (dialogMode === "join" ? "Enter the four-character code from your partner." : "Your partner will take the other half of the agent.");
  }

  function openDialog(mode) {
    dialogMode = mode;
    ui.dialogError.textContent = "";
    ui.roomField.hidden = mode !== "join";
    ui.dialogEyebrow.textContent = mode === "join" ? "JOIN MISSION" : "NEW MISSION";
    ui.dialogTitle.textContent = mode === "join" ? "Tune to their room." : "Choose your controller.";
    ui.dialogSubmit.firstChild.textContent = mode === "join" ? "JOIN ROOM " : "CREATE ROOM ";
    const params = new URLSearchParams(location.search);
    const queryCode = params.get("room");
    if (queryCode && mode === "join") ui.roomInput.value = queryCode.slice(0, 4).toUpperCase();
    const invitedRole = params.get("role") || "";
    const invitedMode = params.get("mode") === "versus" ? "versus" : "coop";
    syncModeChoices(mode === "join" ? invitedMode : "coop", mode === "join" ? invitedRole : "");
    ui.dialog.showModal();
    if (mode === "join") setTimeout(() => ui.roomInput.focus(), 50);
  }

  ui.create.addEventListener("click", () => { initAudio(); openDialog("create"); });
  ui.join.addEventListener("click", () => { initAudio(); openDialog("join"); });
  ui.roomInput.addEventListener("input", () => {
    ui.roomInput.value = ui.roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
  });
  ui.form.querySelector("#mode-fieldset").addEventListener("change", (event) => {
    if (event.target.name === "mode") syncModeChoices(event.target.value);
  });
  ui.form.addEventListener("submit", (event) => {
    event.preventDefault();
    initAudio();
    const formData = new FormData(ui.form);
    const role = formData.get("role");
    const mode = formData.get("mode");
    if (dialogMode === "join") {
      const code = ui.roomInput.value.trim().toUpperCase();
      if (code.length !== 4) {
        ui.dialogError.textContent = "A room code has four characters.";
        return;
      }
      send({ type: "join", code, role, mode });
    } else send({ type: "create", role, mode });
  });
  ui.scoreInitials.addEventListener("input", () => {
    ui.scoreInitials.value = ui.scoreInitials.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3);
  });
  ui.scoreForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const initials = ui.scoreInitials.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3).padEnd(3, "A");
    ui.scoreInitials.value = initials;
    try { localStorage.setItem("castleCrewInitials", initials); } catch {}
    const response = await fetch("/api/scores", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initials, score: gameState?.score || 0, mode: gameState?.mode || "coop" })
    });
    const data = await response.json();
    renderScores(data.scores || []);
    const postButton = ui.scoreForm.querySelector("button");
    postButton.disabled = true;
    postButton.textContent = "SCORE POSTED";
    toast("HIGH SCORE POSTED");
  });
  ui.rematch.addEventListener("click", () => send({ type: "restart" }));
  ui.copyCode.addEventListener("click", async () => {
    const localHost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const inviteOrigin = localHost && lanOrigin ? lanOrigin : location.origin;
    const partnerRole = myRole === "movement" ? "weapons" : "movement";
    const shareUrl = myMode === "versus"
      ? `${inviteOrigin}${location.pathname}?room=${roomCode}&mode=versus`
      : `${inviteOrigin}${location.pathname}?room=${roomCode}&mode=coop&role=${partnerRole}`;
    try { await navigator.clipboard.writeText(`Join my Castle Crew mission: ${roomCode}\n${shareUrl}`); toast("INVITE COPIED"); }
    catch { await navigator.clipboard.writeText(roomCode); toast("CODE COPIED"); }
    tone(520, .08, "square", .025, 160);
  });
  ui.leave.addEventListener("click", () => {
    sessionStorage.removeItem("castleCrewMission");
    history.replaceState(null, "", location.pathname);
    location.reload();
  });

  const keyMap = {
    KeyW: "up", KeyS: "down", KeyA: "left", KeyD: "right",
    ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right"
  };

  addEventListener("keydown", (event) => {
    if (!roomCode) return;
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
    held.add(event.code);
    if (!event.repeat && isWeaponsRole() && event.code === "Space") {
      impulses.fire = 1;
      sendControls();
    }
    if (!event.repeat && isWeaponsRole() && (event.code === "KeyG" || event.code === "Enter")) {
      impulses.grenade = 1;
      sendControls();
    }
    if (!event.repeat && event.code === "KeyR" && ["won", "lost"].includes(gameState?.status)) send({ type: "restart" });
  });
  addEventListener("keyup", (event) => held.delete(event.code));
  addEventListener("blur", () => held.clear());

  function gamepadInput() {
    const pad = navigator.getGamepads?.()[0];
    if (!pad) return null;
    const threshold = 0.35;
    const input = {
      left: (pad.axes[0] || 0) < -threshold || pad.buttons[14]?.pressed,
      right: (pad.axes[0] || 0) > threshold || pad.buttons[15]?.pressed,
      up: (pad.axes[1] || 0) < -threshold || pad.buttons[12]?.pressed,
      down: (pad.axes[1] || 0) > threshold || pad.buttons[13]?.pressed,
      sneak: Boolean(pad.buttons[4]?.pressed || pad.buttons[5]?.pressed),
      search: Boolean(pad.buttons[2]?.pressed)
    };
    const fireNow = Boolean(pad.buttons[0]?.pressed || pad.buttons[7]?.pressed);
    const grenadeNow = Boolean(pad.buttons[1]?.pressed || pad.buttons[6]?.pressed);
    if (fireNow && !gamepadHeld.fire) impulses.fire = 1;
    if (grenadeNow && !gamepadHeld.grenade) impulses.grenade = 1;
    gamepadHeld.fire = fireNow;
    gamepadHeld.grenade = grenadeNow;
    return input;
  }

  function collectInput() {
    const pad = gamepadInput();
    if (isMovementRole()) {
      return {
        up: held.has("KeyW") || pad?.up,
        down: held.has("KeyS") || pad?.down,
        left: held.has("KeyA") || pad?.left,
        right: held.has("KeyD") || pad?.right,
        sneak: held.has("ShiftLeft") || held.has("ShiftRight") || pad?.sneak,
        search: held.has("KeyE") || pad?.search,
        fire: 0, grenade: 0
      };
    }
    return {
      up: held.has("ArrowUp") || pad?.up,
      down: held.has("ArrowDown") || pad?.down,
      left: held.has("ArrowLeft") || pad?.left,
      right: held.has("ArrowRight") || pad?.right,
      sneak: false, search: false,
      fire: impulses.fire,
      grenade: impulses.grenade
    };
  }

  function sendControls() {
    if (!roomCode || !myRole) return;
    const input = collectInput();
    send({ type: "input", input });
    impulses.fire = 0;
    impulses.grenade = 0;
  }
  setInterval(sendControls, 1000 / 20);

  function rect(x, y, width, height, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), Math.round(width), Math.round(height));
  }

  const ROOM_WIDTH = 10;
  const ROOM_HEIGHT = 8;
  const CELL_W = 58;
  const CELL_H = 40;
  const ROOM_LEFT = 30;
  const ROOM_TOP = 30;
  const ROOM_RIGHT = 610;
  const ROOM_BOTTOM = 350;

  function roomOf(entity) {
    return {
      x: Math.max(0, Math.min(3, Math.floor(entity.x / ROOM_WIDTH))),
      y: Math.max(0, Math.min(2, Math.floor(entity.y / ROOM_HEIGHT)))
    };
  }

  function visibleInRoom(entity, room) {
    const entityRoom = roomOf(entity);
    return entityRoom.x === room.x && entityRoom.y === room.y;
  }

  function screenPoint(entity, room) {
    return {
      x: ROOM_LEFT + (entity.x - room.x * ROOM_WIDTH) * CELL_W,
      y: ROOM_TOP + (entity.y - room.y * ROOM_HEIGHT) * CELL_H
    };
  }

  function tinyText(text, x, y, color = PALETTE.paper, align = "left", size = 10) {
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px "Lucida Console", monospace`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
  }

  function patternedHorizontal(x1, x2, y, color = PALETTE.paper) {
    rect(x1, y - 5, x2 - x1, 10, color);
    for (let x = x1 + 5; x < x2 - 3; x += 12) rect(x, y - 2, 5, 4, PALETTE.deepest);
  }

  function patternedVertical(x, y1, y2, color = PALETTE.paper) {
    rect(x - 5, y1, 10, y2 - y1, color);
    for (let y = y1 + 5; y < y2 - 3; y += 12) rect(x - 2, y, 4, 5, PALETTE.deepest);
  }

  function eraseDoor(x, y, horizontal) {
    if (horizontal) rect(x - 28, y - 8, 56, 16, PALETTE.deepest);
    else rect(x - 8, y - 28, 16, 56, PALETTE.deepest);
    rect(x - 5, y - 5, 10, 10, PALETTE.blue);
  }

  function drawStairs(x, y, active) {
    const ink = active ? PALETTE.white : PALETTE.mortar;
    rect(x - 25, y - 19, 50, 38, PALETTE.deepest);
    for (let step = 0; step < 5; step += 1) {
      rect(x - 23 + step * 4, y + 13 - step * 7, 44 - step * 8, 4, ink);
    }
  }

  function drawRoom(map, room, plansFound) {
    rect(0, 0, canvas.width, canvas.height, PALETTE.deepest);
    tinyText(`FLOOR ${room.floor || 1}   ROOM ${String(room.number || 1).padStart(2, "0")} / 60`, 30, 18, PALETTE.blue, "left", 10);
    patternedHorizontal(ROOM_LEFT, ROOM_RIGHT, ROOM_TOP);
    patternedHorizontal(ROOM_LEFT, ROOM_RIGHT, ROOM_BOTTOM);
    patternedVertical(ROOM_LEFT, ROOM_TOP, ROOM_BOTTOM);
    patternedVertical(ROOM_RIGHT, ROOM_TOP, ROOM_BOTTOM);

    const startX = room.x * ROOM_WIDTH;
    const startY = room.y * ROOM_HEIGHT;
    if (room.x > 0) {
      for (let y = startY; y <= Math.min(startY + ROOM_HEIGHT, CastleShared.MAP_HEIGHT - 1); y += 1) {
        if (map[y]?.[startX] === "+") eraseDoor(ROOM_LEFT, ROOM_TOP + (y - startY + .5) * CELL_H, false);
      }
    }
    if (room.x < 3) {
      const boundaryX = startX + ROOM_WIDTH;
      for (let y = startY; y <= Math.min(startY + ROOM_HEIGHT, CastleShared.MAP_HEIGHT - 1); y += 1) {
        if (map[y]?.[boundaryX] === "+") eraseDoor(ROOM_RIGHT, ROOM_TOP + (y - startY + .5) * CELL_H, false);
      }
    }
    if (room.y > 0) {
      for (let x = startX; x <= Math.min(startX + ROOM_WIDTH, CastleShared.MAP_WIDTH - 1); x += 1) {
        if (map[startY]?.[x] === "+") eraseDoor(ROOM_LEFT + (x - startX + .5) * CELL_W, ROOM_TOP, true);
      }
    }
    if (room.y < 2) {
      const boundaryY = startY + ROOM_HEIGHT;
      for (let x = startX; x <= Math.min(startX + ROOM_WIDTH, CastleShared.MAP_WIDTH - 1); x += 1) {
        if (map[boundaryY]?.[x] === "+") eraseDoor(ROOM_LEFT + (x - startX + .5) * CELL_W, ROOM_BOTTOM, true);
      }
    }

    for (let y = startY + 1; y < Math.min(startY + ROOM_HEIGHT, CastleShared.MAP_HEIGHT - 1); y += 1) {
      for (let x = startX + 1; x < Math.min(startX + ROOM_WIDTH, CastleShared.MAP_WIDTH - 1); x += 1) {
        const tile = map[y]?.[x];
        const sx = ROOM_LEFT + (x - startX + .5) * CELL_W;
        const sy = ROOM_TOP + (y - startY + .5) * CELL_H;
        if (tile === "#") {
          patternedHorizontal(sx - CELL_W / 2, sx + CELL_W / 2, sy, PALETTE.mortar);
          patternedVertical(sx, sy - CELL_H / 2, sy + CELL_H / 2, PALETTE.mortar);
        } else if (tile === "S") drawStairs(sx, sy, false);
        else if (tile === "E") drawStairs(sx, sy, plansFound > 0);
      }
    }
  }

  function drawPlayer(player, room) {
    const { x, y } = screenPoint(player, room);
    if (player.invulnerable > 0 && Math.floor(performance.now() / 80) % 2) return;
    const facing = player.aimX < 0 ? -1 : 1;
    const coat = player.disguise ? PALETTE.mortar : PALETTE.paper;
    rect(x - 10, y - 15, 20, 25, coat);
    rect(x - 7, y - 29, 14, 13, PALETTE.paper);
    rect(x - 10, y - 31, 20, 5, player.disguise ? PALETTE.mortar : PALETTE.blue);
    rect(x - 9, y + 9, 7, 14, coat);
    rect(x + 2, y + 9, 7, 14, coat);
    rect(x - 12, y + 21, 10, 4, PALETTE.paper);
    rect(x + 2, y + 21, 10, 4, PALETTE.paper);
    const handX = x + player.aimX * 18;
    const handY = y - 6 + player.aimY * 18;
    rect(handX - 4, handY - 4, 8, 8, PALETTE.paper);
    rect(handX, handY - 2, facing * 17, 4, PALETTE.paper);
    rect(handX + facing * 14, handY - 1, facing * 7, 3, PALETTE.blue);
    if (player.searching) tinyText("SEARCH", x, y - 39, PALETTE.glow, "center", 8);
  }

  function drawVersusActor(actor, room, opponent = false) {
    const { x, y } = screenPoint(actor, room);
    if (actor.invulnerable > 0 && Math.floor(performance.now() / 80) % 2) return;
    const facing = actor.aimX < 0 ? -1 : 1;
    const guard = actor.team === "guard";
    const coat = guard ? PALETTE.red : PALETTE.paper;
    const trim = guard ? PALETTE.paper : PALETTE.blue;
    rect(x - 10, y - 15, 20, 25, coat);
    rect(x - 7, y - 29, 14, 13, PALETTE.paper);
    rect(x - 11, y - 32, 22, 6, trim);
    rect(x - 9, y + 9, 7, 14, coat);
    rect(x + 2, y + 9, 7, 14, coat);
    rect(x - 12, y + 21, 10, 4, PALETTE.paper);
    rect(x + 2, y + 21, 10, 4, PALETTE.paper);
    const handX = x + actor.aimX * 18;
    const handY = y - 6 + actor.aimY * 18;
    rect(handX - 4, handY - 4, 8, 8, PALETTE.paper);
    rect(handX, handY - 2, facing * 17, 4, PALETTE.paper);
    rect(handX + facing * 14, handY - 1, facing * 7, 3, trim);
    if (opponent) tinyText(guard ? "GUARD" : "INTRUDER", x, y - 40, guard ? PALETTE.red : PALETTE.white, "center", 8);
    if (actor.searching) tinyText("DRINK", x, y - 40, PALETTE.glow, "center", 8);
  }

  function drawGuard(enemy, room) {
    if (enemy.dog) {
      drawDog(enemy, room);
      return;
    }
    const { x, y } = screenPoint(enemy, room);
    if (enemy.health <= 0) {
      rect(x - 22, y + 7, 44, 7, PALETTE.mortar);
      rect(x + 8, y, 12, 10, PALETTE.paper);
      return;
    }
    const ink = enemy.elite ? PALETTE.white : PALETTE.mortar;
    rect(x - 10, y - 15, 20, 25, ink);
    rect(x - 7, y - 29, 14, 13, PALETTE.paper);
    rect(x - 11, y - 31, 22, 5, enemy.elite ? PALETTE.white : PALETTE.mortar);
    rect(x - 9, y + 9, 7, 14, ink);
    rect(x + 2, y + 9, 7, 14, ink);
    if (enemy.state === "surrendered") {
      rect(x - 20, y - 27, 7, 22, PALETTE.paper);
      rect(x + 13, y - 27, 7, 22, PALETTE.paper);
      tinyText("KAMERAD", x, y - 38, PALETTE.white, "center", 8);
    } else {
      const facing = Math.cos(enemy.facing) < 0 ? -1 : 1;
      rect(x + facing * 9, y - 8, facing * 18, 5, PALETTE.paper);
      if (enemy.state === "alert") tinyText("!", x, y - 37, PALETTE.white, "center", 14);
      if (enemy.state === "threatened") tinyText("?", x, y - 37, PALETTE.glow, "center", 12);
    }
    if ((enemy.searchProgress || 0) > 0 && !enemy.searched) {
      rect(x - 17, y + 29, 34, 3, PALETTE.mortar);
      rect(x - 17, y + 29, 34 * Math.min(1, enemy.searchProgress / .9), 3, PALETTE.white);
    }
  }

  function drawDog(dog, room) {
    const { x, y } = screenPoint(dog, room);
    if (dog.health <= 0) {
      rect(x - 23, y + 8, 45, 7, PALETTE.rust);
      return;
    }
    const facing = Math.cos(dog.facing || 0) < 0 ? -1 : 1;
    rect(x - 18, y - 5, 33, 17, PALETTE.rust);
    rect(x + facing * 12 - (facing < 0 ? 14 : 0), y - 15, 16, 15, PALETTE.paper);
    rect(x - 14, y + 11, 6, 12, PALETTE.rust);
    rect(x + 7, y + 11, 6, 12, PALETTE.rust);
    rect(x - facing * 24, y - 9, facing * 13, 5, PALETTE.rust);
    rect(x + facing * 22, y - 10, 3, 3, PALETTE.deepest);
    if (dog.state === "alert") tinyText("!", x, y - 27, PALETTE.red, "center", 13);
  }

  function drawChest(chest, room) {
    const { x, y } = screenPoint(chest, room);
    const ink = chest.locked ? PALETTE.blue : PALETTE.paper;
    if (chest.opened) {
      rect(x - 21, y + 5, 42, 17, PALETTE.mortar);
      rect(x - 20, y - 12, 40, 6, ink);
      rect(x - 23, y - 10, 6, 17, ink);
    } else {
      rect(x - 22, y - 10, 44, 29, ink);
      rect(x - 18, y - 6, 36, 21, PALETTE.deepest);
      patternedHorizontal(x - 22, x + 22, y - 10, ink);
      rect(x - 3, y - 2, 6, 11, ink);
    }
    if ((chest.searchProgress || 0) > 0 && !chest.searched) {
      rect(x - 20, y + 26, 40, 4, PALETTE.mortar);
      rect(x - 20, y + 26, 40 * Math.min(1, chest.searchProgress / .9), 4, PALETTE.white);
    }
    if (chest.content === "moonshine" && !chest.opened) tinyText("XXX", x, y + 6, PALETTE.red, "center", 8);
  }

  function drawProjectile(item, room, color, size = 4) {
    const { x, y } = screenPoint(item, room);
    rect(x - size / 2, y - size / 2, size, size, color);
  }

  function drawExplosion(item, room) {
    const { x, y } = screenPoint(item, room);
    const pulse = Math.max(8, Math.round((.55 - item.life) * 90));
    rect(x - pulse, y - 4, pulse * 2, 8, PALETTE.white);
    rect(x - 4, y - pulse, 8, pulse * 2, PALETTE.white);
    rect(x - pulse * .55, y - pulse * .55, pulse * 1.1, pulse * 1.1, PALETTE.mortar);
  }

  function drawGameHud(state) {
    rect(0, 365, 640, 35, PALETTE.deepest);
    const maxHealth = state.player.maxHealth || 4;
    tinyText(`LIFE ${"■".repeat(state.player.health)}${"□".repeat(Math.max(0, maxHealth - state.player.health))}`, 24, 386, PALETTE.paper, "left", 10);
    tinyText(`AMMO ${String(state.player.ammo).padStart(2, "0")}`, 155, 386, PALETTE.paper, "left", 10);
    tinyText(`GREN ${String(state.player.grenades).padStart(2, "0")}`, 260, 386, PALETTE.paper, "left", 10);
    if (state.mode === "versus") {
      tinyText(state.viewerTeam === "guard" ? "GUARD UNIT" : "INTRUDER UNIT", 615, 386, state.viewerTeam === "guard" ? PALETTE.red : PALETTE.glow, "right", 9);
      return;
    }
    tinyText(`KEY ${state.player.keys || 0}`, 365, 386, PALETTE.paper, "left", 10);
    tinyText(state.player.disguise ? "UNIFORM" : "PRISONER", 445, 386, state.player.disguise ? PALETTE.glow : PALETTE.mortar, "left", 9);
    tinyText(state.player.intel ? "PLANS!" : "NO PLANS", 615, 386, state.player.intel ? PALETTE.white : PALETTE.mortar, "right", 9);
  }

  function drawGame(state) {
    const map = CastleShared.generateMap(state.level, state.mapSeed);
    const room = { ...(state.room || roomOf(state.player)), floor: state.level };
    if (!room.number) room.number = (state.level - 1) * 12 + room.y * 4 + room.x + 1;
    drawRoom(map, room, state.mode === "versus" ? false : state.player.intel);
    for (const chest of state.chests || []) if (visibleInRoom(chest, room)) drawChest(chest, room);
    if (state.mode === "versus") {
      if (state.opponent && visibleInRoom(state.opponent, room)) drawVersusActor(state.opponent, room, true);
    } else {
      for (const enemy of state.enemies || []) if (visibleInRoom(enemy, room)) drawGuard(enemy, room);
    }
    for (const bullet of state.bullets || []) if (visibleInRoom(bullet, room)) drawProjectile(bullet, room, PALETTE.white, 5);
    for (const bullet of state.enemyBullets || []) if (visibleInRoom(bullet, room)) drawProjectile(bullet, room, PALETTE.red, 5);
    for (const grenade of state.thrown || []) if (visibleInRoom(grenade, room)) drawProjectile(grenade, room, Math.floor(grenade.fuse * 8) % 2 ? PALETTE.white : PALETTE.blue, 8);
    for (const explosion of state.explosions || []) if (visibleInRoom(explosion, room)) drawExplosion(explosion, room);
    if (state.mode === "versus") drawVersusActor(state.player, room);
    else drawPlayer(state.player, room);
    drawGameHud(state);

    const transitionAge = performance.now() - roomChangeAt;
    if (transitionAge < 420 && lastRoomNumber) {
      const opacity = Math.max(0, 1 - transitionAge / 420);
      rect(0, 0, 640, 365, `rgba(2,4,10,${opacity})`);
      tinyText(`ROOM ${String(room.number).padStart(2, "0")}`, 320, 205, PALETTE.white, "center", 16);
    }
  }

  function makeAttractState(time) {
    const safeTime = Number.isFinite(time) && time >= 0 ? time : 0;
    const x = 3.4 + Math.sin(safeTime * .55) * .65;
    const y = 21.1 + Math.cos(safeTime * .4) * .35;
    return {
      level: 1, alert: .1, room: { x: 0, y: 2, number: 9 },
      player: { x, y, aimX: 1, aimY: Math.sin(safeTime * .7) * .25, health: 4, ammo: 10, grenades: 3, intel: 0, keys: 0, disguise: false, invulnerable: 0, searching: false },
      enemies: [{ x: 6.2, y: 20.4, facing: Math.PI, state: Math.sin(safeTime) > .8 ? "threatened" : "patrol", health: 1, elite: false, searched: false }],
      chests: [{ x: 7.5, y: 21.5, opened: false, searched: false, locked: false, searchProgress: 0 }],
      bullets: [], enemyBullets: [], thrown: [], explosions: [], intel: [], ammo: []
    };
  }

  function frame(now) {
    const elapsed = (now - lastFrame) / 1000;
    const dt = Number.isFinite(elapsed) && elapsed >= 0 ? Math.min(.05, elapsed) : 0;
    lastFrame = now;
    if (gameState && roomCode) drawGame(gameState);
    else {
      attractTime += dt;
      drawGame(makeAttractState(attractTime));
    }
    requestAnimationFrame(frame);
  }

  const invitedCode = new URLSearchParams(location.search).get("room")?.toUpperCase();
  const invitedMode = new URLSearchParams(location.search).get("mode") === "versus" ? "versus" : "coop";
  try { ui.scoreInitials.value = localStorage.getItem("castleCrewInitials") || "AAA"; } catch {}
  let savedMission = null;
  try { savedMission = JSON.parse(sessionStorage.getItem("castleCrewMission")); } catch { savedMission = null; }
  if (invitedCode && savedMission?.code === invitedCode && savedMission?.role) {
    pendingAction = { type: "join", code: invitedCode, role: savedMission.role, mode: savedMission.mode || invitedMode };
  } else if (invitedCode) setTimeout(() => openDialog("join"), 250);
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    fetch("/api/network").then((response) => response.json()).then((data) => {
      lanOrigin = data.lanOrigins?.[0] || "";
    }).catch(() => {});
  }
  connect();
  requestAnimationFrame(frame);
})();
