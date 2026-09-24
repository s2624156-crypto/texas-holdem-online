const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

const HAND_NAMES = [
  "ハイカード",
  "ワンペア",
  "ツーペア",
  "スリーカード",
  "ストレート",
  "フラッシュ",
  "フルハウス",
  "フォーカード",
  "ストレートフラッシュ"
];

const rooms = {};

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank });
    }
  }
  shuffle(deck);
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function labelRank(rank) {
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  if (rank === 14) return "A";
  return String(rank);
}

function roomLog(room, msg) {
  room.log.push(msg);
  if (room.log.length > 200) room.log.shift();
}

function sanitizePlayerFor(player, viewerId, revealAll = false) {
  return {
    id: player.id,
    name: player.name,
    chips: player.chips,
    bet: player.bet,
    folded: player.folded,
    allIn: player.allIn,
    isDealer: player.isDealer,
    isTurn: player.isTurn,
    cards: (revealAll || player.id === viewerId)
      ? player.cards
      : [{ hidden: true }, { hidden: true }],
    handName: revealAll ? player.handName : ""
  };
}

function emitState(roomId, revealAll = false) {
  const room = rooms[roomId];
  if (!room) return;

  for (const viewer of room.players) {
    io.to(viewer.id).emit("state", {
      roomId: room.id,
      stage: room.stage,
      started: room.started,
      pot: room.pot,
      currentBet: room.currentBet,
      communityCards: room.communityCards,
      turnPlayerId: room.turnPlayerId,
      players: room.players.map(p => sanitizePlayerFor(p, viewer.id, revealAll)),
      log: room.log.slice(-50)
    });
  }
}

function createRoom(roomId) {
  return {
    id: roomId,
    players: [],
    deck: [],
    communityCards: [],
    pot: 0,
    currentBet: 0,
    stage: "waiting",
    started: false,
    dealerIndex: -1,
    turnIndex: -1,
    turnPlayerId: null,
    log: []
  };
}

function postBlind(room, playerIndex, amount) {
  const p = room.players[playerIndex];
  const paid = Math.min(amount, p.chips);
  p.chips -= paid;
  p.bet += paid;
  room.pot += paid;
  if (p.chips === 0) p.allIn = true;
}

function setTurn(room, index) {
  room.players.forEach(p => p.isTurn = false);
  room.turnIndex = index;

  if (index >= 0 && room.players[index]) {
    room.players[index].isTurn = true;
    room.turnPlayerId = room.players[index].id;
  } else {
    room.turnPlayerId = null;
  }
}

function nextActiveIndex(room, fromIndex) {
  if (room.players.length === 0) return -1;

  for (let step = 1; step <= room.players.length; step++) {
    const i = (fromIndex + step) % room.players.length;
    const p = room.players[i];
    if (!p.folded && !p.allIn && p.chips >= 0) {
      return i;
    }
  }
  return -1;
}

function alivePlayers(room) {
  return room.players.filter(p => !p.folded && p.cards.length === 2);
}

function bettingRoundComplete(room) {
  const alive = alivePlayers(room);
  const active = alive.filter(p => !p.allIn);
  if (active.length === 0) return true;

  const maxBet = Math.max(...alive.map(p => p.bet), 0);
  return active.every(p => p.acted) && alive.every(p => p.allIn || p.bet === maxBet);
}

function resetRoundBets(room) {
  room.currentBet = 0;
  for (const p of room.players) {
    p.bet = 0;
    p.acted = false;
    p.isTurn = false;
  }
}

function startHand(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < 2) return;

  room.deck = createDeck();
  room.communityCards = [];
  room.pot = 0;
  room.currentBet = 20;
  room.stage = "preflop";
  room.started = true;
  room.log = [];

  for (const p of room.players) {
    p.cards = [];
    p.bet = 0;
    p.folded = false;
    p.allIn = false;
    p.acted = false;
    p.handName = "";
    p.isTurn = false;
  }

  room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
  room.players.forEach((p, i) => {
    p.isDealer = i === room.dealerIndex;
  });

  for (let round = 0; round < 2; round++) {
    for (const p of room.players) {
      if (p.chips > 0) {
        p.cards.push(room.deck.pop());
      }
    }
  }

  const sbIndex = (room.dealerIndex + 1) % room.players.length;
  const bbIndex = (room.dealerIndex + 2) % room.players.length;

  postBlind(room, sbIndex, 10);
  postBlind(room, bbIndex, 20);

  roomLog(room, `新しいハンド開始`);
  roomLog(room, `ディーラー: ${room.players[room.dealerIndex].name}`);
  roomLog(room, `${room.players[sbIndex].name} が SB 10`);
  roomLog(room, `${room.players[bbIndex].name} が BB 20`);

  room.turnIndex = (bbIndex + 1) % room.players.length;
  setTurn(room, room.turnIndex);

  emitState(roomId);
}

