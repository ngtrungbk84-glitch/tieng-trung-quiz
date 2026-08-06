const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Load dữ liệu câu hỏi & user
let questionsData = {};
try {
  questionsData = JSON.parse(fs.readFileSync('./questions.json', 'utf8'));
} catch (e) {
  console.log("Chưa thấy file questions.json hoặc lỗi format json");
}

let users = {};
try {
  users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
} catch (e) {
  users = {};
}

function saveUsers() {
  fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
}

let rooms = {};

// Khởi tạo 12 bàn mặc định
for (let i = 1; i <= 12; i++) {
  const roomId = `Bàn ${i}`;
  rooms[roomId] = {
    id: roomId,
    lesson: i,
    players: [],
    spectators: [],
    scores: {},
    currentQuestionIndex: 0,
    currentTurnIndex: 0,
    isStarted: false,
    timer: null,
    playerTimers: {},
    isBotRoom: false
  };
}

io.on('connection', (socket) => {
  // 1. Đăng Nhập / Đăng Ký
  socket.on('login', ({ username, password }) => {
    if (users[username] && users[username].password === password) {
      socket.username = username;
      socket.emit('authResult', { success: true, username, ...users[username] });
      emitRoomList();
      emitLeaderboard();
    } else {
      socket.emit('authResult', { success: false, msg: "Tài khoản hoặc mật khẩu không đúng!" });
    }
  });

  socket.on('register', ({ username, password }) => {
    if (users[username]) {
      return socket.emit('authResult', { success: false, msg: "Tài khoản đã tồn tại!" });
    }
    users[username] = { password, rank: '🌱 Tân thủ', exp: 0, wins: 0 };
    saveUsers();
    socket.username = username;
    socket.emit('authResult', { success: true, username, ...users[username] });
    emitRoomList();
    emitLeaderboard();
  });

  // Đổi Lesson phòng chờ
  socket.on('changeRoomLesson', ({ roomId, lesson }) => {
    const room = rooms[roomId];
    if (room && !room.isStarted) {
      room.lesson = lesson;
      io.to(roomId).emit('lessonUpdated', lesson);
      emitRoomList();
    }
  });

  // 2. Vào / Tạo phòng
  socket.on('joinRoom', ({ username, roomId }) => {
    const room = rooms[roomId];
    if (!room) return;

    socket.username = username;
    socket.roomId = roomId;
    socket.join(roomId);

    if (room.players.length < 2 && !room.isStarted) {
      if (!room.players.some(p => p.name === username)) {
        const uData = users[username] || { rank: '🌱 Tân thủ', exp: 0 };
        room.players.push({ name: username, rank: uData.rank });
      }

      if (room.players.length === 1) {
        socket.emit('waitingState', { roomId: room.id, lesson: room.lesson });
      } else if (room.players.length === 2) {
        startGame(room);
      }
    } else {
      if (!room.spectators.includes(username)) room.spectators.push(username);
      socket.emit('gameStart', {
        roomId: room.id,
        players: room.players,
        isSpectator: true,
        question: questionsData[room.lesson] ? questionsData[room.lesson][room.currentQuestionIndex] : null
      });
    }
    emitRoomList();
  });

  // 3. Xử lý Trả lời (Đồng bộ xử lý cả Index trắc nghiệm và Chuỗi ghép câu)
  socket.on('submitAnswer', (answer) => {
    const room = rooms[socket.roomId];
    if (!room || !room.isStarted) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.name !== socket.username) return;

    const qList = questionsData[room.lesson] || [];
    const currentQ = qList[room.currentQuestionIndex];
    if (!currentQ) return;

    let isCorrect = false;

    // Trường hợp Trắc nghiệm (gửi Index là số: 0, 1, 2)
    if (typeof answer === 'number' && currentQ.options) {
      const selectedOptionText = currentQ.options[answer];
      isCorrect = (selectedOptionText && selectedOptionText.trim().toLowerCase() === String(currentQ.answer).trim().toLowerCase());
    } 
    // Trường hợp Ghép câu (gửi Chuỗi)
    else if (typeof answer === 'string') {
      isCorrect = (answer.trim().toLowerCase() === String(currentQ.answer).trim().toLowerCase());
    }

    if (isCorrect) {
      room.scores[socket.username] = (room.scores[socket.username] || 0) + 10;
      
      // Tìm index của câu trả lời đúng để highlight xanh bên client
      let correctIndex = currentQ.answer;
      if (currentQ.options) {
        correctIndex = currentQ.options.findIndex(opt => opt.trim().toLowerCase() === String(currentQ.answer).trim().toLowerCase());
      }

      io.to(room.id).emit('roundResult', {
        winner: socket.username,
        correctIndex: correctIndex,
        matchScores: room.scores
      });
      setTimeout(() => { nextQuestion(room); }, 1500);
    } else {
      room.scores[socket.username] = Math.max(0, (room.scores[socket.username] || 0) - 5);
      io.to(room.id).emit('wrongAnswer', {
        index: answer,
        msg: `❌ ${socket.username} trả lời chưa chính xác! (-5đ)`
      });
      switchTurn(room);
    }
  });

  // 4. Xử lý Nút Skip (-20 điểm)
  socket.on('skipQuestion', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.isStarted) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.name !== socket.username) return;

    room.scores[socket.username] = (room.scores[socket.username] || 0) - 20;

    io.to(room.id).emit('roundResult', {
      winner: null,
      matchScores: room.scores
    });

    io.to(room.id).emit('newChatMessage', {
      sender: '📢 Hệ thống',
      text: `⚠️ ${socket.username} đã BỎ QUA câu hỏi này (-20 điểm)!`,
      isSpectator: false
    });

    setTimeout(() => {
      nextQuestion(room);
    }, 1000);
  });

  // Chat
  socket.on('sendChatMessage', (text) => {
    if (socket.roomId) {
      const room = rooms[socket.roomId];
      const isSpec = room && room.spectators.includes(socket.username);
      io.to(socket.roomId).emit('newChatMessage', {
        sender: socket.username,
        text: text,
        isSpectator: isSpec
      });
    }
  });

  socket.on('leaveRoom', () => { leaveRoomHandler(socket); });
  socket.on('disconnect', () => { leaveRoomHandler(socket); });
});

