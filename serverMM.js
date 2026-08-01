// server.js - Game Engine cho Mi & Friends Adventure World
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// 🔗 DÁN URL GOOGLE SHEET APPS SCRIPT CỦA ANH VÀO ĐÂY
const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbwzhd1IGWLGPs7gUe6tYf4bC5X6xUajAFwEJGH29LU9viXuV2zXvCTfEPaL_1WL8xDZmw/exec";
const EPISODES_FILE = path.join(__dirname, 'episodes.json');

let usersData = {};

async function loadUserData() {
  try {
    const res = await fetch(GOOGLE_SHEET_URL, { redirect: "follow" });
    const text = await res.text();
    usersData = JSON.parse(text);
    console.log("✅ Load dữ liệu bé thành công!");
  } catch (e) {
    usersData = {};
  }
}

function saveUserDataAsync() {
  fetch(GOOGLE_SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(usersData),
    redirect: "follow"
  }).catch(e => console.error("❌ Lỗi lưu dữ liệu:", e.message));
}

loadUserData();

function getEpisodeData(epId = "HOME_KITCHEN_005") {
  if (fs.existsSync(EPISODES_FILE)) {
    try {
      const all = JSON.parse(fs.readFileSync(EPISODES_FILE, 'utf8'));
      return all[epId] || all["HOME_KITCHEN_005"];
    } catch (e) { return null; }
  }
  return null;
}

function getBadgeTitle(exp) {
  if (exp >= 500) return "👑 World Master";
  if (exp >= 200) return "🏅 Kitchen Hero";
  if (exp >= 100) return "🥉 Helper Scout";
  return "🌱 Little Friend";
}

let rooms = {};

function createRoom(roomId, epId = "HOME_KITCHEN_005") {
  let epConfig = getEpisodeData(epId);
  rooms[roomId] = {
    id: roomId,
    epId: epId,
    title: epConfig ? epConfig.title : "Kitchen Party",
    players: [],
    currentActionIdx: 0,
    scores: {},
    isPractice: false,
    botLevel: 'medium',
    botTimer: null,
    actions: epConfig ? epConfig.actions : []
  };
}

// Khởi tạo 5 bàn tiệc mặc định
for (let i = 1; i <= 5; i++) createRoom(`Bàn Party ${i}`);

function getPublicRooms() {
  let list = [];
  for (let id in rooms) {
    if (!rooms[id].isPractice) {
      list.push({
        id: id,
        title: rooms[id].title,
        playerCount: rooms[id].players.length,
        players: rooms[id].players.map(p => p.username)
      });
    }
  }
  return list;
}

function getLeaderboard() {
  return Object.keys(usersData)
    .map(name => ({
      username: name,
      exp: Math.ceil(usersData[name].exp || 0),
      badge: getBadgeTitle(Math.ceil(usersData[name].exp || 0)),
      furniture: usersData[name].furniture || []
    }))
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10);
}

function scheduleBot(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  let delay = room.botLevel === 'easy' ? 7000 : room.botLevel === 'hard' ? 2500 : 4500;

  room.botTimer = setTimeout(() => {
    if (!room || room.answered) return;
    room.answered = true;
    let botName = `🤖 Bot Mi (${room.botLevel.toUpperCase()})`;
    
    room.scores[botName] = (room.scores[botName] || 0) + 10;

    io.to(roomId).emit('actionResult', { 
      winner: botName, 
      scores: room.scores,
      correctIdx: room.actions[room.currentActionIdx].answer 
    });

    setTimeout(() => {
      room.currentActionIdx++;
      if (room.currentActionIdx < room.actions.length) {
        room.answered = false;
        io.to(roomId).emit('nextAction', room.actions[room.currentActionIdx]);
        scheduleBot(roomId);
      } else {
        finishGame(roomId);
      }
    }, 1500);
  }, delay);
}

