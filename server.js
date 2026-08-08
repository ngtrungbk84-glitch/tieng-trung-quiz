// server.js - Đã nâng cấp hỗ trợ đầy đủ các dạng bài tập mới
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbz8SigjCvyT93IbyjyY_hsb5RXXScHVgnRiN_n_4We-P3knig40YvF7Ab1O2GOrk_pgxQ/exec";
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const PLAYER_MAX_TIME = 60; 

let usersData = {};

async function loadUserDataFromSheet() {
  try {
    const res = await fetch(GOOGLE_SHEET_URL, { redirect: "follow" });
    const text = await res.text();
    const loadedData = JSON.parse(text);
    for (let uname in loadedData) {
      usersData[uname] = {
        password: loadedData[uname].password !== undefined ? String(loadedData[uname].password) : "",
        exp: Number(loadedData[uname].exp) || 0,
        wins: Number(loadedData[uname].wins) || 0
      };
    }
  } catch (e) { console.error("Lỗi Sheet:", e.message); }
}

function saveUserDataAsync() {
  fetch(GOOGLE_SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(usersData),
    redirect: "follow"
  }).catch(e => console.error("Lỗi lưu Sheet:", e.message));
}

loadUserDataFromSheet();

function shuffleArray(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function getQuestionsByLesson(lesson) {
  if (fs.existsSync(QUESTIONS_FILE)) {
    try {
      const allQ = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
      let rawQuestions = allQ[lesson] || allQ["10"] || allQ["1"] || [];
      return shuffleArray(rawQuestions);
    } catch (e) { return []; }
  }
  return [];
}

function getRank(exp) {
  if (exp >= 500) return "🐉 HSK Master";
  if (exp >= 200) return "🥇 Cao thủ";
  if (exp >= 100) return "🥈 Trung cấp";
  if (exp >= 30)  return "🥉 Sơ cấp";
  return "🌱 Tân thủ";
}

function getBasePoints(lesson) {
  let l = parseInt(lesson) || 10;
  return Math.ceil(10 + (l - 1) * 2);
}

let roomCounter = 5;
let rooms = {};

for (let i = 1; i <= 5; i++) { createRoomObject(`Bàn ${i}`, "10"); }

function createRoomObject(roomId, lesson = "10") {
  rooms[roomId] = {
    id: roomId,
    lesson: lesson,
    players: [],
    spectators: [],
    currentQ: 0,
    matchScores: {},
    playerTimers: {},
    activeTurnIndex: 0,
    timerInterval: null,
    isPractice: false,
    botLevel: 'medium',
    botTimeout: null,
    isInGame: false,
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

function stopRoomTimer(roomId) {
  let room = rooms[roomId];
  if (room && room.timerInterval) {
    clearInterval(room.timerInterval);
    room.timerInterval = null;
  }
}

function startTurnTimer(roomId) {
  let room = rooms[roomId];
  if (!room || room.players.length < 2 || room.isPractice) return;

  stopRoomTimer(roomId);
  let activePlayer = room.players[room.activeTurnIndex];
  if (!activePlayer) return;

  io.to(roomId).emit('turnChanged', {
    activePlayer: activePlayer.username,
    playerTimers: room.playerTimers
  });

  room.timerInterval = setInterval(() => {
    if (!room || !room.playerTimers[activePlayer.username]) return;

    room.playerTimers[activePlayer.username]--;
    io.to(roomId).emit('timerUpdate', { playerTimers: room.playerTimers });

    if (room.playerTimers[activePlayer.username] <= 0) {
      stopRoomTimer(roomId);
      let loserName = activePlayer.username;
      let winnerPlayer = room.players.find(p => p.username !== loserName);
      let winnerName = winnerPlayer ? winnerPlayer.username : null;

      finishGameDueToTimeout(roomId, winnerName, loserName);
    }
  }, 1000);
}
function finishGameDueToForfeit(roomId, winnerName, loserName) {
  let room = rooms[roomId];
  if (!room) return;

  room.isInGame = false;
  stopRoomTimer(roomId);
  if (room.botTimeout) clearTimeout(room.botTimeout);

  let basePoints = getBasePoints(room.lesson);

  if (winnerName && usersData[winnerName]) {
    usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
    usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints + 50);
  }
  if (loserName && usersData[loserName]) {
    let oldExp = usersData[loserName].exp || 0;
    usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints * 1.5)); // Trừ điểm nặng hơn khi chủ động bỏ cuộc
  }

  saveUserDataAsync();
  io.to(roomId).emit('gameOver', { winner: winnerName, loser: loserName, reason: 'forfeit' });
  io.emit('leaderboardUpdate', getLeaderboard());

  if (!room.isPractice) {
    createRoomObject(roomId, room.lesson);
    io.emit('roomListUpdate', getPublicRooms());
  } else {
    delete rooms[roomId];
  }
}
function scheduleBotAnswer(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  if (room.botTimeout) clearTimeout(room.botTimeout);

  let level = room.botLevel || 'medium';
  let delay = level === 'easy' ? 5000 : level === 'hard' ? 2000 : 3500;
  let botName = `🤖 Bot Meetmi (${level.toUpperCase()})`;

  room.botTimeout = setTimeout(() => {
    if (!rooms[roomId]) return;
    let q = room.questions[room.currentQ];
    if (!q) return;

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
        scheduleBotAnswer(roomId);
      } else {
        finishGameByQuestions(roomId);
      }
    }, 1200);
  }, delay);
}

