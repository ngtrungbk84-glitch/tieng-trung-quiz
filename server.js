// server.js (Chạy trên Render)
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbwzhd1IGWLGPs7gUe6tYf4bC5X6xUajAFwEJGH29LU9viXuV2zXvCTfEPaL_1WL8xDZmw/exec";
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// Cấu hình thời gian chơi mặc định (tính bằng giây) cho mỗi người chơi
const PLAYER_MAX_TIME = 60; 

let usersData = {};

// Tải dữ liệu từ Google Sheet
async function loadUserDataFromSheet() {
  try {
    const res = await fetch(GOOGLE_SHEET_URL, { redirect: "follow" });
    const text = await res.text();
    usersData = JSON.parse(text);
    console.log("✅ Đã tải dữ liệu Google Sheets!");
  } catch (e) {
    console.error("❌ Lỗi tải Sheet:", e.message);
    usersData = {};
  }
}

// Đồng bộ ngầm lên Sheet
function saveUserDataAsync() {
  fetch(GOOGLE_SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(usersData),
    redirect: "follow"
  }).catch(e => console.error("❌ Lỗi lưu Sheet ngầm:", e.message));
}

loadUserDataFromSheet();

function getQuestionsByLesson(lesson) {
  if (fs.existsSync(QUESTIONS_FILE)) {
    try {
      const allQ = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
      return allQ[lesson] || allQ["1"] || [];
    } catch (e) { return []; }
  }
  return [];
}

function getRank(exp) {
  if (exp >= 500) return "🐉 HSK Master";
  if (exp >= 200) return "🥇 Cao thủ HSK";
  if (exp >= 100) return "🥈 Trung cấp";
  if (exp >= 30)  return "🥉 Sơ cấp";
  return "🌱 Tân thủ";
}

// Tính điểm cơ bản theo bài (Làm tròn lên số nguyên)
function getBasePoints(lesson) {
  let l = parseInt(lesson) || 1;
  return Math.ceil(10 + (l - 1) * 5);
}

let roomCounter = 5;
let rooms = {};

for (let i = 1; i <= 5; i++) {
  createRoomObject(`Bàn ${i}`, 1);
}

function createRoomObject(roomId, lesson = 1) {
  rooms[roomId] = {
    id: roomId,
    lesson: lesson,
    players: [],
    currentQ: 0,
    matchScores: {},
    playerTimers: {},    // Lưu thời gian còn lại của từng người chơi
    activeTurnIndex: 0,  // Chỉ số người chơi đang đến lượt (0 hoặc 1)
    timerInterval: null, // Interval đếm ngược từng giây
    isPractice: false,
    botLevel: 'medium',
    botTimer: null,
    questions: getQuestionsByLesson(lesson)
  };
}

function getPublicRooms() {
  let list = [];
  for (let id in rooms) {
    if (!rooms[id].isPractice) {
      list.push({
        id: id,
        lesson: rooms[id].lesson,
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
      wins: usersData[name].wins || 0,
      rank: getRank(Math.ceil(usersData[name].exp || 0))
    }))
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10);
}

