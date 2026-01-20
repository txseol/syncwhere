require("dotenv").config();

const express = require("express");
const jwt = require("jsonwebtoken");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { createClient } = require("redis");
const { PrismaClient } = require("@prisma/client");

const app = express();
const prisma = new PrismaClient();

// Redis 클라이언트
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});
redis.on("error", (err) => console.error("Redis Error:", err));
redis.connect().then(() => console.log("Redis 연결됨"));
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// 환경 변수
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI } = process.env;
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret-key";

// Google OAuth 로그인 API (nginx에서 /api → :3000 프록시)
app.post("/auth/google", async (req, res) => {
  const { code, platform, redirect_uri } = req.body;

  // 클라이언트 IP 추출
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    null;
  const userAgent = req.headers["user-agent"] || null;

  // 클라이언트에서 보낸 redirect_uri 사용 (없으면 환경변수 사용)
  const finalRedirectUri = redirect_uri || REDIRECT_URI;

  try {
    // code → access token 교환
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: finalRedirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      console.error("Google 토큰 에러:", tokenData);
      return res.status(400).json({
        error: tokenData.error,
        error_description: tokenData.error_description,
      });
    }

    // 사용자 정보 요청
    const userRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      },
    );

    const googleUser = await userRes.json();
    if (googleUser.error)
      return res.status(400).json({ error: googleUser.error });

    // DB에 유저 정보 저장 (upsert)
    const userData = await prisma.userData.upsert({
      where: {
        provider_providerId: {
          provider: "google",
          providerId: googleUser.id,
        },
      },
      update: {
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
      },
      create: {
        provider: "google",
        providerId: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        picture: googleUser.picture,
      },
    });

    // 로그인 기록 저장
    await prisma.userLogin.create({
      data: {
        userId: userData.id,
        platform: platform || "unknown",
        ip,
        userAgent,
      },
    });

    // JWT 발급 (내부 UUID, 구글ID, 이메일, 접속환경을 페이로드로)
    const token = jwt.sign(
      {
        id: userData.id,
        userid: googleUser.id,
        email: googleUser.email,
        platform: platform || "unknown",
      },
      JWT_SECRET,
      { expiresIn: "24h" },
    );

    res.json({
      token,
      user: { id: userData.id, userid: googleUser.id, email: googleUser.email },
    });
  } catch (error) {
    console.error("OAuth Error:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// HTTP + WebSocket 서버
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

// WebSocket 연결 처리 (nginx에서 /ws → :3000/ws 프록시)
// 작업중 - 최초 접속시 토큰 검증
wss.on("connection", (ws, req) => {
  const params = new URLSearchParams(req.url?.split("?")[1] || "");
  const token = params.get("token");

  if (!token) return ws.close(1008, "No token");

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return ws.close(1008, "Invalid token");

    ws.user = user;
    console.log(`WS 연결: ${user.email} (${user.platform})`);

    // 메시지 수신 처리
    ws.on("message", async (msg) => {
      try {
        const { event, data } = JSON.parse(msg);

        switch (event) {
          case "ping":
            ws.send(
              JSON.stringify({
                event: "pong",
                data: { time: Date.now(), message: "pong!" },
              }),
            );
            break;

          // 채널 생성, 가입, 목록조회, 탈퇴
          case "createChannel":
            await handleCreateChannel(ws, data);
            break;

          case "joinChannel":
            await handleJoinChannel(ws, data);
            break;

          case "listChannel":
            await handleListChannel(ws, data);
            break;

          case "quitChannel":
            await handleQuitChannel(ws, data);
            break;

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

// === 채널 핸들러 ===

// 채널 생성
async function handleCreateChannel(ws, data) {
  const { time, userid, channelName } = data;

  if (!channelName) {
    return ws.send(
      JSON.stringify({
        event: "systemmessage",
        data: { time: Date.now(), message: "채널명을 입력해주세요." },
      }),
    );
  }

  const channelKey = `channel:${channelName}`;

  // 채널 존재 여부 확인
  const exists = await redis.exists(channelKey);
  if (exists) {
    return ws.send(
      JSON.stringify({
        event: "systemmessage",
        data: { time: Date.now(), message: "이미 존재하는 채널입니다." },
      }),
    );
  }

  // 채널 생성 (Hash 구조)
  await redis.hSet(channelKey, {
    channel: channelName,
    created: userid,
    createdAt: Date.now().toString(),
  });
  // users는 Set으로 관리
  await redis.sAdd(`${channelKey}:users`, userid);

  ws.send(
    JSON.stringify({
      event: "channelCreated",
      data: {
        time: Date.now(),
        channel: channelName,
        message: `채널 '${channelName}'이 생성되었습니다.`,
      },
    }),
  );

  console.log(`채널 생성: ${channelName} by ${userid}`);
}

// 채널 참여
async function handleJoinChannel(ws, data) {
  const { time, userid, channelName } = data;

  if (!channelName) {
    return ws.send(
      JSON.stringify({
        event: "systemmessage",
        data: { time: Date.now(), message: "채널명을 입력해주세요." },
      }),
    );
  }

  const channelKey = `channel:${channelName}`;

  // 채널 존재 여부 확인
  const exists = await redis.exists(channelKey);
  if (!exists) {
    return ws.send(
      JSON.stringify({
        event: "systemmessage",
        data: { time: Date.now(), message: "채널이 존재하지 않습니다." },
      }),
    );
  }

  // 사용자를 채널에 추가
  await redis.sAdd(`${channelKey}:users`, userid);

  // 채널 정보 조회
  const users = await redis.sMembers(`${channelKey}:users`);

  ws.send(
    JSON.stringify({
      event: "channelJoined",
      data: {
        time: Date.now(),
        channel: channelName,
        users,
        message: `채널 '${channelName}'에 참여했습니다.`,
      },
    }),
  );

  console.log(`채널 참여: ${channelName} - ${userid}`);
}

// 채널 목록 조회
async function handleListChannel(ws, data) {
  const { time, userid } = data;

  // channel:* 패턴의 모든 키 조회 (users 키 제외)
  const keys = await redis.keys("channel:*");
  const channelKeys = keys.filter((key) => !key.endsWith(":users"));

  const channels = [];
  for (const key of channelKeys) {
    const channelName = key.replace("channel:", "");
    const users = await redis.sMembers(`${key}:users`);
    channels.push({ channelname: channelName, users });
  }

  ws.send(
    JSON.stringify({
      event: "channelList",
      data: { time: Date.now(), channels },
    }),
  );

  console.log(`채널 목록 조회: ${userid}`);
}

// 채널 탈퇴
async function handleQuitChannel(ws, data) {
  const { time, userid, channel } = data;

  if (!channel) {
    return ws.send(
      JSON.stringify({
        event: "systemmessage",
        data: { time: Date.now(), message: "채널명을 입력해주세요." },
      }),
    );
  }

  const channelKey = `channel:${channel}`;

  // 채널 존재 여부 확인
  const exists = await redis.exists(channelKey);
  if (!exists) {
    return ws.send(
      JSON.stringify({
        event: "systemmessage",
        data: { time: Date.now(), message: "채널이 존재하지 않습니다." },
      }),
    );
  }

  // 유저를 채널에서 제거
  await redis.sRem(`${channelKey}:users`, userid);

  // 남은 유저 수 확인
  const remainingUsers = await redis.sCard(`${channelKey}:users`);

  if (remainingUsers === 0) {
    // 채널에 유저가 없으면 채널 삭제
    await redis.del(channelKey);
    await redis.del(`${channelKey}:users`);
    console.log(`채널 삭제: ${channel} (유저 없음)`);
  }

  ws.send(
    JSON.stringify({
      event: "channelQuitted",
      data: {
        time: Date.now(),
        channel,
        message: `채널 '${channel}'에서 탈퇴했습니다.`,
      },
    }),
  );

  console.log(`채널 탈퇴: ${channel} - ${userid}`);
}

server.listen(3000, () => console.log("서버 실행중 :3000"));