function finishGameDueToTimeout(roomId, winnerName, loserName) {
  let room = rooms[roomId];
  if (!room) return;

  room.isInGame = false;
  let basePoints = getBasePoints(room.lesson);

  if (winnerName && usersData[winnerName]) {
    usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
    usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints + 50);
  }
  if (loserName && usersData[loserName]) {
    let oldExp = usersData[loserName].exp || 0;
    usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints));
  }

  saveUserDataAsync();
  io.to(roomId).emit('gameOver', { winner: winnerName, loser: loserName, reason: 'timeout' });
  io.emit('leaderboardUpdate', getLeaderboard());

  createRoomObject(roomId, room.lesson);
  io.emit('roomListUpdate', getPublicRooms());
}

function finishGameByQuestions(roomId) {
  let room = rooms[roomId];
  if (!room) return;

  room.isInGame = false;
  stopRoomTimer(roomId);
  if (room.botTimeout) clearTimeout(room.botTimeout);

  let p1 = room.players[0] ? room.players[0].username : null;
  let p2 = room.players[1] ? room.players[1].username : null;
  let winnerName = null, loserName = null;

  if (p1 && p2) {
    if (room.matchScores[p1] > room.matchScores[p2]) { winnerName = p1; loserName = p2; }
    else if (room.matchScores[p2] > room.matchScores[p1]) { winnerName = p2; loserName = p1; }
  }

  let basePoints = getBasePoints(room.lesson);

  if (room.isPractice) {
    let humanPlayer = room.players.find(p => !p.username.startsWith("🤖 Bot"));
    if (humanPlayer && winnerName === humanPlayer.username && usersData[humanPlayer.username]) {
      usersData[humanPlayer.username].wins = (usersData[humanPlayer.username].wins || 0) + 1;
      usersData[humanPlayer.username].exp = Math.ceil((usersData[humanPlayer.username].exp || 0) + basePoints * 0.5);
    }
  } else {
    if (winnerName && usersData[winnerName]) {
      usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
      usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints + 50);
    }
    if (loserName && usersData[loserName]) {
      let oldExp = usersData[loserName].exp || 0;
      usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints));
    }
  }

  saveUserDataAsync();
  io.to(roomId).emit('gameOver', { winner: winnerName, loser: loserName, reason: 'questionsEnded' });
  io.emit('leaderboardUpdate', getLeaderboard());

  if (!room.isPractice) {
    createRoomObject(roomId, room.lesson);
    io.emit('roomListUpdate', getPublicRooms());
  } else {
    delete rooms[roomId];
  }
}

