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

// Cấu hình thời gian chơi mặc định (tính bằng giây) cho mỗi người chơi trong PvP
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
    players: [],         // Tối đa 2 VĐV chính
    spectators: [],      // Danh sách khán giả xem trực tiếp
    currentQ: 0,
    matchScores: {},
    playerTimers: {},    // Lưu thời gian còn lại của từng người chơi (Dùng cho PVP)
    activeTurnIndex: 0,  // Chỉ số người chơi đang đến lượt (0 hoặc 1)
    timerInterval: null, // Interval đếm ngược lượt PVP
    isPractice: false,
    botLevel: 'medium',
    botTimeout: null,
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

// ⏳ BẮT ĐẦU ĐẾM NGƯỢC CHO NGƯỜI ĐANG ĐẾN LƯỢT (CHỈ DÙNG PVP 1v1)
function startTurnTimer(roomId) {
  let room = rooms[roomId];
  if (!room || room.players.length < 2 || room.isPractice) return;

  stopRoomTimer(roomId);

  let activePlayer = room.players[room.activeTurnIndex];
  if (!activePlayer) return;

  // Báo cho client biết hiện tại đang là lượt của ai
  io.to(roomId).emit('turnChanged', {
    activePlayer: activePlayer.username,
    playerTimers: room.playerTimers
  });

  // Đếm ngược mỗi 1 giây cho người chơi lượt hiện tại
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

// 🤖 BOT TỰ ĐỘNG BẤM ĐÁP ÁN KHI LUYỆN TẬP
function scheduleBotAnswer(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  if (room.botTimeout) clearTimeout(room.botTimeout);

  let level = room.botLevel || 'medium';
  let delay = level === 'easy' ? (Math.floor(Math.random() * 3000) + 4000) :
              level === 'hard' ? (Math.floor(Math.random() * 1000) + 1500) :
                                 (Math.floor(Math.random() * 2000) + 2500);

  let botName = `🤖 Bot HSK (${level.toUpperCase()})`;

  room.botTimeout = setTimeout(() => {
    if (!rooms[roomId]) return;
    let q = room.questions[room.currentQ];
    if (!q) return;

    // Bot bấm trả lời đúng
    room.matchScores[botName] = Math.ceil((room.matchScores[botName] || 0) + 10);

    io.to(roomId).emit('roundResult', { 
      winner: botName, 
      matchScores: room.matchScores,
      correctIndex: q.answer
    });

    setTimeout(() => {
      room.currentQ++;
      if (room.currentQ < room.questions.length) {
        io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        scheduleBotAnswer(roomId); // Đếm ngược câu tiếp theo cho Bot
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

  if (winnerName && usersData[winnerName]) {
    usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
    usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints);
  }
  if (loserName && usersData[loserName]) {
    let oldExp = usersData[loserName].exp || 0;
    usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints));
  }

  saveUserDataAsync();
  io.to(roomId).emit('gameOver', { winner: winnerName, reason: 'timeout' });
  io.emit('leaderboardUpdate', getLeaderboard());

  createRoomObject(roomId, room.lesson);
  io.emit('roomListUpdate', getPublicRooms());
}

// 🏆 TỔNG KẾT KHI HẾT CÂU HỎI (TÍNH THEO ĐIỂM)
function finishGameByQuestions(roomId) {
  let room = rooms[roomId];
  if (!room) return;

  stopRoomTimer(roomId);
  if (room.botTimeout) clearTimeout(room.botTimeout);

  let p1 = room.players[0] ? room.players[0].username : null;
  let p2 = room.players[1] ? room.players[1].username : null;
  let winnerName = null;
  let loserName = null;

  if (p1 && p2) {
    if (room.matchScores[p1] > room.matchScores[p2]) {
      winnerName = p1; loserName = p2;
    } else if (room.matchScores[p2] > room.matchScores[p1]) {
      winnerName = p2; loserName = p1;
    }
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

  // 💬 XỬ LÝ CHÁT TRONG BÀN CHƠI
  socket.on('sendChatMessage', (msg) => {
    let roomId = socket.roomId;
    if (!roomId || !rooms[roomId] || !msg || !msg.trim()) return;

    let isSpectator = rooms[roomId].spectators.some(s => s.id === socket.id);
    
    // Gửi tin nhắn tới toàn bộ mọi người trong phòng (Cả người chơi & khán giả)
    io.to(roomId).emit('newChatMessage', {
      sender: socket.username,
      text: msg.trim(),
      isSpectator: isSpectator
    });
  });

  // 🤖 LUYỆN TẬP VỚI BOT
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
      spectators: [],
      currentQ: 0,
      matchScores: { [username]: 0, [botName]: 0 },
      playerTimers: {},
      activeTurnIndex: 0,
      timerInterval: null,
      isPractice: true,
      botLevel: selectedLevel,
      botTimeout: null,
      questions: getQuestionsByLesson(lesson || 1)
    };

    socket.join(practiceRoomId);
    let rankLabel = selectedLevel === 'easy' ? '🟢 Dễ' : selectedLevel === 'hard' ? '🔴 Khó' : '🟡 Vừa';

    socket.emit('gameStart', {
      roomId: practiceRoomId,
      lesson: lesson || 1,
      isBot: true,
      players: [
        { name: username, rank: getRank(Math.ceil(usersData[username].exp || 0)) },
        { name: botName, rank: `AI ${rankLabel}` }
      ],
      question: rooms[practiceRoomId].questions[0]
    });

    scheduleBotAnswer(practiceRoomId);
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
    if (!room) return socket.emit('notice', 'Bàn không tồn tại!');

    // 👁️ CHẾ ĐỘ KHÁN GIẢ: Nếu phòng đã đủ 2 VĐV -> Cho vào xem
    if (room.players.length >= 2) {
      socket.join(roomId);
      room.spectators.push(socket);

      let p1 = room.players[0], p2 = room.players[1];
      socket.emit('gameStart', {
        roomId: roomId,
        lesson: room.lesson,
        isSpectator: true,
        players: [
          { name: p1.username, rank: getRank(Math.ceil(usersData[p1.username]?.exp || 0)) },
          { name: p2.username, rank: getRank(Math.ceil(usersData[p2.username]?.exp || 0)) }
        ],
        question: room.questions[room.currentQ]
      });

      // Đồng bộ thông tin trận đấu đang diễn ra cho Khán giả
      let activePlayer = room.players[room.activeTurnIndex];
      if (activePlayer) {
        socket.emit('turnChanged', {
          activePlayer: activePlayer.username,
          playerTimers: room.playerTimers
        });
      }
      return;
    }

    // 🤺 CHẾ ĐỘ NGƯỜI CHƠI CHÍNH
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
        isSpectator: false,
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
      let room = rooms[roomId];
      
      // Xóa khỏi danh sách khán giả
      room.spectators = room.spectators.filter(s => s.id !== socket.id);

      // Nếu là VĐV rời bàn
      if (room.players.some(p => p.id === socket.id)) {
        stopRoomTimer(roomId);
        if (room.botTimeout) clearTimeout(room.botTimeout);
        socket.leave(roomId);
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.roomId = null;

        if (!room.isPractice) {
          io.to(roomId).emit('playerLeft', `${socket.username} đã rời bàn.`);
          createRoomObject(roomId, room.lesson);
          io.emit('roomListUpdate', getPublicRooms());
        } else {
          delete rooms[roomId];
        }
      } else {
        socket.leave(roomId);
        socket.roomId = null;
      }
      socket.emit('leftRoomSuccess');
    }
  });

  // 🎯 TRẢ LỜI CÂU HỎI TRONG TRẬN ĐẤU
  socket.on('submitAnswer', (optionIndex) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room) return;

    // Chặn khán giả gửi đáp án
    if (room.spectators.some(s => s.id === socket.id)) return;

    let q = room.questions[room.currentQ];
    if (!q) return;

    let basePoints = getBasePoints(room.lesson);
    let penalty = Math.ceil(basePoints / 3);

    // 🟢 1. CHẾ ĐỘ ĐẤU VỚI BOT (Ai nhanh tay hơn)
    if (room.isPractice) {
      if (optionIndex === q.answer) {
        if (room.botTimeout) clearTimeout(room.botTimeout);

        room.matchScores[socket.username] = Math.ceil((room.matchScores[socket.username] || 0) + 10);

        io.to(roomId).emit('roundResult', { 
          winner: socket.username, 
          matchScores: room.matchScores,
          correctIndex: q.answer
        });

        setTimeout(() => {
          room.currentQ++;
          if (room.currentQ < room.questions.length) {
            io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
            scheduleBotAnswer(roomId);
          } else {
            finishGameByQuestions(roomId);
          }
        }, 1200);
      } else {
        // ❌ TRỪ ĐIỂM KHI CHỌN SAI LÚC CHƠI VỚI BOT
        let currentScore = room.matchScores[socket.username] || 0;
        room.matchScores[socket.username] = Math.ceil(currentScore - penalty);

        io.to(roomId).emit('roundResult', { winner: null, matchScores: room.matchScores });
        socket.emit('wrongAnswer', { 
          index: optionIndex, 
          msg: `Sai rồi! Bạn bị trừ ${penalty} điểm và phải tiếp tục chọn lại.` 
        });
      }
      return;
    }

    // 🟢 2. CHẾ ĐỘ PVP NGƯỜI VS NGƯỜI (Theo lượt)
    let activePlayer = room.players[room.activeTurnIndex];
    if (!activePlayer || activePlayer.username !== socket.username) {
      return socket.emit('notice', 'Chưa đến lượt của bạn!');
    }

    if (optionIndex === q.answer) {
      // ✅ TRẢ LỜI ĐÚNG: +10 điểm & Đổi lượt
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
      // ❌ TRẢ LỜI SAI: Bị trừ 1/3 điểm cơ sở
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
      let room = rooms[roomId];

      // Nếu khán giả ngắt kết nối
      room.spectators = room.spectators.filter(s => s.id !== socket.id);

      // Nếu VĐV chính ngắt kết nối
      if (room.players.some(p => p.id === socket.id)) {
        stopRoomTimer(roomId);
        if (room.botTimeout) clearTimeout(room.botTimeout);

        if (!room.isPractice) {
          io.to(roomId).emit('playerLeft', `${socket.username} đã rời bàn.`);
          createRoomObject(roomId, room.lesson);
          io.emit('roomListUpdate', getPublicRooms());
        } else {
          delete rooms[roomId];
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Socket.io đang chạy tại cổng ${PORT}`));