function finishGame(roomId) {
  let room = rooms[roomId];
  if (!room) return;

  let epConfig = getEpisodeData(room.epId);
  let baseExp = epConfig ? epConfig.baseExp : 50;

  if (room.isPractice) {
    let human = room.players.find(p => !p.username.startsWith("🤖 Bot"));
    if (human && usersData[human.username]) {
      let botName = room.players.find(p => p.username.startsWith("🤖 Bot"))?.username;
      let pScore = room.scores[human.username] || 0;
      let bScore = room.scores[botName] || 0;

      if (pScore >= bScore) {
        let rate = room.botLevel === 'easy' ? 0.2 : room.botLevel === 'hard' ? 0.6 : 0.4;
        let gain = Math.ceil(baseExp * rate);
        usersData[human.username].exp = Math.ceil((usersData[human.username].exp || 0) + gain);
        
        // Reward Unlocks
        if (!usersData[human.username].furniture) usersData[human.username].furniture = [];
        if (!usersData[human.username].furniture.includes("Party Table")) {
          usersData[human.username].furniture.push("Party Table", "Party Balloons");
        }
      }
      saveUserDataAsync();
    }
  } else {
    // Co-op 1v1 Mode
    let pNames = room.players.map(p => p.username);
    let p1 = pNames[0], p2 = pNames[1];
    let winner = null, loser = null;

    if (room.scores[p1] > room.scores[p2]) { winner = p1; loser = p2; }
    else if (room.scores[p2] > room.scores[p1]) { winner = p2; loser = p1; }

    if (winner && usersData[winner]) {
      usersData[winner].exp = Math.ceil((usersData[winner].exp || 0) + baseExp);
    }
    if (loser && usersData[loser]) {
      let old = usersData[loser].exp || 0;
      usersData[loser].exp = Math.ceil(Math.max(0, old - baseExp));
    }
    saveUserDataAsync();
  }

  io.to(roomId).emit('gameOver', { 
    winner: room.scores[room.players[0]?.username] >= (room.scores[room.players[1]?.username] || 0) ? room.players[0]?.username : room.players[1]?.username,
    unlockedItems: ["Party Table", "Party Balloons", "Cookie Jar"]
  });

  io.emit('leaderboardUpdate', getLeaderboard());
  if (room.isPractice) delete rooms[roomId];
  else createRoom(roomId, room.epId);
}

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getPublicRooms());
  socket.emit('leaderboardUpdate', getLeaderboard());

  socket.on('joinPractice', ({ username, botLevel }) => {
    if (!username) return;
    socket.username = username;
    let roomId = `Luyện-Tập-${socket.id.substring(0, 4)}`;
    socket.roomId = roomId;

    if (!usersData[username]) usersData[username] = { exp: 0, furniture: [] };

    let botName = `🤖 Bot Mi (${(botLevel || 'medium').toUpperCase()})`;
    createRoom(roomId, "HOME_KITCHEN_005");
    let room = rooms[roomId];
    room.isPractice = true;
    room.botLevel = botLevel || 'medium';
    room.players = [socket, { username: botName }];
    room.scores = { [username]: 0, [botName]: 0 };

    socket.join(roomId);
    socket.emit('gameStart', {
      roomId: roomId,
      title: room.title,
      action: room.actions[0]
    });
    scheduleBot(roomId);
  });

  socket.on('joinRoom', ({ username, roomId }) => {
    if (!username || !rooms[roomId]) return;
    socket.username = username;
    socket.roomId = roomId;
    if (!usersData[username]) usersData[username] = { exp: 0, furniture: [] };

    let room = rooms[roomId];
    if (room.players.length >= 2) return socket.emit('notice', 'Bàn tiệc đã đầy!');

    socket.join(roomId);
    room.players.push(socket);
    room.scores[username] = 0;

    io.emit('roomListUpdate', getPublicRooms());

    if (room.players.length === 2) {
      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        title: room.title,
        action: room.actions[0]
      });
    }
  });

  socket.on('submitAction', (optionIdx) => {
    let room = rooms[socket.roomId];
    if (!room || room.answered) return;

    let currentAction = room.actions[room.currentActionIdx];
    if (optionIdx === currentAction.answer) {
      room.answered = true;
      if (room.botTimer) clearTimeout(room.botTimer);

      room.scores[socket.username] = Math.ceil((room.scores[socket.username] || 0) + 10);

      io.to(room.id).emit('actionResult', {
        winner: socket.username,
        scores: room.scores,
        correctIdx: currentAction.answer
      });

      setTimeout(() => {
        room.currentActionIdx++;
        if (room.currentActionIdx < room.actions.length) {
          room.answered = false;
          io.to(room.id).emit('nextAction', room.actions[room.currentActionIdx]);
          if (room.isPractice) scheduleBot(room.id);
        } else {
          finishGame(room.id);
        }
      }, 1500);
    } else {
      room.scores[socket.username] = Math.max(0, (room.scores[socket.username] || 0) - 8);
      io.to(room.id).emit('actionResult', { winner: null, scores: room.scores });
      socket.emit('wrongAction', 'Chưa chính xác, hãy thử lại nào!');
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Mi & Friends Engine running on port ${PORT}`));
