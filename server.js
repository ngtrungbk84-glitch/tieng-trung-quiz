// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const GOOGLE_SHEET_URL = "https://script.google.com/macros/s/AKfycbxp24CLcxLbFX2UWzFIR9_6ZA3J80qWA__ScCytBpR7UK2g1DtTmlzIa7FXmku7PaYFTw/exec";
const QUESTIONS_FILE = path.join(__dirname, 'questions.json');

let usersData = {};

// 1. Đồng bộ dữ liệu với Google Sheets
async function loadUserDataFromSheet() {
  try {
    const res = await fetch(GOOGLE_SHEET_URL);
    const data = await res.json();
    usersData = data || {};
    console.log("✅ Đã tải dữ liệu từ Google Sheets thành công!");
  } catch (e) {
    console.error("❌ Lỗi khi tải dữ liệu từ Google Sheets:", e);
    usersData = {};
  }
}

async function saveUserData() {
  try {
    await fetch(GOOGLE_SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(usersData)
    });
    console.log("💾 Đã lưu dữ liệu lên Google Sheets thành công!");
  } catch (e) {
    console.error("❌ Lỗi khi lưu lên Google Sheets:", e);
  }
}

// Khởi tạo tải dữ liệu ngay khi khởi động Server
loadUserDataFromSheet();

// 2. Các hàm bổ trợ
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
    answered: false,
    isPractice: false,
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
      exp: usersData[name].exp || 0,
      wins: usersData[name].wins || 0,
      rank: getRank(usersData[name].exp || 0)
    }))
    .sort((a, b) => b.exp - a.exp)
    .slice(0, 10);
}

// 3. Logic Bot AI Luyện Tập
function scheduleBotAnswer(roomId) {
  let room = rooms[roomId];
  if (!room || !room.isPractice) return;

  let delay = Math.floor(Math.random() * 2000) + 1500; // Bot trả lời trong 1.5s - 3.5s

  room.botTimer = setTimeout(() => {
    if (!room || room.answered) return;

    room.answered = true;
    let botName = "🤖 Bot HSK";
    room.matchScores[botName] = (room.matchScores[botName] || 0) + 10;

    io.to(roomId).emit('roundResult', { winner: botName, matchScores: room.matchScores });

    setTimeout(() => {
      room.currentQ++;
      if (room.currentQ < room.questions.length) {
        room.answered = false;
        io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
        scheduleBotAnswer(roomId);
      } else {
        finishPracticeGame(roomId);
      }
    }, 3000);
  }, delay);
}

async function finishPracticeGame(roomId) {
  let room = rooms[roomId];
  if (!room) return;

  let humanPlayer = room.players.find(p => p.username !== "🤖 Bot HSK");
  let botName = "🤖 Bot HSK";
  let winnerName = null;

  if (humanPlayer) {
    let pScore = room.matchScores[humanPlayer.username] || 0;
    let bScore = room.matchScores[botName] || 0;

    if (pScore > bScore) {
      winnerName = humanPlayer.username;
      usersData[humanPlayer.username].exp = (usersData[humanPlayer.username].exp || 0) + 10;
      usersData[humanPlayer.username].wins = (usersData[humanPlayer.username].wins || 0) + 1;
    } else if (bScore > pScore) {
      winnerName = botName;
    }
    usersData[humanPlayer.username].exp = (usersData[humanPlayer.username].exp || 0) + 2;
    await saveUserData(); // Lưu dữ liệu lên Google Sheets
  }

  io.to(roomId).emit('gameOver', { winner: winnerName });
  io.emit('leaderboardUpdate', getLeaderboard());
  delete rooms[roomId];
}