// ⏳ DỪNG ĐẾM NGƯỢC
function stopRoomTimer(roomId) {
  let room = rooms[roomId];
  if (room && room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

// ⏳ BẮT ĐẦU ĐẾM NGƯỢC CHO NGƯỜI ĐANG ĐẾN LƯỢT
function startTurnTimer(roomId) {
  let room = rooms[roomId];
  if (!room || room.players.length < 2) return;

  stopRoomTimer(roomId);

  let activePlayer = room.players[room.activeTurnIndex];
  if (!activePlayer) return;

  // Báo cho client biết hiện tại đang là lượt của ai
  io.to(roomId).emit('turnChanged', {
    activePlayer: activePlayer.username,
    playerTimers: room.playerTimers
  });

  // Nếu là lượt của Bot trong chế độ Luyện tập
  if (room.isPractice && activePlayer.username.startsWith("🤖 Bot HSK")) {
    scheduleBotAnswer(roomId);
    return;
  }

  // Đếm ngược mỗi 1 giây cho người chơi là người thật
  room.timerInterval = setInterval(() => {
    if (!room || !room.playerTimers[activePlayer.username]) return;

    room.playerTimers[activePlayer.username]--;

    // Gửi cập nhật thời gian đếm ngược về cho các client
    io.to(roomId).emit('timerUpdate', {
      playerTimers: room.playerTimers
    });

    // XỬ LÝ HẾT GIỜ -> NGƯỜI ĐANG ĐẾN LƯỢT BỊ THUA NGAY LẬP TỨC
    if (room.playerTimers[activePlayer.username] <= 0) {
      stopRoomTimer(roomId);
      let loserName = activePlayer.username;
      let winnerPlayer = room.players.find(p => p.username !== loserName);
      let winnerName = winnerPlayer ? winnerPlayer.username : null;

      finishGameDueToTimeout(roomId, winnerName, loserName);
    }
  }, 1000);
}

// 🤖 BOT TRẢ LỜI
function scheduleBotAnswer(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  let delay = 3000;
  let level = room.botLevel || 'medium';

  if (level === 'easy') delay = Math.floor(Math.random() * 3000) + 4000;
  else if (level === 'hard') delay = Math.floor(Math.random() * 1000) + 1500;
  else delay = Math.floor(Math.random() * 2000) + 2500;

  // Giảm thời gian của bot trong lúc bot suy nghĩ
  let botName = `🤖 Bot HSK (${level.toUpperCase()})`;
  let thinkingInterval = setInterval(() => {
    if (room && room.playerTimers[botName] > 0) {
      room.playerTimers[botName]--;
      io.to(roomId).emit('timerUpdate', { playerTimers: room.playerTimers });
    }
  }, 1000);

  room.botTimer = setTimeout(() => {
    clearInterval(thinkingInterval);
    if (!room) return;

    let q = room.questions[room.currentQ];

    // Bot trả lời đúng: +10 điểm
    room.matchScores[botName] = Math.ceil((room.matchScores[botName] || 0) + 10);

    io.to(roomId).emit('roundResult', { 
      winner: botName, 
      matchScores: room.matchScores,
      correctIndex: q ? q.answer : 0
    });

    // Đổi lượt sang cho người chơi
    room.activeTurnIndex = room.players.findIndex(p => p.username !== botName);

    setTimeout(() => {
      room.currentQ++;
      if (room.currentQ < room.questions.length) {
        io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        startTurnTimer(roomId);
      } else {
        finishGameByQuestions(roomId);
      }
    }, 1200);
  }, delay);
}

// 🏆 TỔNG KẾT KHI XỬ THUA DO HẾT GIỜ
function finishGameDueToTimeout(roomId, winnerName, loserName) {
  let room = rooms[roomId];
  if (!room) return;

  let basePoints = getBasePoints(room.lesson);

  if (room.isPractice) {
    if (winnerName && !winnerName.startsWith("🤖 Bot HSK") && usersData[winnerName]) {
      usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
      let rate = room.botLevel === 'easy' ? 0.2 : room.botLevel === 'hard' ? 0.6 : 0.4;
      let earnedExp = Math.ceil(basePoints * rate);
      usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + earnedExp);
    }
  } else {
    if (winnerName && usersData[winnerName]) {
      usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
      usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints);
    }
    if (loserName && usersData[loserName]) {
      let oldExp = usersData[loserName].exp || 0;
      usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints));
    }
  }

  saveUserDataAsync();
  io.to(roomId).emit('gameOver', { winner: winnerName, reason: 'timeout' });
  io.emit('leaderboardUpdate', getLeaderboard());

  if (!room.isPractice) {
    createRoomObject(roomId, room.lesson);
    io.emit('roomListUpdate', getPublicRooms());
  } else {
    delete rooms[roomId];
  }
}

