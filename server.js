const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

// Quản lý dữ liệu người dùng & câu hỏi
const DB_FILE = path.join(__dirname, 'users.json');
let usersDB = {};
if (fs.existsSync(DB_FILE)) {
  try { usersDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { usersDB = {}; }
}

function saveUsersDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(usersDB, null, 2), 'utf8');
}

let questionsData = {};
const Q_FILE = path.join(__dirname, 'questions.json');
if (fs.existsSync(Q_FILE)) {
  try { questionsData = JSON.parse(fs.readFileSync(Q_FILE, 'utf8')); } catch (e) { questionsData = {}; }
}

// Danh sách bàn chơi
let rooms = {};

// Helper làm sạch chuỗi so sánh
function cleanStr(str) {
  if (!str) return "";
  return str.toString().trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,?!]/g, '');
}

function getRankTitle(exp) {
  if (exp >= 1000) return "🏆 Huyền Thoại";
  if (exp >= 500) return "💎 Cao Thủ";
  if (exp >= 200) return "🥇 Tinh Anh";
  if (exp >= 50) return "🥈 Tập Sự";
  return "🌱 Tân Thủ";
}

function getLeaderboard() {
  return Object.keys(usersDB).map(u => ({
    username: u,
    exp: usersDB[u].exp || 0,
    wins: usersDB[u].wins || 0,
    rank: getRankTitle(usersDB[u].exp || 0)
  })).sort((a, b) => b.exp - a.exp).slice(0, 10);
}

function broadcastRoomList() {
  const roomList = Object.keys(rooms).map(id => {
    const r = rooms[id];
    return {
      id: id,
      lesson: r.lesson,
      playerCount: r.players.length,
      players: r.players.map(p => p.name),
      isPlaying: r.isPlaying
    };
  });
  io.emit('roomListUpdate', roomList);
}