// 4. Socket.IO Events
io.on('connection', (socket) => {
  socket.emit('roomListUpdate', getPublicRooms());
  socket.emit('leaderboardUpdate', getLeaderboard());

  // Luyện tập với Bot
  socket.on('joinPractice', ({ username, lesson }) => {
    if (!username) return;

    socket.username = username;
    let practiceRoomId = `Luyện Tập - ${socket.id.substring(0, 4)}`;
    socket.roomId = practiceRoomId;

    if (!usersData[username]) {
      usersData[username] = { exp: 0, wins: 0 };
      saveUserData();
    }

    rooms[practiceRoomId] = {
      id: practiceRoomId,
      lesson: lesson || 1,
      players: [socket, { username: "🤖 Bot HSK" }],
      currentQ: 0,
      matchScores: { [username]: 0, "🤖 Bot HSK": 0 },
      answered: false,
      isPractice: true,
      questions: getQuestionsByLesson(lesson || 1)
    };

    socket.join(practiceRoomId);

    socket.emit('gameStart', {
      roomId: practiceRoomId,
      lesson: lesson || 1,
      players: [
        { name: username, rank: getRank(usersData[username].exp || 0) },
        { name: "🤖 Bot HSK", rank: "🤖 AI Trí Tuệ" }
      ],
      question: rooms[practiceRoomId].questions[0]
    });

    scheduleBotAnswer(practiceRoomId);
  });

  socket.on('createNewRoom', (selectedLesson) => {
    if (Object.keys(rooms).length >= 10) {
      socket.emit('notice', 'Sảnh đã đạt giới hạn tối đa 10 bàn!');
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
      saveUserData();
    }

    let room = rooms[roomId];
    if (!room) return socket.emit('waiting', 'Bàn không tồn tại!');
    if (room.players.length >= 2) return socket.emit('waiting', `Bàn [${roomId}] đã đầy!`);

    socket.join(roomId);
    room.players.push(socket);
    room.matchScores[username] = 0;

    io.emit('roomListUpdate', getPublicRooms());

    if (room.players.length === 2) {
      room.currentQ = 0;
      room.answered = false;
      io.to(roomId).emit('gameStart', {
        roomId: roomId,
        lesson: room.lesson,
        players: room.players.map(p => ({
          name: p.username,
          rank: getRank(usersData[p.username]?.exp || 0)
        })),
        question: room.questions[room.currentQ]
      });
    } else {
      socket.emit('waitingState', { roomId: roomId, lesson: room.lesson });
    }
  });

  socket.on('leaveRoom', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
      if (rooms[roomId].botTimer) clearTimeout(rooms[roomId].botTimer);
      socket.leave(roomId);
      rooms[roomId].players = rooms[roomId].players.filter(p => p.id !== socket.id);
      socket.roomId = null;
      io.emit('roomListUpdate', getPublicRooms());
      socket.emit('leftRoomSuccess');
    }
  });

  socket.on('submitAnswer', (optionIndex) => {
    let roomId = socket.roomId;
    let room = rooms[roomId];
    if (!room || room.answered) return;

    let q = room.questions[room.currentQ];
    if (optionIndex === q.answer) {
      room.answered = true;
      if (room.botTimer) clearTimeout(room.botTimer);

      room.matchScores[socket.username] = (room.matchScores[socket.username] || 0) + 10;
      io.to(roomId).emit('roundResult', { winner: socket.username, matchScores: room.matchScores });

      setTimeout(async () => {
        room.currentQ++;
        if (room.currentQ < room.questions.length) {
          room.answered = false;
          io.to(roomId).emit('nextQuestion', room.questions[room.currentQ]);
          if (room.isPractice) scheduleBotAnswer(roomId);
        } else {
          if (room.isPractice) {
            await finishPracticeGame(roomId);
          } else {
            let pNames = room.players.map(p => p.username);
            let p1 = pNames[0], p2 = pNames[1];
            let winnerName = null;

            if (room.matchScores[p1] > room.matchScores[p2]) winnerName = p1;
            else if (room.matchScores[p2] > room.matchScores[p1]) winnerName = p2;

            if (winnerName) {
              usersData[winnerName].exp = (usersData[winnerName].exp || 0) + 20;
              usersData[winnerName].wins = (usersData[winnerName].wins || 0) + 1;
            }
            pNames.forEach(p => {
              if (p !== winnerName) usersData[p].exp = (usersData[p].exp || 0) + 5;
            });

            await saveUserData(); // Lưu dữ liệu lên Google Sheets

            io.to(roomId).emit('gameOver', { winner: winnerName });
            io.emit('leaderboardUpdate', getLeaderboard());

            createRoomObject(roomId, room.lesson);
            io.emit('roomListUpdate', getPublicRooms());
          }
        }
      }, 3000);
    } else {
      socket.emit('wrongAnswer', 'Sai rồi! Chọn lại nào.');
    }
  });

  socket.on('disconnect', () => {
    let roomId = socket.roomId;
    if (roomId && rooms[roomId]) {
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
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
