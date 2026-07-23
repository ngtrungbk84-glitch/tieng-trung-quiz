// server.js
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

const USER_DATA_FILE = path.join(__dirname, 'users.json');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// Đọc dữ liệu User & Câu hỏi
let usersData = {};
if (fs.existsSync(USER_DATA_FILE)) {
  try { usersData = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8')); } catch (e) { usersData = {}; }
}

function saveUserData() {
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify(usersData, null, 2));
}

function getQuestions() {
  if (fs.existsSync(QUESTIONS_FILE)) {
    try { return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')); } catch (e) { return []; }
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

// KHỞI TẠO DỮ LIỆU BÀN CHƠI
let roomCounter = 5; // Khởi đầu với 5 bàn
let rooms = {};

// Tạo sẵn 5 bàn mặc định
for (let i = 1; i <= 5; i++) {
  createRoomObject(`Bàn ${i}`);
}

function createRoomObject(roomId) {
  rooms[roomId] = {
    id: roomId,
    players: [],
    currentQ: 0,
    matchScores: {},
    answered: false,
    questions: getQuestions()
  };
}

function getPublicRooms() {
  let list = [];
  for (let id in rooms) {
    list.push({
      id: id,
      playerCount: rooms[id].players.length,
      players: rooms[id].players.map(p => p.username)
    });
  }
  return list;
}

function getLeaderboard() {
  return Object.keys(usersData)
    .map(name => ({
      username: name,
      exp: usersData[name].exp,
      wins: usersData[name].wins,
      rank: getRank(usersData[name].exp)
    }))
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10);
}

io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getPublicRooms());
  socket.emit('leaderboardUpdate', getLeaderboard());

  // Nút Mở Bàn Mới (Giới hạn tối đa 10 bàn)
  socket.on('createNewRoom', () => {
    const currentRoomCount = Object.keys(rooms).length;
    if (currentRoomCount >= 10) {
      socket.emit('notice', 'Sảnh đã đạt giới hạn tối đa 10 bàn!');
      return;
    }

    roomCounter++;
    let newRoomId = `Bàn ${roomCounter}`;
    createRoomObject(newRoomId);
    io.emit('roomListUpdate', getPublicRooms());
  });

  // Tham gia Bàn chơi
  socket.on('joinRoom', ({ username, roomId }) => {
    if (!username) return;

    socket.username = username;
    socket.roomId = roomId;

    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserData();
    }

    let room = rooms[roomId];
    if (!room) {
      socket.emit('waiting', 'Bàn chơi không tồn tại!');
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('waiting', `Bàn [${roomId}] đã đầy! Vui lòng chọn bàn khác.`);
      return;
    }

    socket.join(roomId);
    room.players.push(socket);
    room.matchScores[username] = 0;

    io.emit('roomListUpdate', getPublicRooms());

    if (room.players.length === 2) {
      room.currentQ = 0;
      room.answered = false;
      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        players: room.players.map(p => ({
          name: p.username,
          rank: getRank(usersData[p.username].exp)
        })),
        question: room.questions[room.currentQ]
      });
    } else {
      socket.emit('waiting', `Đã vào [${roomId}]. Đang chờ đối thủ...`);
    }
  });

  // Trả lời câu hỏi
  socket.on('submitAnswer', (optionIndex) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room || room.answered) return;

    let q = room.questions[room.currentQ];
    if (optionIndex === q.answer) {
      room.answered = true;
      room.matchScores[socket.username] = (room.matchScores[socket.username] || 0) + 10;

      io.to(roomId).emit('roundResult', {
        winner: socket.username,
        matchScores: room.matchScores
      });

      setTimeout(() => {
        room.currentQ++;
        if (room.currentQ < room.questions.length) {
          room.answered = false;
          io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        } else {
          // Hết ván
          let pNames = room.players.map(p => p.username);
          let p1 = pNames[0], p2 = pNames[1];
          let winnerName = null;

          if (room.matchScores[p1] > room.matchScores[p2]) winnerName = p1;
          else if (room.matchScores[p2] > room.matchScores[p1]) winnerName = p2;

          if (winnerName) {
            usersData[winnerName].exp += 20;
            usersData[winnerName].wins += 1;
          }
          pNames.forEach(p => { if (p !== winnerName) usersData[p].exp += 5; });
          saveUserData();

          io.to(roomId).emit('gameOver', { winner: winnerName });

          // Reset bàn chơi
          createRoomObject(roomId);
          io.emit('roomListUpdate', getPublicRooms());
        }
      }, 3000);
    } else {
      socket.emit('wrongAnswer', 'Sai rồi! Chọn lại nào.');
    }
  });

  // Ngắt kết nối / Rời bàn
  socket.on('disconnect', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      io.to(roomId).emit('playerLeft', `${socket.username} đã rời bàn.`);
      createRoomObject(roomId);
      io.emit('roomListUpdate', getPublicRooms());
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