function startGame(room) {
  room.isStarted = true;
  room.currentQuestionIndex = 0;
  room.currentTurnIndex = 0;
  room.scores = {};
  room.players.forEach(p => room.scores[p.name] = 0);

  const qList = questionsData[room.lesson] || [];
  io.to(room.id).emit('gameStart', {
    roomId: room.id,
    players: room.players,
    question: qList[0]
  });

  switchTurn(room);
}

function nextQuestion(room) {
  room.currentQuestionIndex++;
  const qList = questionsData[room.lesson] || [];

  if (room.currentQuestionIndex >= qList.length) {
    let winner = null;
    const s1 = room.scores[room.players[0].name] || 0;
    const s2 = room.scores[room.players[1].name] || 0;
    if (s1 > s2) winner = room.players[0].name;
    else if (s2 > s1) winner = room.players[1].name;

    io.to(room.id).emit('gameOver', { winner, matchScores: room.scores });
    resetRoom(room);
  } else {
    io.to(room.id).emit('nextQuestion', qList[room.currentQuestionIndex]);
    switchTurn(room);
  }
}

function switchTurn(room) {
  const activePlayer = room.players[room.currentTurnIndex].name;
  io.to(room.id).emit('turnChanged', {
    activePlayer: activePlayer,
    playerTimers: room.playerTimers
  });
  room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
}

function resetRoom(room) {
  room.isStarted = false;
  room.players = [];
  room.spectators = [];
  room.scores = {};
  emitRoomList();
}

function leaveRoomHandler(socket) {
  if (!socket.roomId) return;
  const room = rooms[socket.roomId];
  if (room) {
    room.players = room.players.filter(p => p.name !== socket.username);
    room.spectators = room.spectators.filter(name => name !== socket.username);
    if (room.players.length < 2) resetRoom(room);
  }
  socket.leave(socket.roomId);
  socket.roomId = null;
  socket.emit('leftRoomSuccess');
  emitRoomList();
}

function emitRoomList() {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    lesson: r.lesson,
    playerCount: r.players.length,
    players: r.players.map(p => p.name)
  }));
  io.emit('roomListUpdate', list);
}

function emitLeaderboard() {
  const board = Object.keys(users).map(u => ({
    username: u,
    rank: users[u].rank || '🌱 Tân thủ',
    exp: users[u].exp || 0
  })).sort((a,b) => b.exp - a.exp);
  io.emit('leaderboardUpdate', board);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
