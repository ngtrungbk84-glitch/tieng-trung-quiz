// server.js (Chạy trên Render) - Đã hỗ trợ Trộn câu hỏi & Bài L10D1 (Audio, Ảnh, Fill, Choice)
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
    console.log("✅ Đã tải dữ liệu Google Sheets thành công!");
  } catch (e) {
    console.error("❌ Lỗi tải Sheet:", e.message);
  }
}

function saveUserDataAsync() {
  fetch(GOOGLE_SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(usersData),
    redirect: "follow"
  }).catch(e => console.error("❌ Lỗi lưu Sheet ngầm:", e.message));
}

loadUserDataFromSheet();

// 🔀 Hàm xáo trộn danh sách câu hỏi ngẫu nhiên (Fisher-Yates Shuffle)
function shuffleArray(array) {
  let arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 📚 Lấy danh sách câu hỏi theo bài và TỰ ĐỘNG TRỘN NGẪU NHIÊN
function getQuestionsByLesson(lesson) {
  if (fs.existsSync(QUESTIONS_FILE)) {
    try {
      const allQ = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
      let rawQuestions = allQ[lesson] || allQ["L10D1"] || allQ["10"] || allQ["1"] || [];
      return shuffleArray(rawQuestions); // Trộn ngẫu nhiên câu hỏi khi lấy ra
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

function getBasePoints(lesson) {
  let l = parseInt(lesson) || 10;
  return Math.ceil(10 + (l - 1) * 2);
}

let roomCounter = 5;
let rooms = {};

for (let i = 1; i <= 5; i++) {
  createRoomObject(`Bàn ${i}`, "10");
}

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
    questions: getQuestionsByLesson(lesson) // Tự động xáo trộn ngẫu nhiên
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

// 🤖 Xử lý Bot tự động trả lời bài ngẫu nhiên
function scheduleBotAnswer(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  if (room.botTimeout) clearTimeout(room.botTimeout);

  let level = room.botLevel || 'medium';
  let delay = level === 'easy' ? (Math.floor(Math.random() * 3000) + 4000) :
              level === 'hard' ? (Math.floor(Math.random() * 1000) + 1500) :
                                 (Math.floor(Math.random() * 2000) + 2500);

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

function handlePlayerForfeit(socket) {
  let roomId = socket.roomId;
  if (!roomId || !rooms[roomId]) return;

  let room = rooms[roomId];
  if (room.isInGame && room.players.some(p => p.id === socket.id)) {
    stopRoomTimer(roomId);
    if (room.botTimeout) clearTimeout(room.botTimeout);

    let loserName = socket.username;
    let winnerPlayer = room.players.find(p => p.id !== socket.id);
    let winnerName = winnerPlayer ? winnerPlayer.username : null;

    room.isInGame = false;
    let basePoints = getBasePoints(room.lesson);

    if (loserName && usersData[loserName]) {
      let oldExp = usersData[loserName].exp || 0;
      usersData[loserName].exp = Math.max(0, oldExp - basePoints);
    }

    if (winnerName && usersData[winnerName]) {
      usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
      usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints);
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
    usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints) + 50);
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
      let rate = room.botLevel === 'easy' ? 0.2 : room.botLevel === 'hard' ? 0.6 : 0.4;
      let earnedExp = Math.ceil(basePoints * rate);
      usersData[humanPlayer.username].exp = Math.ceil((usersData[humanPlayer.username].exp || 0) + earnedExp);
    }
  } else {
    if (winnerName && usersData[winnerName]) {
      usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
      usersData[winnerName].exp = Math.ceil((usersData[winnerName].exp || 0) + basePoints + 50);
    }
    if (loserName && usersData[loserName]) {
      let oldExp = usersData[loserName].exp || 0;
      usersData[loserName].exp = Math.ceil(Math.max(0, oldExp - basePoints) + 50);
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

  socket.on('login', ({ username, password }) => {
    if (!username || !password) {
      return socket.emit('authResult', { success: false, msg: 'Tên và Mật khẩu không được để trống!' });
    }

    let user = usersData[username];
    if (!user) {
      return socket.emit('authResult', { success: false, msg: 'Tài khoản không tồn tại! Bấm Đăng Ký nếu bạn là người mới.' });
    }

    if (String(user.password) !== String(password)) {
      return socket.emit('authResult', { success: false, msg: 'Sai mật khẩu! Vui lòng thử lại.' });
    }

    socket.username = username;
    return socket.emit('authResult', { 
      success: true, 
      type: 'login',
      username: username, 
      exp: Math.ceil(user.exp || 0), 
      wins: user.wins || 0,
      rank: getRank(Math.ceil(user.exp || 0))
    });
  });

  socket.on('register', ({ username, password }) => {
    if (!username || !password) {
      return socket.emit('authResult', { success: false, msg: 'Tên và Mật khẩu không được để trống!' });
    }

    if (usersData[username]) {
      return socket.emit('authResult', { success: false, msg: 'Tên tài khoản này đã có người đăng ký!' });
    }

    usersData[username] = { password: String(password), exp: 0, wins: 0 };
    saveUserDataAsync();

    socket.username = username;
    io.emit('leaderboardUpdate', getLeaderboard());

    return socket.emit('authResult', { 
      success: true, 
      type: 'register',
      username: username, 
      exp: 0, 
      wins: 0,
      rank: getRank(0)
    });
  });

  socket.on('sendChatMessage', (msg) => {
    let roomId = socket.roomId;
    if (!roomId || !rooms[roomId] || !msg || !msg.trim()) return;

    let isSpectator = rooms[roomId].spectators.some(s => s.id === socket.id);
    io.to(roomId).emit('newChatMessage', {
      sender: socket.username,
      text: msg.trim(),
      isSpectator: isSpectator
    });
  });

  socket.on('playerForfeit', () => handlePlayerForfeit(socket));

  socket.on('joinPractice', ({ username, lesson, botLevel }) => {
    if (!username) return;
    socket.username = username;
    let practiceRoomId = `Luyện Tập - ${socket.id.substring(0, 4)}`;
    socket.roomId = practiceRoomId;

    let selectedLevel = botLevel || 'medium';
    let botName = `🤖 Bot Meetmi (${selectedLevel.toUpperCase()})`;

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
      botLevel: selectedLevel,
      botTimeout: null,
      isInGame: true,
      questions: getQuestionsByLesson(lesson || "10") // Lấy câu hỏi trộn ngẫu nhiên
    };

    socket.join(practiceRoomId);
    let rankLabel = selectedLevel === 'easy' ? '🟢 Dễ' : selectedLevel === 'hard' ? '🔴 Khó' : '🟡 Vừa';

    socket.emit('gameStart', {
      roomId: practiceRoomId,
      lesson: lesson || "10",
      isBot: true,
      players: [
        { name: username, rank: getRank(Math.ceil(usersData[username]?.exp || 0)) },
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
    createRoomObject(newRoomId, selectedLesson || "10");
    io.emit('roomListUpdate', getPublicRooms());
  });

  socket.on('changeRoomLesson', ({ roomId, lesson }) => {
    if (rooms[roomId] && rooms[roomId].players.length < 2) {
      rooms[roomId].lesson = lesson;
      rooms[roomId].questions = getQuestionsByLesson(lesson); // Trộn lại câu hỏi khi đổi bài
      io.emit('roomListUpdate', getPublicRooms());
      io.to(roomId).emit('lessonUpdated', lesson);
    }
  });

  socket.on('joinRoom', ({ username, roomId }) => {
    if (!username) return;
    socket.username = username;
    socket.roomId = roomId;

    let room = rooms[roomId];
    if (!room) return socket.emit('notice', 'Bàn không tồn tại!');

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

      let activePlayer = room.players[room.activeTurnIndex];
      if (activePlayer) {
        socket.emit('turnChanged', {
          activePlayer: activePlayer.username,
          playerTimers: room.playerTimers
        });
      }
      return;
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

      if (room.isInGame) {
        handlePlayerForfeit(socket);
      } else {
        room.spectators = room.spectators.filter(s => s.id !== socket.id);
        room.players = room.players.filter(p => p.id !== socket.id);
        socket.leave(roomId);
        socket.roomId = null;
        io.emit('roomListUpdate', getPublicRooms());
      }
      socket.emit('leftRoomSuccess');
    }
  });

  // 🎯 XỬ LÝ ĐÁP ÁN: TRẮC NGHIỆM / ĐIỀN TỪ / AUDIO / HÌNH ẢNH
  socket.on('submitAnswer', (data) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room) return;

    if (room.spectators.some(s => s.id === socket.id)) return;

    let q = room.questions[room.currentQ];
    if (!q) return;

    let basePoints = getBasePoints(room.lesson);
    let penalty = Math.ceil(basePoints / 3);

    let isCorrect = false;
    let userIndex = typeof data === 'object' ? data.index : data;
    let userVal = typeof data === 'object' ? data.value : data;

    // So sánh đáp án linh hoạt theo định dạng
    if (q.type === 'fill' || typeof q.answer === 'string') {
      if (typeof userVal === 'string' && userVal.trim().toLowerCase() === String(q.answer).trim().toLowerCase()) {
        isCorrect = true;
      }
    } else {
      if (parseInt(userIndex) === Number(q.answer)) {
        isCorrect = true;
      }
    }

    if (room.isPractice) {
      if (isCorrect) {
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
        let currentScore = room.matchScores[socket.username] || 0;
        room.matchScores[socket.username] = Math.ceil(currentScore - penalty);

        io.to(roomId).emit('roundResult', { winner: null, matchScores: room.matchScores });
        socket.emit('wrongAnswer', { 
          index: userIndex, 
          msg: `Sai rồi! Bạn bị trừ ${penalty} điểm và phải chọn lại.` 
        });
      }
      return;
    }

    let activePlayer = room.players[room.activeTurnIndex];
    if (!activePlayer || activePlayer.username !== socket.username) {
      return socket.emit('notice', 'Chưa đến lượt của bạn!');
    }

    if (isCorrect) {
      stopRoomTimer(roomId);
      room.matchScores[socket.username] = Math.ceil((room.matchScores[socket.username] || 0) + 10);

      io.to(roomId).emit('roundResult', { 
        winner: socket.username, 
        matchScores: room.matchScores,
        correctIndex: q.answer
      });

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
      let currentScore = room.matchScores[socket.username] || 0;
      room.matchScores[socket.username] = Math.ceil(currentScore - penalty);

      io.to(roomId).emit('roundResult', { winner: null, matchScores: room.matchScores });
      socket.emit('wrongAnswer', { 
        index: userIndex, 
        msg: `Sai rồi! Bạn bị trừ ${penalty} điểm trận đấu và phải tiếp tục trả lời.` 
      });
    }
  });

  socket.on('disconnect', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      let room = rooms[roomId];

      if (room.isInGame) {
        handlePlayerForfeit(socket);
      } else {
        room.spectators = room.spectators.filter(s => s.id !== socket.id);
        room.players = room.players.filter(p => p.id !== socket.id);
        
        if (room.isPractice && room.players.length === 0) {
          delete rooms[roomId];
        } else {
          io.emit('roomListUpdate', getPublicRooms());
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server Socket.io đang chạy tại cổng ${PORT}`));
