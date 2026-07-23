// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Danh sách câu hỏi tiếng Trung (Anh có thể thêm/sửa tùy ý)
const QUESTIONS = [
  { id: 1, q: "Từ nào nghĩa là 'Cảm ơn'?", options: ["你好 (Nǐ hǎo)", "谢谢 (Xièxie)", "再见 (Zàijiàn)", "对不起 (Duìbuqǐ)"], answer: 1 },
  { id: 2, q: "Từ nào nghĩa là 'Tạm biệt'?", options: ["再见 (Zàijiàn)", "谢谢 (Xièxie)", "不客气 (Bú kèqi)", "好的 (Hǎo de)"], answer: 0 },
  { id: 3, q: "Pinyin của '苹果' (Quả táo) là gì?", options: ["Míngtiān", "Píngguǒ", "Shuǐguǒ", "Chéngzi"], answer: 1 },
  { id: 4, q: "Từ nào nghĩa là 'Nước'?", options: ["茶 (Chá)", "酒 (Jiǔ)", "水 (Shuǐ)", "奶 (Nǎi)"], answer: 2 },
];

let players = [];      // Danh sách socket người chơi
let currentQuestion = 0;
let scores = {};
let answeredInRound = false;

// Hàm reset bàn chơi về trạng thái ban đầu
function resetGame() {
  players = [];
  scores = {};
  currentQuestion = 0;
  answeredInRound = false;
  console.log('--- BÀN CHƠI ĐÃ ĐƯỢC RESET VỀ TRẠNG THÁI MỚI ---');
}

io.on('connection', (socket) => {
  console.log('Một kết nối mới:', socket.id);

  // Người dùng đăng ký Username
  socket.on('joinGame', (username) => {
    // Nếu phòng đã đủ 2 người, không cho vào nữa
    if (players.length >= 2) {
      socket.emit('waiting', 'Phòng đang đầy (đang có trận đấu). Vui lòng đợi vài giây rồi bấm thử lại!');
      return;
    }

    socket.username = username;
    players.push(socket);
    scores[username] = 0;

    console.log(`${username} đã tham gia bàn.`);

    // Khi đủ 2 người chơi -> Bắt đầu game
    if (players.length === 2) {
      currentQuestion = 0;
      answeredInRound = false;
      io.emit('gameStart', {
        players: players.map(p => p.username),
        question: QUESTIONS[currentQuestion]
      });
    } else {
      socket.emit('waiting', 'Đang chờ người chơi thứ 2 vào bàn...');
    }
  });

  // Người chơi chọn đáp án
  socket.on('submitAnswer', (optionIndex) => {
    if (answeredInRound) return; // Nếu đã có người trả lời nhanh hơn trong câu này rồi thì bỏ qua

    const q = QUESTIONS[currentQuestion];
    if (optionIndex === q.answer) {
      answeredInRound = true;
      scores[socket.username] = (scores[socket.username] || 0) + 10;

      io.emit('roundResult', {
        winner: socket.username,
        scores: scores,
        correctAnswer: q.options[q.answer]
      });

      // Chuyển sang câu tiếp theo sau 3 giây
      setTimeout(() => {
        currentQuestion++;
        if (currentQuestion < QUESTIONS.length) {
          answeredInRound = false;
          io.emit('nextQuestion', QUESTIONS[currentQuestion]);
        } else {
          // Hết câu hỏi -> Thông báo kết thúc và TỰ ĐỘNG RESET BÀN
          io.emit('gameOver', scores);
          resetGame();
        }
      }, 3000);
    } else {
      socket.emit('wrongAnswer', 'Sai rồi! Chọn lại đi.');
    }
  });

  // Khi có người thoát/srefresh/ngắt kết nối
  socket.on('disconnect', () => {
    if (socket.username) {
      console.log(`${socket.username} đã thoát.`);
      // Nếu trận đấu đang diễn ra mà có người thoát -> Reset bàn luôn để người khác vào chơi lại
      if (players.some(p => p.id === socket.id)) {
        io.emit('playerLeft', `${socket.username} đã rời bàn. Bàn chơi sẽ được làm mới!`);
        resetGame();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server đang chạy trên port: ${PORT}`);
});
