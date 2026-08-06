const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

// Trả về file index.html khi truy cập web
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

let questionsData = {};
try {
  if (fs.existsSync('./questions.json')) {
    questionsData = JSON.parse(fs.readFileSync('./questions.json', 'utf8'));
  }
} catch (e) {
  console.log("⚠️ File questions.json lỗi hoặc không có. Dùng dữ liệu rỗng.");
}

let users = {};
try {
  if (fs.existsSync('./users.json')) {
    users = JSON.parse(fs.readFileSync('./users.json', 'utf8'));
  }
} catch (e) {
  users = {};
}

function saveUsers() {
  try {
    fs.writeFileSync('./users.json', JSON.stringify(users, null, 2));
  } catch (e) {
    console.error("⚠️ Không thể ghi file users.json (Chế độ Read-only):", e.message);
  }
}

let rooms = {};

// Khởi tạo 12 bàn chơi
function initRooms() {
  for (let i = 1; i <= 12; i++) {
    const roomId = `Bàn ${i}`;
    rooms[roomId] = {
      id: roomId,
      lesson: 10,
      players: [],
      spectators: [],
      scores: {},
      currentQuestionIndex: 0,
      currentTurnIndex: 0,
      isStarted: false,
      playerTimers: {}
    };
  }
}
initRooms();

