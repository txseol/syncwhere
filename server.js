require("dotenv").config();

const express = require("express");
const jwt = require("jsonwebtoken");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// 환경 변수
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI } = process.env;
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret-key";

// Google OAuth 로그인 API (nginx에서 /api → :3000 프록시)
app.post("/auth/google", async (req, res) => {
  const { code, platform } = req.body;

  try {
    // code → access token 교환
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();
    if (tokenData.error)
      return res.status(400).json({ error: tokenData.error });

    // 사용자 정보 요청
    const userRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      }
    );

    const user = await userRes.json();
    if (user.error) return res.status(400).json({ error: user.error });

    // JWT 발급 (구글ID, 이메일, 접속환경을 페이로드로)
    const token = jwt.sign(
      { userid: user.id, email: user.email, platform: platform || "unknown" },
      JWT_SECRET,
      { expiresIn: "24h" }
    );

    res.json({ token, user: { userid: user.id, email: user.email } });
  } catch (error) {
    console.error("OAuth Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// HTTP + WebSocket 서버
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

// WebSocket 연결 처리 (nginx에서 /ws → :3000/ws 프록시)
wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url?.split("?")[1] || "");
  const token = params.get("token");

  if (!token) return ws.close(1008, "No token");

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return ws.close(1008, "Invalid token");

    ws.user = user;
    console.log(`WS 연결: ${user.email} (${user.platform})`);

    // 메시지 수신 처리
    ws.on("message", (msg) => {
      try {
        const { event, data } = JSON.parse(msg);

        switch (event) {
          case "ping":
            ws.send(
              JSON.stringify({
                event: "pong",
                data: { time: Date.now(), message: "pong!" },
              })
            );
            break;

          // 추후 이벤트 추가
          default:
            break;
        }
      } catch (e) {
        console.error("Message Error:", e);
      }
    });

    ws.on("close", () => console.log(`WS 종료: ${user.email}`));
  });
});

server.listen(3000, () => console.log("서버 실행중 :3000"));