function moveToNextStage(room) {
  resetRoundBets(room);

  if (room.stage === "preflop") {
    room.stage = "flop";
    room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
    roomLog(room, "フロップ");
  } else if (room.stage === "flop") {
    room.stage = "turn";
    room.communityCards.push(room.deck.pop());
    roomLog(room, "ターン");
  } else if (room.stage === "turn") {
    room.stage = "river";
    room.communityCards.push(room.deck.pop());
    roomLog(room, "リバー");
  } else if (room.stage === "river") {
    room.stage = "showdown";
    showdown(room);
    return;
  }

  const next = nextActiveIndex(room, room.dealerIndex);
  setTurn(room, next);
}

function compareHands(a, b) {
  if (a.category !== b.category) return a.category - b.category;
  const len = Math.max(a.tiebreak.length, b.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const av = a.tiebreak[i] || 0;
    const bv = b.tiebreak[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function combinations(arr, k) {
  const out = [];
  function dfs(start, path) {
    if (path.length === k) {
      out.push([...path]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      path.push(arr[i]);
      dfs(i + 1, path);
      path.pop();
    }
  }
  dfs(0, []);
  return out;
}

function detectStraight(ranks) {
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);

  for (let i = 0; i <= uniq.length - 5; i++) {
    let ok = true;
    for (let j = 0; j < 4; j++) {
      if (uniq[i + j] - 1 !== uniq[i + j + 1]) {
        ok = false;
        break;
      }
    }
    if (ok) return uniq[i];
  }

  if (uniq.includes(14) && uniq.includes(5) && uniq.includes(4) && uniq.includes(3) && uniq.includes(2)) {
    return 5;
  }

  return 0;
}

function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const countMap = {};
  for (const r of ranks) {
    countMap[r] = (countMap[r] || 0) + 1;
  }

  const groups = Object.entries(countMap)
    .map(([rank, count]) => ({ rank: Number(rank), count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.rank - a.rank;
    });

  const flush = suits.every(s => s === suits[0]);
  const straightHigh = detectStraight(ranks);
  const straight = straightHigh > 0;

  if (straight && flush) return { category: 8, tiebreak: [straightHigh] };
  if (groups[0].count === 4) return { category: 7, tiebreak: [groups[0].rank, groups[1].rank] };
  if (groups[0].count === 3 && groups[1].count === 2) return { category: 6, tiebreak: [groups[0].rank, groups[1].rank] };
  if (flush) return { category: 5, tiebreak: ranks };
  if (straight) return { category: 4, tiebreak: [straightHigh] };
  if (groups[0].count === 3) {
    const kickers = groups.slice(1).map(g => g.rank).sort((a, b) => b - a);
    return { category: 3, tiebreak: [groups[0].rank, ...kickers] };
  }
  if (groups[0].count === 2 && groups[1].count === 2) {
    const pair1 = Math.max(groups[0].rank, groups[1].rank);
    const pair2 = Math.min(groups[0].rank, groups[1].rank);
    return { category: 2, tiebreak: [pair1, pair2, groups[2].rank] };
  }
  if (groups[0].count === 2) {
    const kickers = groups.slice(1).map(g => g.rank).sort((a, b) => b - a);
    return { category: 1, tiebreak: [groups[0].rank, ...kickers] };
  }
  return { category: 0, tiebreak: ranks };
}

function evaluate7(cards) {
  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const value = evaluate5(combo);
    if (!best || compareHands(value, best) > 0) {
      best = value;
    }
  }
  return best;
}

function showdown(room) {
  const contenders = alivePlayers(room);

  for (const p of contenders) {
    const hand = evaluate7([...p.cards, ...room.communityCards]);
    p.handValue = hand;
    p.handName = HAND_NAMES[hand.category];
    roomLog(room, `${p.name}: ${p.handName}`);
  }

  contenders.sort((a, b) => compareHands(b.handValue, a.handValue));
  const best = contenders[0].handValue;
  const winners = contenders.filter(p => compareHands(p.handValue, best) === 0);
  const share = Math.floor(room.pot / winners.length);

  winners.forEach(w => {
    w.chips += share;
  });

  roomLog(
    room,
    `勝者: ${winners.map(w => w.name).join(", ")} / ${winners[0].handName}`
  );

  room.stage = "finished";
}

function handleAction(roomId, socketId, action, amount = 0) {
  const room = rooms[roomId];
  if (!room || room.turnPlayerId !== socketId) return;

  const player = room.players[room.turnIndex];
  if (!player || player.id !== socketId) return;

  const toCall = Math.max(0, room.currentBet - player.bet);

  if (action === "fold") {
    player.folded = true;
    player.acted = true;
    roomLog(room, `${player.name} はフォールド`);
  }

  if (action === "call") {
    const paid = Math.min(toCall, player.chips);
    player.chips -= paid;
    player.bet += paid;
    room.pot += paid;
    if (player.chips === 0) player.allIn = true;
    player.acted = true;
    roomLog(room, `${player.name} は ${toCall === 0 ? "チェック" : "コール " + paid}`);
  }

  if (action === "raise") {
    let raiseTo = Number(amount) || (room.currentBet + 20);
    raiseTo = Math.max(raiseTo, room.currentBet + 20);

    const needed = raiseTo - player.bet;
    const paid = Math.min(needed, player.chips);

    player.chips -= paid;
    player.bet += paid;
    room.pot += paid;

    if (player.bet > room.currentBet) {
      room.currentBet = player.bet;
    }

    if (player.chips === 0) player.allIn = true;

    room.players.forEach(p => {
      if (p.id !== player.id && !p.folded && !p.allIn) {
        p.acted = false;
      }
    });

    player.acted = true;
    roomLog(room, `${player.name} は ${player.bet} にレイズ`);
  }

  const remain = alivePlayers(room);
  if (remain.length === 1) {
    remain[0].chips += room.pot;
    roomLog(room, `${remain[0].name} の勝ち`);
    room.stage = "finished";
    emitState(roomId, true);
    return;
  }

  if (bettingRoundComplete(room)) {
    moveToNextStage(room);
    emitState(roomId, room.stage === "showdown" || room.stage === "finished");
    return;
  }

  const next = nextActiveIndex(room, room.turnIndex);
  setTurn(room, next);
  emitState(roomId);
}

io.on("connection", socket => {
  socket.on("joinRoom", ({ roomId, name }) => {
    roomId = String(roomId || "").trim();
    name = String(name || "").trim();

    if (!roomId || !name) return;

    if (!rooms[roomId]) {
      rooms[roomId] = createRoom(roomId);
    }

    const room = rooms[roomId];

    if (room.players.length >= 6) {
      socket.emit("errorMessage", "ルームが満員です");
      return;
    }

    room.players.push({
      id: socket.id,
      name: name.slice(0, 20),
      chips: 1000,
      cards: [],
      bet: 0,
      folded: false,
      allIn: false,
      acted: false,
      isDealer: false,
      isTurn: false,
      handName: ""
    });

    socket.join(roomId);
    socket.data.roomId = roomId;

    roomLog(room, `${name} が参加しました`);
    emitState(roomId);
  });

  socket.on("startGame", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    if (room.players.length < 2) {
      socket.emit("errorMessage", "2人以上必要です");
      return;
    }

    startHand(roomId);
  });

  socket.on("action", ({ action, amount }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    handleAction(roomId, socket.id, action, amount);
  });

  socket.on("chat", message => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    io.to(roomId).emit("chatMessage", {
      name: player.name,
      message: String(message).slice(0, 300)
    });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId;
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const idx = room.players.findIndex(p => p.id === socket.id);

    if (idx !== -1) {
      roomLog(room, `${room.players[idx].name} が切断しました`);
      room.players.splice(idx, 1);
    }

    if (room.players.length === 0) {
      delete rooms[roomId];
      return;
    }

    if (room.turnIndex >= room.players.length) {
      room.turnIndex = 0;
    }

    emitState(roomId, room.stage === "finished");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