io.on('connection', (socket) => {
  let currentUser = null;
  let currentRoomId = null;

  socket.emit('leaderboardUpdate', getLeaderboard());
  broadcastRoomList();

  // 1. Đăng ký / Đăng nhập
  socket.on('register', ({ username, password }) => {
    if (!username || !password) return socket.emit('authResult', { success: false, msg: 'Thiếu thông tin!' });
    if (usersDB[username]) return socket.emit('authResult', { success: false, msg: 'Tài khoản đã tồn tại!' });

    usersDB[username] = { password, exp: 0, wins: 0 };
    saveUsersDB();
    currentUser = username;
    socket.emit('authResult', {
      success: true,
      username,
      exp: 0,
      wins: 0,
      rank: getRankTitle(0)
    });
    io.emit('leaderboardUpdate', getLeaderboard());
  });

  socket.on('login', ({ username, password }) => {
    if (!usersDB[username] || usersDB[username].password !== password) {
      return socket.emit('authResult', { success: false, msg: 'Tài khoản hoặc mật khẩu không đúng!' });
    }
    currentUser = username;
    socket.emit('authResult', {
      success: true,
      username,
      exp: usersDB[username].exp || 0,
      wins: usersDB[username].wins || 0,
      rank: getRankTitle(usersDB[username].exp || 0)
    });
  });

  // 2. Tạo phòng & Chọn bài
  socket.on('createNewRoom', (lesson) => {
    if (!currentUser) return;
    const roomId = 'Room_' + Math.floor(1000 + Math.random() * 9000);
    rooms[roomId] = {
      id: roomId,
      lesson: lesson || 10,
      players: [{ id: socket.id, name: currentUser, rank: getRankTitle(usersDB[currentUser]?.exp || 0) }],
      spectators: [],
      scores: {},
      timers: {},
      currentQIdx: 0,
      isPlaying: false,
      turnTimer: null
    };
    currentRoomId = roomId;
    socket.join(roomId);
    socket.emit('waitingState', { roomId, lesson: rooms[roomId].lesson });
    broadcastRoomList();
  });

  socket.on('changeRoomLesson', ({ roomId, lesson }) => {
    if (rooms[roomId] && !rooms[roomId].isPlaying) {
      rooms[roomId].lesson = lesson;
      io.to(roomId).emit('lessonUpdated', lesson);
      broadcastRoomList();
    }
  });

  // 3. Vào phòng (Thường hoặc Chế độ Bot)
  socket.on('joinRoom', ({ username, roomId }) => {
    const room = rooms[roomId];
    if (!room) return socket.emit('notice', 'Phòng không tồn tại!');
    
    currentRoomId = roomId;
    socket.join(roomId);

    if (room.players.length < 2 && !room.isPlaying) {
      room.players.push({ id: socket.id, name: username, rank: getRankTitle(usersDB[username]?.exp || 0) });
      broadcastRoomList();
      if (room.players.length === 2) {
        startGame(roomId);
      }
    } else {
      room.spectators.push({ id: socket.id, name: username });
      socket.emit('gameStart', {
        roomId,
        players: room.players,
        question: questionsData[room.lesson]?.[room.currentQIdx] || null,
        isSpectator: true
      });
      socket.emit('turnChanged', { activePlayer: room.players[room.turnIdx]?.name, playerTimers: room.timers });
    }
  });

  socket.on('joinPractice', ({ username, lesson, botLevel }) => {
    const roomId = 'Practice_' + Math.floor(1000 + Math.random() * 9000);
    const botName = `🤖 Bot ${botLevel.toUpperCase()}`;
    
    rooms[roomId] = {
      id: roomId,
      lesson: lesson || 10,
      players: [
        { id: socket.id, name: username, rank: getRankTitle(usersDB[username]?.exp || 0) },
        { id: 'bot_id', name: botName, rank: '🤖 AI Bot' }
      ],
      spectators: [],
      scores: {},
      timers: {},
      currentQIdx: 0,
      isPlaying: true,
      isBot: true,
      botLevel: botLevel
    };

    currentRoomId = roomId;
    socket.join(roomId);
    startGame(roomId);
  });

  // 4. Bắt đầu Game & Vòng chơi
  function startGame(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.isPlaying = true;
    room.currentQIdx = 0;
    room.turnIdx = 0;
    
    const p1 = room.players[0].name;
    const p2 = room.players[1].name;
    
    room.scores[p1] = 0;
    room.scores[p2] = 0;
    room.timers[p1] = 60;
    room.timers[p2] = 60;

    const qList = questionsData[room.lesson] || [];
    const firstQ = qList[0];

    io.to(roomId).emit('gameStart', {
      roomId,
      players: room.players,
      question: firstQ,
      isBot: room.isBot
    });

    startTurnCountdown(roomId);
  }

  function startTurnCountdown(roomId) {
    const room = rooms[roomId];
    if (!room || !room.isPlaying || room.isBot) return;

    if (room.turnTimer) clearInterval(room.turnTimer);

    const activePlayer = room.players[room.turnIdx].name;
    io.to(roomId).emit('turnChanged', { activePlayer, playerTimers: room.timers });

    room.turnTimer = setInterval(() => {
      if (!rooms[roomId]) return clearInterval(room.turnTimer);
      
      room.timers[activePlayer]--;
      io.to(roomId).emit('timerUpdate', { playerTimers: room.timers });

      if (room.timers[activePlayer] <= 0) {
        clearInterval(room.turnTimer);
        const winner = room.players[1 - room.turnIdx].name;
        endGame(roomId, winner, 'timeout', activePlayer);
      }
    }, 1000);
  }

  // 5. Xử lý Trả lời câu hỏi
  socket.on('submitAnswer', (userVal) => {
    const room = rooms[currentRoomId];
    if (!room || !room.isPlaying) return;

    const activePlayer = room.players[room.turnIdx].name;
    if (!room.isBot && currentUser !== activePlayer) return;

    const qList = questionsData[room.lesson] || [];
    const q = qList[room.currentQIdx];
    if (!q) return;

    let isCorrect = false;

    // Kiểm tra câu hỏi dạng Reading / Choice / Arrange
    if (q.type === 'reading' || q.type === 'choice') {
      isCorrect = parseInt(userVal) === Number(q.answer);
    } else if (q.type === 'arrange' || typeof q.answer === 'string') {
      isCorrect = cleanStr(userVal) === cleanStr(q.answer);
    } else {
      isCorrect = parseInt(userVal) === Number(q.answer);
    }

    if (isCorrect) {
      if (room.turnTimer) clearInterval(room.turnTimer);
      
      room.scores[currentUser] = (room.scores[currentUser] || 0) + 10;
      io.to(currentRoomId).emit('roundResult', {
        winner: currentUser,
        correctIndex: q.answer,
        matchScores: room.scores
      });

      nextQuestionOrFinish(currentRoomId);
    } else {
      socket.emit('wrongAnswer', { msg: '❌ Chưa chính xác, lượt chơi chuyển cho đối thủ!', index: userVal });
      
      // Chuyển lượt khi trả lời sai
      if (!room.isBot) {
        room.turnIdx = 1 - room.turnIdx;
        startTurnCountdown(currentRoomId);
      } else {
        // Tự động cho Bot trả lời trong chế độ Luyện Tập
        handleBotTurn(currentRoomId);
      }
    }
  });

  // ⚡ XỬ LÝ NÚT SKIP (BỎ QUA CÂU HỎI)
  socket.on('skipQuestion', () => {
    const room = rooms[currentRoomId];
    if (!room || !room.isPlaying) return;

    const activePlayer = room.players[room.turnIdx].name;
    if (!room.isBot && currentUser !== activePlayer) return;

    if (room.turnTimer) clearInterval(room.turnTimer);

    // Trừ 20 điểm khi bỏ qua
    room.scores[currentUser] = Math.max(0, (room.scores[currentUser] || 0) - 20);

    io.to(currentRoomId).emit('roundResult', {
      isSkip: true,
      player: currentUser,
      matchScores: room.scores
    });

    nextQuestionOrFinish(currentRoomId);
  });

  function handleBotTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    const delay = room.botLevel === 'easy' ? 3000 : room.botLevel === 'medium' ? 2000 : 1000;
    const botName = room.players[1].name;

    setTimeout(() => {
      if (!rooms[roomId]) return;
      const qList = questionsData[room.lesson] || [];
      const q = qList[room.currentQIdx];
      if (!q) return;

      const isBotCorrect = Math.random() < (room.botLevel === 'easy' ? 0.4 : room.botLevel === 'medium' ? 0.7 : 0.9);

      if (isBotCorrect) {
        room.scores[botName] = (room.scores[botName] || 0) + 10;
        io.to(roomId).emit('roundResult', {
          winner: botName,
          correctIndex: q.answer,
          matchScores: room.scores
        });
        nextQuestionOrFinish(roomId);
      } else {
        io.to(roomId).emit('turnChanged', { activePlayer: room.players[0].name, playerTimers: room.timers });
      }
    }, delay);
  }

  function nextQuestionOrFinish(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.currentQIdx++;
    const qList = questionsData[room.lesson] || [];

    if (room.currentQIdx < qList.length) {
      setTimeout(() => {
        if (!rooms[roomId]) return;
        io.to(roomId).emit('nextQuestion', qList[room.currentQIdx]);
        if (!room.isBot) startTurnCountdown(roomId);
      }, 1500);
    } else {
      // Kết thúc bộ câu hỏi -> Phân định thắng thua
      const p1 = room.players[0].name;
      const p2 = room.players[1].name;
      const s1 = room.scores[p1] || 0;
      const s2 = room.scores[p2] || 0;

      let winner = null;
      if (s1 > s2) winner = p1;
      else if (s2 > s1) winner = p2;

      endGame(roomId, winner, 'completed');
    }
  }

  function endGame(roomId, winner, reason, loser) {
    const room = rooms[roomId];
    if (!room) return;

    if (room.turnTimer) clearInterval(room.turnTimer);

    if (winner && usersDB[winner]) {
      usersDB[winner].exp = (usersDB[winner].exp || 0) + 30;
      usersDB[winner].wins = (usersDB[winner].wins || 0) + 1;
      saveUsersDB();
    }

    io.to(roomId).emit('gameOver', { winner, reason, loser, finalScores: room.scores });
    io.emit('leaderboardUpdate', getLeaderboard());

    delete rooms[roomId];
    broadcastRoomList();
  }

  // 6. Xử lý Rời phòng / Bỏ cuộc / Chat
  socket.on('playerForfeit', () => {
    const room = rooms[currentRoomId];
    if (!room || !room.isPlaying) return;

    const winner = room.players.find(p => p.name !== currentUser)?.name;
    endGame(currentRoomId, winner, 'forfeit', currentUser);
  });

  socket.on('sendChatMessage', (text) => {
    if (!currentRoomId || !currentUser) return;
    const room = rooms[currentRoomId];
    const isSpec = room?.spectators.some(s => s.name === currentUser);
    io.to(currentRoomId).emit('newChatMessage', { sender: currentUser, text, isSpectator: isSpec });
  });

  socket.on('leaveRoom', () => {
    if (currentRoomId && rooms[currentRoomId]) {
      const room = rooms[currentRoomId];
      if (room.isPlaying) {
        const winner = room.players.find(p => p.name !== currentUser)?.name;
        endGame(currentRoomId, winner, 'forfeit', currentUser);
      } else {
        room.players = room.players.filter(p => p.name !== currentUser);
        room.spectators = room.spectators.filter(s => s.name !== currentUser);
        if (room.players.length === 0) delete rooms[currentRoomId];
        broadcastRoomList();
      }
    }
    socket.leave(currentRoomId);
    currentRoomId = null;
    socket.emit('leftRoomSuccess');
  });

  socket.on('disconnect', () => {
    if (currentRoomId && rooms[currentRoomId]) {
      const room = rooms[currentRoomId];
      if (room.isPlaying) {
        const winner = room.players.find(p => p.name !== currentUser)?.name;
        endGame(currentRoomId, winner, 'forfeit', currentUser);
      } else {
        room.players = room.players.filter(p => p.name !== currentUser);
        if (room.players.length === 0) delete rooms[currentRoomId];
        broadcastRoomList();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server đang chạy tại port ${PORT}`));
