// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Danh sách câu hỏi tiếng Trung (Anh có thể thêm/sửa tùy ý)
const QUESTIONS = [
  { id: 1, q: "Từ nào nghĩa là 'Cảm ơn'?", options: ["你好 (Nǐ hǎo)", "谢谢 (Xièxie)", "再见 (Zàijiàn)", "对不起 (Duìbuqǐ)"], answer: 1 },
  { id: 2, q: "Từ nào nghĩa là 'Tạm biệt'?", options: ["再见 (Zàijiàn)", "谢谢 (Xièxie)", "不客气 (Bú kèqi)", "好的 (Hǎo de)"], answer: 0 },
  { id: 3, q: "Pinyin của '苹果' (Quả táo) là gì?", options: ["Míngtiān", "Píngguǒ", "Shuǐguǒ", "Chéngzi"], answer: 1 },
  { id: 4, q: "Từ nào nghĩa là 'Nước'?", options: ["茶 (Chá)", "酒 (Jiǔ)", "水 (Shuǐ)", "奶 (Nǎi)"], answer: 2 },
];

let players = [];      // Danh sách người chơi đang chờ hoặc đang đấu
let currentQuestion = 0;
let scores = {};
let answeredInRound = false;

io.on('connection', (socket) => {
  console.log('Một người dùng kết nối:', socket.id);

  // Người dùng đăng ký Username
  socket.on('joinGame', (username) => {
    socket.username = username;
    players.push(socket);
    scores[username] = 0;

    console.log(`${username} đã tham gia.`);

    // Khi đủ 2 người chơi thì bắt đầu game
    if (players.length === 2) {
      currentQuestion = 0;
      io.emit('gameStart', {
        players: players.map(p => p.username),
        question: QUESTIONS[currentQuestion]
      });
    } else if (players.length === 1) {
      socket.emit('waiting', 'Đang chờ người chơi thứ 2 vào bàn...');
    } else {
      socket.emit('waiting', 'Phòng đã đầy (tối đa 2 người). Vui lòng đợi ván sau.');
    }
  });

  // Người chơi chọn đáp án
  socket.on('submitAnswer', (optionIndex) => {
    if (answeredInRound) return; // Nếu đã có người trả lời đúng/nhanh hơn trong câu này rồi thì bỏ qua

    const q = QUESTIONS[currentQuestion];
    if (optionIndex === q.answer) {
      answeredInRound = true;
      scores[socket.username] += 10;

      io.emit('roundResult', {
        winner: socket.username,
        scores: scores,
        correctAnswer: q.options[q.answer]
      });

      // Chuyển sang câu hỏi tiếp theo sau 3 giây
      setTimeout(() => {
        currentQuestion++;
        if (currentQuestion < QUESTIONS.length) {
          answeredInRound = false;
          io.emit('nextQuestion', QUESTIONS[currentQuestion]);
        } else {
          io.emit('gameOver', scores);
        }
      }, 3000);
    } else {
      // Chọn sai thì báo riêng cho người đó
      socket.emit('wrongAnswer', 'Sai rồi! Chọn lại đi.');
    }
  });

  // Xử lý ngắt kết nối
  socket.on('disconnect', () => {
    players = players.filter(p => p.id !== socket.id);
    if (socket.username) delete scores[socket.username];
    io.emit('playerLeft', `${socket.username || 'Người chơi'} đã thoát.`);
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy tại: http://localhost:${PORT}`);
});