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
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret-key";

// Google OAuth 로그인 API
app.post("/api/auth/google", async (req, res) => {
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

    // JWT 발급
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

// HTTP + WebSocket 서버 (nginx 뒤에서 동작, SSL termination은 nginx가 담당)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket 연결 처리 (nginx에서 wss → ws 프록시됨)
wss.on("connection", (ws, req) => {
  // URL 파라미터에서 token 추출 (안전한 방식)
  const urlParts = req.url?.split("?");
  const token = urlParts?.[1]
    ? new URLSearchParams(urlParts[1]).get("token")
    : null;

  if (!token) return ws.close(1008, "No token");

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return ws.close(1008, "Invalid token");

    ws.user = user;
    console.log(`WS 연결: ${user.email} (${user.platform})`);

    ws.on("message", (msg) => {
      try {
        const { event, data } = JSON.parse(msg);

        if (event === "ping") {
          ws.send(
            JSON.stringify({
              event: "pong",
              data: { time: Date.now(), message: "pong" },
            })
          );
        }
      } catch (e) {
        console.error("Message Error:", e);
      }
    });

    ws.on("close", () => console.log(`WS 종료: ${user.email}`));
  });
});

server.listen(3000, () => console.log("실행중"));
