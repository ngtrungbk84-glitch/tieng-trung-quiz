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

// File lưu điểm tích lũy & câu hỏi
const USER_DATA_FILE = path.join(__dirname, 'users.json');
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

// Đọc dữ liệu user
let usersData = {};
if (fs.existsSync(USER_DATA_FILE)) {
  try { usersData = JSON.parse(fs.readFileSync(USER_DATA_FILE, 'utf8')); } catch (e) { usersData = {}; }
}

function saveUserData() {
  fs.writeFileSync(USER_DATA_FILE, JSON.stringify(usersData, null, 2));
}

// Đọc danh sách câu hỏi từ file questions.json
function getQuestions() {
  if (fs.existsSync(QUESTIONS_FILE)) {
    try { return JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8')); } catch (e) { return []; }
  }
  return [];
}

// Tính Cấp độ / Rank dựa trên tổng điểm
function getRank(exp) {
  if (exp >= 500) return "🐉 HSK Master";
  if (exp >= 200) return "🥇 Cao thủ HSK";
  if (exp >= 100) return "🥈 Trung cấp";
  if (exp >= 30)  return "🥉 Sơ cấp";
  return "🌱 Tân thủ";
}

// Quản lý danh sách các phòng chơi
// Cấu trúc: rooms[roomId] = { players: [], currentQ: 0, scores: {}, answered: false, questions: [] }
let rooms = {};

io.on('connection', (socket) => {

  // Gửi bảng xếp hạng khi người dùng kết nối
  socket.emit('leaderboardUpdate', getLeaderboard());

  socket.on('joinRoom', ({ username, roomId }) => {
    roomId = roomId.trim().toUpperCase() || 'PHONG-1';
    socket.username = username;
    socket.roomId = roomId;

    // Khởi tạo user nếu chưa có trong DB
    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserData();
    }

    // Khởi tạo phòng nếu chưa có
    if (!rooms[roomId]) {
      rooms[roomId] = {
        players: [],
        currentQ: 0,
        matchScores: {},
        answered: false,
        questions: getQuestions()
      };
    }

    let room = rooms[roomId];

    // Kiểm tra số lượng người trong phòng
    if (room.players.length >= 2) {
      socket.emit('waiting', `Phòng ${roomId} đã đầy (tối đa 2 người). Vui lòng chọn phòng khác!`);
      return;
    }

    socket.join(roomId);
    room.players.push(socket);
    room.matchScores[username] = 0;

    console.log(`${username} vào phòng [${roomId}]`);

    if (room.players.length === 2) {
      room.currentQ = 0;
      room.answered = false;
      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        players: room.players.map(p => ({
          name: p.username,
          rank: getRank(usersData[p.username].exp),
          exp: usersData[p.username].exp
        })),
        question: room.questions[room.currentQ]
      });
    } else {
      socket.emit('waiting', `Đã vào phòng [${roomId}]. Đang chờ người chơi thứ 2...`);
    }
  });

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
        matchScores: room.matchScores,
        correctAnswer: q.options[q.answer]
      });

      setTimeout(() => {
        room.currentQ++;
        if (room.currentQ < room.questions.length) {
          room.answered = false;
          io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        } else {
          // Kết thúc trận -> Cộng điểm tích lũy thăng hạng
          let pNames = room.players.map(p => p.username);
          let p1 = pNames[0], p2 = pNames[1];
          let winnerName = null;

          if (room.matchScores[p1] > room.matchScores[p2]) winnerName = p1;
          else if (room.matchScores[p2] > room.matchScores[p1]) winnerName = p2;

          if (winnerName) {
            usersData[winnerName].exp += 20; // Thắng cộng 20 EXP
            usersData[winnerName].wins += 1;
          }
          // Thua hoặc hòa vẫn cộng nhẹ 5 EXP khuyến khích
          pNames.forEach(p => {
            if (p !== winnerName) usersData[p].exp += 5;
          });
          saveUserData();

          io.to(roomId).emit('gameOver', {
            matchScores: room.matchScores,
            winner: winnerName,
            leaderboard: getLeaderboard()
          });

          // Giải phóng phòng
          delete rooms[roomId];
        }
      }, 3000);
    } else {
      socket.emit('wrongAnswer', 'Sai rồi! Chọn đáp án khác xem!');
    }
  });

  socket.on('disconnect', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      io.to(roomId).emit('playerLeft', `${socket.username} đã rời phòng. Bàn chơi giải tán!`);
      delete rooms[roomId];
    }
  });
});

function getLeaderboard() {
  return Object.keys(usersData)
    .map(name => ({
      username: name,
      exp: usersData[name].exp,
      wins: usersData[name].wins,
      rank: getRank(usersData[name].exp)
    }))
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10); // Top 10
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