// 🏆 TỔNG KẾT KHI HẾT CÂU HỎI (TÍNH THEO ĐIỂM)
function finishGameByQuestions(roomId) {
  let room = rooms[roomId];
  if (!room) return;

  stopRoomTimer(roomId);

  let p1 = room.players[0].username;
  let p2 = room.players[1].username;
  let winnerName = null;
  let loserName = null;

  if (room.matchScores[p1] > room.matchScores[p2]) {
    winnerName = p1; loserName = p2;
  } else if (room.matchScores[p2] > room.matchScores[p1]) {
    winnerName = p2; loserName = p1;
  }

  let basePoints = getBasePoints(room.lesson);

  if (room.isPractice) {
    let humanPlayer = room.players.find(p => !p.username.startsWith("🤖 Bot HSK"));
    if (humanPlayer && winnerName === humanPlayer.username && usersData[humanPlayer.username]) {
      usersData[humanPlayer.username].wins = (usersData[humanPlayer.username].wins || 0) + 1;
      let rate = room.botLevel === 'easy' ? 0.2 : room.botLevel === 'hard' ? 0.6 : 0.4;
      let earnedExp = Math.ceil(basePoints * rate);
      usersData[humanPlayer.username].exp = Math.ceil((usersData[humanPlayer.username].exp || 0) + earnedExp);
    }
  } else {
    if (winnerName && usersData[winnerName]) {
      usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
      usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints);
    }
    if (loserName && usersData[loserName]) {
      let oldExp = usersData[loserName].exp || 0;
      usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints));
    }
  }

  saveUserDataAsync();
  io.to(roomId).emit('gameOver', { winner: winnerName, reason: 'questionsEnded' });
  io.emit('leaderboardUpdate', getLeaderboard());

  if (!room.isPractice) {
    createRoomObject(roomId, room.lesson);
    io.emit('roomListUpdate', getPublicRooms());
  } else {
    delete rooms[roomId];
  }
}

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getPublicRooms());
  socket.emit('leaderboardUpdate', getLeaderboard());

  // LƯYỆN TẬP VỚI BOT
  socket.on('joinPractice', ({ username, lesson, botLevel }) => {
    if (!username) return;

    socket.username = username;
    let practiceRoomId = `Luyện Tập - ${socket.id.substring(0, 4)}`;
    socket.roomId = practiceRoomId;

    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserDataAsync();
    }

    let selectedLevel = botLevel || 'medium';
    let botName = `🤖 Bot HSK (${selectedLevel.toUpperCase()})`;

    rooms[practiceRoomId] = {
      id: practiceRoomId,
      lesson: lesson || 1,
      players: [socket, { username: botName }],
      currentQ: 0,
      matchScores: { [username]: 0, [botName]: 0 },
      playerTimers: { [username]: PLAYER_MAX_TIME, [botName]: PLAYER_MAX_TIME },
      activeTurnIndex: 0, // Người chơi đi trước
      timerInterval: null,
      isPractice: true,
      botLevel: selectedLevel,
      questions: getQuestionsByLesson(lesson || 1)
    };

    socket.join(practiceRoomId);
    let rankLabel = selectedLevel === 'easy' ? '🟢 Dễ' : selectedLevel === 'hard' ? '🔴 Khó' : '🟡 Vừa';

    socket.emit('gameStart', {
      roomId: practiceRoomId,
      lesson: lesson || 1,
      players: [
        { name: username, rank: getRank(Math.ceil(usersData[username].exp || 0)) },
        { name: botName, rank: `AI ${rankLabel}` }
      ],
      question: rooms[practiceRoomId].questions[0]
    });

    startTurnTimer(practiceRoomId);
  });

  socket.on('createNewRoom', (selectedLesson) => {
    if (Object.keys(rooms).length >= 10) {
      socket.emit('notice', 'Sảnh đã đạt giới hạn 10 bàn!');
      return;
    }
    roomCounter++;
    let newRoomId = `Bàn ${roomCounter}`;
    createRoomObject(newRoomId, selectedLesson || 1);
    io.emit('roomListUpdate', getPublicRooms());
  });

  socket.on('changeRoomLesson', ({ roomId, lesson }) => {
    if (rooms[roomId] && rooms[roomId].players.length < 2) {
      rooms[roomId].lesson = lesson;
      rooms[roomId].questions = getQuestionsByLesson(lesson);
      io.emit('roomListUpdate', getPublicRooms());
      io.to(roomId).emit('lessonUpdated', lesson);
    }
  });

  socket.on('joinRoom', ({ username, roomId }) => {
    if (!username) return;
    socket.username = username;
    socket.roomId = roomId;

    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserDataAsync();
    }

    let room = rooms[roomId];
    if (!room) return socket.emit('waiting', 'Bàn không tồn tại!');
    if (room.players.length >= 2) return socket.emit('waiting', `Bàn [${roomId}] đã đầy!`);

    socket.join(roomId);
    room.players.push(socket);
    room.matchScores[username] = 0;
    room.playerTimers[username] = PLAYER_MAX_TIME;

    io.emit('roomListUpdate', getPublicRooms());

    if (room.players.length === 2) {
      room.currentQ = 0;
      room.activeTurnIndex = 0;

      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        lesson: room.lesson,
        players: room.players.map(p => ({
          name: p.username,
          rank: getRank(Math.ceil(usersData[p.username]?.exp || 0))
        })),
        question: room.questions[room.currentQ]
      });

      startTurnTimer(roomId);
    } else {
      socket.emit('waitingState', { roomId: roomId, lesson: room.lesson });
    }
  });

  socket.on('leaveRoom', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      stopRoomTimer(roomId);
      if (rooms[roomId].botTimer) clearTimeout(rooms[roomId].botTimer);
      socket.leave(roomId);
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      socket.roomId = null;
      io.emit('roomListUpdate', getPublicRooms());
      socket.emit('leftRoomSuccess');
    }
  });

  // 🎯 TRẢ LỜI CÂU HỎI TRONG TRẬN ĐẤU
  socket.on('submitAnswer', (optionIndex) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room) return;

    // Kiểm tra xem có đúng lượt của người bấm hay không
    let activePlayer = room.players[room.activeTurnIndex];
    if (!activePlayer || activePlayer.username !== socket.username) {
      return socket.emit('notice', 'Chưa đến lượt của bạn!');
    }

    let q = room.questions[room.currentQ];
    if (!q) return;

    if (optionIndex === q.answer) {
      // ✅ TRẢ LỜI ĐÚNG: +10 điểm, Tắt đếm ngược & Chuyển lượt sang đối thủ
      stopRoomTimer(roomId);

      room.matchScores[socket.username] = Math.ceil((room.matchScores[socket.username] || 0) + 10);

      io.to(roomId).emit('roundResult', { 
        winner: socket.username, 
        matchScores: room.matchScores,
        correctIndex: q.answer
      });

      // Chuyển lượt (0 -> 1 hoặc 1 -> 0)
      room.activeTurnIndex = room.activeTurnIndex === 0 ? 1 : 0;

      setTimeout(() => {
        room.currentQ++;
        if (room.currentQ < room.questions.length) {
          io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
          startTurnTimer(roomId);
        } else {
          finishGameByQuestions(roomId);
        }
      }, 1200);

    } else {
      // ❌ TRẢ LỜI SAI: Không chuyển lượt, bị trừ 1/3 điểm cơ sở
      let basePoints = getBasePoints(room.lesson);
      let penalty = Math.ceil(basePoints / 3); // Mức phạt = 1/3 basePoints

      let currentScore = room.matchScores[socket.username] || 0;
      room.matchScores[socket.username] = Math.ceil(currentScore - penalty);

      io.to(roomId).emit('roundResult', { winner: null, matchScores: room.matchScores });
      socket.emit('wrongAnswer', { 
        index: optionIndex, 
        msg: `Sai rồi! Bạn bị trừ ${penalty} điểm trận đấu và phải tiếp tục trả lời.` 
      });
    }
  });

  socket.on('disconnect', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      stopRoomTimer(roomId);
      if (rooms[roomId].botTimer) clearTimeout(rooms[roomId].botTimer);

      if (!rooms[roomId].isPractice) {
        io.to(roomId).emit('playerLeft', `${socket.username} đã rời bàn.`);
        createRoomObject(roomId, rooms[roomId].lesson);
        io.emit('roomListUpdate', getPublicRooms());
      } else {
        delete rooms[roomId];
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Socket.io đang chạy tại cổng ${PORT}`));