io.on('connection', (socket) => {
  // Tự động gửi danh sách bàn và BXH ngay khi client vừa kết nối
  socket.emit('roomListUpdate', getRoomListData());
  socket.emit('leaderboardUpdate', getLeaderboardData());

  // ĐĂNG NHẬP
  socket.on('login', ({ username, password }) => {
    if (!username || !password) {
      return socket.emit('authResult', { success: false, msg: "Vui lòng nhập đầy đủ thông tin!" });
    }
    const user = users[username];
    if (user && user.password === password) {
      socket.username = username;
      socket.emit('authResult', { 
        success: true, 
        username: username, 
        rank: user.rank || '🌱 Tân thủ', 
        exp: user.exp || 0 
      });
    } else {
      socket.emit('authResult', { success: false, msg: "Tài khoản hoặc mật khẩu không đúng!" });
    }
  });

  // ĐĂNG KÝ
  socket.on('register', ({ username, password }) => {
    if (!username || !password) {
      return socket.emit('authResult', { success: false, msg: "Vui lòng nhập tên và mật khẩu!" });
    }
    if (users[username]) {
      return socket.emit('authResult', { success: false, msg: "Tài khoản này đã tồn tại!" });
    }

    // Tạo user mới
    users[username] = { password, rank: '🌱 Tân thủ', exp: 0, wins: 0 };
    saveUsers(); // Lưu file

    socket.username = username;
    socket.emit('authResult', { 
      success: true, 
      username: username, 
      rank: users[username].rank, 
      exp: users[username].exp 
    });

    // Cập nhật BXH toàn bộ máy chủ
    io.emit('leaderboardUpdate', getLeaderboardData());
  });

  // Vào phòng chơi
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
      const qList = questionsData[room.lesson] || [];
      socket.emit('gameStart', {
        roomId: room.id,
        players: room.players,
        isSpectator: true,
        question: qList[room.currentQuestionIndex] || null
      });
    }
    emitRoomList();
  });

  // Nộp câu trả lời
  socket.on('submitAnswer', (answer) => {
    try {
      const room = rooms[socket.roomId];
      if (!room || !room.isStarted) return;

      const activePlayer = room.players[room.currentTurnIndex];
      if (!activePlayer || activePlayer.name !== socket.username) return;

      const qList = questionsData[room.lesson] || [];
      const currentQ = qList[room.currentQuestionIndex];
      if (!currentQ) return;

      let isCorrect = false;

      if (typeof answer === 'number' && currentQ.options) {
        const selectedText = currentQ.options[answer];
        isCorrect = selectedText && (selectedText.trim().toLowerCase() === String(currentQ.answer).trim().toLowerCase());
      } else if (typeof answer === 'string') {
        isCorrect = (answer.trim().toLowerCase() === String(currentQ.answer).trim().toLowerCase());
      }

      if (isCorrect) {
        room.scores[socket.username] = (room.scores[socket.username] || 0) + 10;
        
        let correctIdx = currentQ.answer;
        if (currentQ.options) {
          correctIdx = currentQ.options.findIndex(opt => opt.trim().toLowerCase() === String(currentQ.answer).trim().toLowerCase());
        }

        io.to(room.id).emit('roundResult', {
          winner: socket.username,
          correctIndex: correctIdx,
          matchScores: room.scores
        });

        setTimeout(() => { nextQuestion(room); }, 1200);
      } else {
        room.scores[socket.username] = Math.max(0, (room.scores[socket.username] || 0) - 5);
        io.to(room.id).emit('wrongAnswer', {
          index: answer,
          msg: `❌ ${socket.username} chọn chưa đúng (-5đ)!`
        });
        switchTurn(room);
      }
    } catch (err) {
      console.error("Lỗi submitAnswer:", err);
    }
  });

  // Bỏ qua câu hỏi
  socket.on('skipQuestion', () => {
    const room = rooms[socket.roomId];
    if (!room || !room.isStarted) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (!activePlayer || activePlayer.name !== socket.username) return;

    room.scores[socket.username] = Math.max(0, (room.scores[socket.username] || 0) - 20);

    io.to(room.id).emit('roundResult', { winner: null, matchScores: room.scores });
    io.to(room.id).emit('newChatMessage', {
      sender: '📢 Hệ thống',
      text: `⚠️ ${socket.username} đã BỎ QUA câu hỏi này (-20đ)!`,
      isSpectator: false
    });

    setTimeout(() => { nextQuestion(room); }, 1000);
  });

  // Chat
  socket.on('sendChatMessage', (text) => {
    if (socket.roomId && text) {
      const room = rooms[socket.roomId];
      const isSpec = room ? room.spectators.includes(socket.username) : false;
      io.to(socket.roomId).emit('newChatMessage', {
        sender: socket.username || 'Khách',
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
  room.players.forEach(p => {
    room.scores[p.name] = 0;
    room.playerTimers[p.name] = 60;
  });

  const qList = questionsData[room.lesson] || [];
  io.to(room.id).emit('gameStart', {
    roomId: room.id,
    players: room.players,
    question: qList[0] || { q: "Chưa có câu hỏi", options: [] }
  });

  switchTurn(room);
}

function nextQuestion(room) {
  room.currentQuestionIndex++;
  const qList = questionsData[room.lesson] || [];

  if (room.currentQuestionIndex >= qList.length) {
    let winner = null;
    const p1 = room.players[0]?.name;
    const p2 = room.players[1]?.name;
    const s1 = room.scores[p1] || 0;
    const s2 = room.scores[p2] || 0;

    if (s1 > s2) winner = p1;
    else if (s2 > s1) winner = p2;

    io.to(room.id).emit('gameOver', { winner, matchScores: room.scores });
    resetRoom(room);
  } else {
    io.to(room.id).emit('nextQuestion', qList[room.currentQuestionIndex]);
    switchTurn(room);
  }
}

function switchTurn(room) {
  if (!room.players || room.players.length === 0) return;
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
    if (room.players.length < 2 && room.isStarted) {
      io.to(room.id).emit('gameOver', { winner: room.players[0]?.name || 'Đối thủ', reason: 'forfeit' });
      resetRoom(room);
    }
  }
  socket.leave(socket.roomId);
  socket.roomId = null;
  socket.emit('leftRoomSuccess');
  emitRoomList();
}

function getRoomListData() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    lesson: r.lesson,
    playerCount: r.players.length,
    players: r.players.map(p => p.name)
  }));
}

function emitRoomList() {
  io.emit('roomListUpdate', getRoomListData());
}

function getLeaderboardData() {
  return Object.keys(users).map(u => ({
    username: u,
    rank: users[u].rank || '🌱 Tân thủ',
    exp: users[u].exp || 0
  })).sort((a,b) => b.exp - a.exp);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server đang chạy trên port ${PORT}`));