// ------------------- SOCKET ENGINE -------------------
io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getPublicRooms());
  socket.emit('leaderboardUpdate', getLeaderboard());
// 🚪 XỬ LÝ NÚT QUAY LẠI SẢNH (BACK TO LOBBY)
  socket.on('backToLobby', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      let room = rooms[roomId];

      // Nếu đang trong trận đấu mà tự ý rời phòng quay lại sảnh => Xử Bỏ cuộc
      if (room.isInGame) {
        let loserName = socket.username;
        let winnerPlayer = room.players.find(p => p.username !== loserName);
        let winnerName = winnerPlayer ? winnerPlayer.username : null;
        
        // Cho người rời phòng thua ngay lập tức
        finishGameDueToForfeit(roomId, winnerName, loserName);
      } else {
        // Nếu chưa vào game (đang ở phòng chờ) thì chỉ xóa người chơi khỏi phòng
        room.players = room.players.filter(p => p.username !== socket.username);
        socket.leave(roomId);
        socket.roomId = null;

        // Nếu phòng không còn ai thì xóa phòng
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit('updateRoom', room);
        }
        io.emit('roomListUpdate', getPublicRooms());
      }
    }
    
    // Gửi thông báo xác nhận đã rời phòng thành công về cho Client
    socket.emit('leftRoomSuccess');
  });
  socket.on('login', ({ username, password }) => {
    let user = usersData[username];
    if (!user || String(user.password) !== String(password)) {
      return socket.emit('authResult', { success: false, msg: 'Sai tài khoản hoặc mật khẩu!' });
    }
    socket.username = username;
    return socket.emit('authResult', { 
      success: true, username: username, exp: Math.ceil(user.exp || 0), wins: user.wins || 0, rank: getRank(Math.ceil(user.exp || 0))
    });
  });

  socket.on('register', ({ username, password }) => {
    if (usersData[username]) return socket.emit('authResult', { success: false, msg: 'Tài khoản đã tồn tại!' });
    usersData[username] = { password: String(password), exp: 0, wins: 0 };
    saveUserDataAsync();
    socket.username = username;
    io.emit('leaderboardUpdate', getLeaderboard());
    return socket.emit('authResult', { success: true, username: username, exp: 0, wins: 0, rank: getRank(0) });
  });

  socket.on('joinPractice', ({ username, lesson, botLevel }) => {
    socket.username = username;
    let practiceRoomId = `Luyện Tập - ${socket.id.substring(0, 4)}`;
    socket.roomId = practiceRoomId;
    let botName = `🤖 Bot Meetmi (${(botLevel || 'medium').toUpperCase()})`;

    rooms[practiceRoomId] = {
      id: practiceRoomId,
      lesson: lesson || "10",
      players: [socket, { username: botName }],
      spectators: [],
      currentQ: 0,
      matchScores: { [username]: 0, [botName]: 0 },
      playerTimers: {},
      activeTurnIndex: 0,
      timerInterval: null,
      isPractice: true,
      botLevel: botLevel || 'medium',
      botTimeout: null,
      isInGame: true,
      questions: getQuestionsByLesson(lesson || "10")
    };

    socket.join(practiceRoomId);
    socket.emit('gameStart', {
      roomId: practiceRoomId,
      lesson: lesson || "10",
      isBot: true,
      players: [{ name: username, rank: getRank(usersData[username]?.exp || 0) }, { name: botName, rank: `AI` }],
      question: rooms[practiceRoomId].questions[0]
    });

    scheduleBotAnswer(practiceRoomId);
  });

  socket.on('joinRoom', ({ username, roomId }) => {
    socket.username = username;
    socket.roomId = roomId;
    let room = rooms[roomId];
    if (!room) return;

    if (room.players.length >= 2) {
      socket.join(roomId);
      room.spectators.push(socket);
      return socket.emit('gameStart', {
        roomId: roomId,
        lesson: room.lesson,
        isSpectator: true,
        players: room.players.map(p => ({ name: p.username, rank: getRank(usersData[p.username]?.exp || 0) })),
        question: room.questions[room.currentQ]
      });
    }

    socket.join(roomId);
    room.players.push(socket);
    room.matchScores[username] = 0;
    room.playerTimers[username] = PLAYER_MAX_TIME;
    io.emit('roomListUpdate', getPublicRooms());

    if (room.players.length === 2) {
      room.currentQ = 0;
      room.activeTurnIndex = 0;
      room.isInGame = true;

      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        lesson: room.lesson,
        isSpectator: false,
        players: room.players.map(p => ({ name: p.username, rank: getRank(usersData[p.username]?.exp || 0) })),
        question: room.questions[room.currentQ]
      });

      startTurnTimer(roomId);
    } else {
      socket.emit('waitingState', { roomId: roomId, lesson: room.lesson });
    }
  });

  /* 🧠 BỘ SO SÁNH ĐÁP ÁN ĐA DẠNG GAME (UPDATED) */
  socket.on('submitAnswer', (userVal) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room || room.spectators.some(s => s.id === socket.id)) return;

    let q = room.questions[room.currentQ];
    if (!q) return;

    const cleanStr = (s) => String(s || '').toLowerCase().replace(/[.,?!]/g, '').replace(/\s+/g, ' ').trim();
    let isCorrect = false;

    // 1. Kiểm tra Đúng / Sai (True / False)
    if (q.type === 'true_false') {
      isCorrect = Boolean(userVal) === Boolean(q.answer);
    } 
    // 2. Kiểm tra Điền từ (Fill in)
    else if (q.type === 'fill_in') {
      isCorrect = cleanStr(userVal) === cleanStr(q.answer);
    } 
    // 3. Kiểm tra Nối từ (Matching)
    else if (q.type === 'matching') {
      // userVal gửi lên là mảng các cặp nối [ {left: "", right: ""} ]
      if (Array.isArray(userVal) && userVal.length === q.pairs.length) {
        isCorrect = userVal.every(pair => 
          q.pairs.some(target => cleanStr(target.left) === cleanStr(pair.left) && cleanStr(target.right) === cleanStr(pair.right))
        );
      }
    } 
    // 4. Kiểm tra Phân loại (Drag Drop)
    else if (q.type === 'drag_drop') {
      if (Array.isArray(userVal)) {
        isCorrect = userVal.every(item => 
          q.items.some(target => cleanStr(target.word) === cleanStr(item.word) && cleanStr(target.category) === cleanStr(item.category))
        );
      }
    }
    // 5. Kiểm tra Nhận diện nói (Speaking)
    else if (q.type === 'speaking') {
      isCorrect = cleanStr(userVal).includes(cleanStr(q.phrase)) || cleanStr(q.phrase).includes(cleanStr(userVal));
    }
    // 6. Kiểm tra Trắc nghiệm & Ghép từ truyền thống
    else if (q.type === 'arrange' || typeof q.answer === 'string') {
      isCorrect = cleanStr(userVal) === cleanStr(q.answer);
    } else {
      isCorrect = parseInt(userVal) === Number(q.answer);
    }

    let basePoints = getBasePoints(room.lesson);
    let penalty = Math.ceil(basePoints / 3);

    if (isCorrect) {
      if (!room.isPractice) stopRoomTimer(roomId);
      else if (room.botTimeout) clearTimeout(room.botTimeout);

      room.matchScores[socket.username] = Math.ceil((room.matchScores[socket.username] || 0) + 10);

      io.to(roomId).emit('roundResult', { 
        winner: socket.username, 
        matchScores: room.matchScores,
        correctIndex: q.answer
      });

      if (!room.isPractice) room.activeTurnIndex = room.activeTurnIndex === 0 ? 1 : 0;

      setTimeout(() => {
        room.currentQ++;
        if (room.currentQ < room.questions.length) {
          io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
          if (room.isPractice) scheduleBotAnswer(roomId);
          else startTurnTimer(roomId);
        } else {
          finishGameByQuestions(roomId);
        }
      }, 1200);

    } else {
      room.matchScores[socket.username] = Math.ceil((room.matchScores[socket.username] || 0) - penalty);
      io.to(roomId).emit('roundResult', { winner: null, matchScores: room.matchScores });
      socket.emit('wrongAnswer', { msg: `Sai rồi! Bị trừ ${penalty} điểm.` });
    }
  });

  // 🏳️ XỬ LÝ NÚT BỎ CUỘC (FORFEIT)
  socket.on('playerForfeit', () => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room || !room.isInGame) return;

    let loserName = socket.username;
    let winnerPlayer = room.players.find(p => p.username !== loserName);
    let winnerName = winnerPlayer ? winnerPlayer.username : null;

    // Gọi hàm kết thúc trận đấu do có người bỏ cuộc
    finishGameDueToForfeit(roomId, winnerName, loserName);
  });

  // ⏩ XỬ LÝ NÚT BỎ QUA CÂU HỎI (SKIP)
  socket.on('skipQuestion', () => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room || !room.isInGame) return;

    let q = room.questions[room.currentQ];
    if (!q) return;

    // Kiểm tra đúng lượt chơi (nếu không phải đấu bot)
    if (!room.isPractice) {
      let activePlayer = room.players[room.activeTurnIndex];
      if (!activePlayer || activePlayer.username !== socket.username) return;
    }

    // Trừ 20 điểm người chơi bấm Skip
    let penalty = 20;
    room.matchScores[socket.username] = Math.ceil((room.matchScores[socket.username] || 0) - penalty);

    // Dừng timer hiện tại nếu có
    if (!room.isPractice) stopRoomTimer(roomId);
    else if (room.botTimeout) clearTimeout(room.botTimeout);

    // Báo kết quả Bỏ qua câu hỏi về cho Client
    io.to(roomId).emit('roundResult', { 
      winner: null, 
      isSkip: true,
      player: socket.username,
      matchScores: room.matchScores,
      correctIndex: q.answer
    });

    // Đổi lượt chơi nếu không phải đấu Bot
    if (!room.isPractice) room.activeTurnIndex = room.activeTurnIndex === 0 ? 1 : 0;

    // Chuyển sang câu hỏi tiếp theo sau 1.2 giây
    setTimeout(() => {
      room.currentQ++;
      if (room.currentQ < room.questions.length) {
        io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        if (room.isPractice) scheduleBotAnswer(roomId);
        else startTurnTimer(roomId);
      } else {
        finishGameByQuestions(roomId);
      }
    }, 1200);
  });
  // 🔌 XỬ LÝ KHI NGƯỜI CHƠI MẤT KẾT NỐI / REFRESH TRANG
  socket.on('disconnect', () => {
    let username = socket.username;
    let roomId = socket.roomId;

    if (username) {
      delete activeUsers[username];
      io.emit('onlineUsersUpdate', Object.keys(activeUsers));
    }

    if (roomId && rooms[roomId]) {
      let room = rooms[roomId];

      // Nếu người chơi Refresh / Tắt tab KHI ĐANG TRONG TRẬN ĐẤU
      if (room.isInGame) {
        let loserName = username;
        let winnerPlayer = room.players.find(p => p.username !== loserName);
        let winnerName = winnerPlayer ? winnerPlayer.username : null;

        // Xử bỏ cuộc ngay lập tức
        finishGameDueToForfeit(roomId, winnerName, loserName);
      } else {
        // Nếu chưa vào trận thì xóa khỏi phòng chờ
        room.players = room.players.filter(p => p.username !== username);
        if (room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.to(roomId).emit('updateRoom', room);
        }
        io.emit('roomListUpdate', getPublicRooms());
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
