require("dotenv").config();

const express = require("express");
const jwt = require("jsonwebtoken");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const { createClient } = require("redis");
const { PrismaClient } = require("@prisma/client");

const app = express();

// === 유틸리티 함수 ===

// 에러 로깅 (간결하게)
function logError(context, error) {
  const message = error?.message || String(error);
  const code = error?.code || "UNKNOWN";
  console.error(`[${context}] ${code}: ${message}`);
}

// 안전한 WebSocket 전송
function safeSend(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  } catch (error) {
    logError("WS_SEND", error);
    return false;
  }
}

// 시스템 메시지 전송 헬퍼
function sendSystemMessage(ws, message) {
  return safeSend(ws, {
    event: "systemmessage",
    data: { time: Date.now(), message },
  });
}

// 에러 응답 전송 헬퍼
function sendErrorResponse(ws, event, message) {
  return safeSend(ws, {
    event: "error",
    data: { time: Date.now(), originalEvent: event, message },
  });
}

// === Prisma 초기화 ===
const prisma = new PrismaClient({
  log: [
    { level: "error", emit: "stdout" },
    { level: "warn", emit: "stdout" },
  ],
});

// Prisma 연결 확인
async function initPrisma() {
  try {
    await prisma.$connect();
    console.log("Prisma(Supabase) 연결됨");
    return true;
  } catch (error) {
    logError("PRISMA_INIT", error);
    console.error("Supabase 연결 실패 - 서버 종료");
    process.exit(1);
  }
}

// === Redis 초기화 ===
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
});

redis.on("error", (err) => logError("REDIS", err));
redis.on("reconnecting", () => console.log("Redis 재연결 시도중..."));

async function initRedis() {
  try {
    await redis.connect();
    console.log("Redis 연결됨");

    // 서버 시작시 채널 관련 캐시 초기화
    try {
      const channelKeys = await redis.keys("channel:*");
      if (channelKeys.length > 0) {
        await redis.del(channelKeys);
        console.log(`Redis 초기화: ${channelKeys.length}개 채널 캐시 삭제됨`);
      }
    } catch (cacheError) {
      logError("REDIS_CACHE_CLEAR", cacheError);
      // 캐시 초기화 실패는 치명적이지 않으므로 계속 진행
    }
    return true;
  } catch (error) {
    logError("REDIS_INIT", error);
    console.error("Redis 연결 실패 - 서버 종료");
    process.exit(1);
  }
}

// Redis 안전 실행 래퍼
async function safeRedis(operation, fallback = null) {
  try {
    if (!redis.isOpen) {
      console.warn("Redis 연결 끊김 - 작업 스킵");
      return fallback;
    }
    return await operation();
  } catch (error) {
    logError("REDIS_OP", error);
    return fallback;
  }
}

// === 서버 초기화 ===
async function initServer() {
  await initPrisma();
  await initRedis();
}
initServer();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// 환경 변수
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI } = process.env;
const JWT_SECRET = process.env.JWT_SECRET || "your-jwt-secret-key";

// Google OAuth 로그인 API (nginx에서 /api → :3000 프록시)
app.post("/auth/google", async (req, res) => {
  const { code, platform, redirect_uri } = req.body;

  if (!code) {
    return res.status(400).json({ error: "Authorization code is required" });
  }

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
    let tokenRes;
    try {
      tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
    } catch (fetchError) {
      logError("GOOGLE_TOKEN_FETCH", fetchError);
      return res.status(502).json({ error: "Google 서버 연결 실패" });
    }

    const tokenData = await tokenRes.json();

    if (tokenData.error) {
      logError("GOOGLE_TOKEN", {
        message: tokenData.error_description,
        code: tokenData.error,
      });
      return res.status(400).json({
        error: tokenData.error,
        error_description: tokenData.error_description,
      });
    }

    // 사용자 정보 요청
    let userRes;
    try {
      userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
    } catch (fetchError) {
      logError("GOOGLE_USERINFO_FETCH", fetchError);
      return res.status(502).json({ error: "Google 사용자 정보 조회 실패" });
    }

    const googleUser = await userRes.json();
    if (googleUser.error) {
      logError("GOOGLE_USERINFO", { message: googleUser.error });
      return res.status(400).json({ error: googleUser.error });
    }

    // DB에 유저 정보 저장 (upsert)
    let userData;
    try {
      userData = await prisma.userData.upsert({
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
    } catch (dbError) {
      logError("DB_USER_UPSERT", dbError);
      return res.status(500).json({ error: "사용자 정보 저장 실패" });
    }

    // 로그인 기록 저장 (실패해도 진행)
    try {
      await prisma.userLogin.create({
        data: {
          userId: userData.id,
          platform: platform || "unknown",
          ip,
          userAgent,
        },
      });
    } catch (loginLogError) {
      logError("DB_LOGIN_LOG", loginLogError);
      // 로그인 기록 실패는 치명적이지 않으므로 계속 진행
    }

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
    logError("OAUTH", error);
    res.status(500).json({ error: "인증 처리 중 오류가 발생했습니다" });
  }
});

// HTTP + WebSocket 서버
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

// WebSocket 연결 처리 (nginx에서 /ws → :3000/ws 프록시)
// 작업중 - 최초 접속시 토큰 검증
wss.on("connection", (ws, req) => {
  try {
    const params = new URLSearchParams(req.url?.split("?")[1] || "");
    const token = params.get("token");

    if (!token) {
      ws.close(1008, "No token");
      return;
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
      if (err) {
        logError("JWT_VERIFY", err);
        ws.close(1008, "Invalid token");
        return;
      }

      ws.user = user;
      console.log(`WS 연결: ${user.email} (${user.platform})`);

      // 메시지 수신 처리
      ws.on("message", async (msg) => {
        let event = "unknown";
        try {
          let parsed;
          try {
            parsed = JSON.parse(msg);
          } catch (parseError) {
            logError("JSON_PARSE", parseError);
            sendErrorResponse(ws, "unknown", "잘못된 메시지 형식입니다");
            return;
          }

          event = parsed.event;
          const data = parsed.data || {};

          if (!event) {
            sendErrorResponse(ws, "unknown", "이벤트명이 필요합니다");
            return;
          }

          switch (event) {
            case "ping":
              safeSend(ws, {
                event: "pong",
                data: { time: Date.now(), message: "pong!" },
              });
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
              sendErrorResponse(ws, event, `알 수 없는 이벤트: ${event}`);
              break;
          }
        } catch (e) {
          logError(`WS_MESSAGE(${event})`, e);
          sendErrorResponse(ws, event, "요청 처리 중 오류가 발생했습니다");
        }
      });

      ws.on("close", (code, reason) => {
        console.log(`WS 종료: ${user.email} (code: ${code})`);
      });

      ws.on("error", (error) => {
        logError(`WS_ERROR(${user.email})`, error);
      });
    });
  } catch (error) {
    logError("WS_CONNECTION", error);
    try {
      ws.close(1011, "Server error");
    } catch (closeError) {
      // 이미 닫혔을 수 있음
    }
  }
});

// === 채널 핸들러 (Redis 캐시 + Supabase 영속 저장) ===

// 채널 생성
async function handleCreateChannel(ws, data) {
  const { channelName } = data;
  const userId = ws.user.id; // JWT에서 검증된 유저 ID 사용

  if (!channelName || typeof channelName !== "string") {
    return sendSystemMessage(ws, "채널명을 입력해주세요.");
  }

  if (channelName.length > 50) {
    return sendSystemMessage(ws, "채널명은 50자 이하로 입력해주세요.");
  }

  try {
    // Supabase에서 채널 존재 여부 확인
    let existingChannel;
    try {
      existingChannel = await prisma.channelData.findUnique({
        where: { name: channelName },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (existingChannel) {
      return sendSystemMessage(ws, "이미 존재하는 채널입니다.");
    }

    // Supabase에 채널 생성 (트랜잭션으로 채널 + 멤버 동시 생성)
    let channel;
    try {
      channel = await prisma.$transaction(async (tx) => {
        const newChannel = await tx.channelData.create({
          data: {
            name: channelName,
            createdBy: userId,
          },
        });

        // 생성자를 멤버로 추가 (permission: 0 = 오너)
        await tx.channelMember.create({
          data: {
            channelId: newChannel.id,
            userId: userId,
            permission: 0,
            status: 0,
            joinOrder: 1,
          },
        });

        return newChannel;
      });
    } catch (txError) {
      logError("DB_CHANNEL_CREATE_TX", txError);
      return sendSystemMessage(
        ws,
        "채널 생성 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    // Redis 캐시에도 저장 (실패해도 진행)
    await safeRedis(async () => {
      const channelKey = `channel:${channel.id}`;
      await redis.hSet(channelKey, {
        id: channel.id,
        name: channelName,
        createdBy: userId,
        createdAt: channel.createdAt.toISOString(),
      });
      await redis.hSet(`${channelKey}:member:${userId}`, {
        channelId: channel.id,
        permission: "0",
        status: "0",
        joinOrder: "1",
      });
    });

    safeSend(ws, {
      event: "channelCreated",
      data: {
        time: Date.now(),
        channelId: channel.id,
        channel: channelName,
        message: `채널 '${channelName}'이 생성되었습니다.`,
      },
    });

    console.log(`채널 생성: ${channelName} (${channel.id}) by ${userId}`);
  } catch (error) {
    logError("CHANNEL_CREATE", error);
    sendSystemMessage(ws, "채널 생성 중 오류가 발생했습니다.");
  }
}

// 채널 참여
async function handleJoinChannel(ws, data) {
  const { channelName } = data;
  const userId = ws.user.id;

  if (!channelName || typeof channelName !== "string") {
    return sendSystemMessage(ws, "채널명을 입력해주세요.");
  }

  try {
    // Supabase에서 채널 조회
    let channel;
    try {
      channel = await prisma.channelData.findUnique({
        where: { name: channelName },
        include: { members: true },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (!channel) {
      return sendSystemMessage(ws, "채널이 존재하지 않습니다.");
    }

    // 이미 가입되어 있는지 확인
    const existingMember = channel.members.find((m) => m.userId === userId);
    if (existingMember) {
      return sendSystemMessage(ws, "이미 가입된 채널입니다.");
    }

    // 가입 순서 계산 (현재 멤버 수 + 1)
    const joinOrder = channel.members.length + 1;

    // Supabase에 멤버 추가
    try {
      await prisma.channelMember.create({
        data: {
          channelId: channel.id,
          userId: userId,
          permission: 1, // 일반 멤버
          status: 0,
          joinOrder: joinOrder,
        },
      });
    } catch (dbError) {
      logError("DB_MEMBER_CREATE", dbError);
      return sendSystemMessage(
        ws,
        "채널 참여 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    // Redis 캐시 업데이트 (실패해도 진행)
    await safeRedis(async () => {
      const channelKey = `channel:${channel.id}`;
      await redis.hSet(`${channelKey}:member:${userId}`, {
        channelId: channel.id,
        permission: "1",
        status: "0",
        joinOrder: joinOrder.toString(),
      });
      // 유저 채널 목록 캐시 무효화
      await redis.del(`user:${userId}:channels`);
    });

    // 멤버 목록 조회
    let updatedChannel;
    try {
      updatedChannel = await prisma.channelData.findUnique({
        where: { id: channel.id },
        include: {
          members: {
            include: {
              user: { select: { id: true, email: true, name: true } },
            },
            orderBy: { joinOrder: "asc" },
          },
        },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_MEMBERS", dbError);
      // 멤버 목록 조회 실패해도 가입 성공 메시지 전송
      return safeSend(ws, {
        event: "channelJoined",
        data: {
          time: Date.now(),
          channelId: channel.id,
          channel: channelName,
          users: [],
          message: `채널 '${channelName}'에 참여했습니다.`,
        },
      });
    }

    const users = updatedChannel.members.map((m) => ({
      userId: m.user.id,
      email: m.user.email,
      name: m.user.name,
      permission: m.permission,
      joinOrder: m.joinOrder,
    }));

    safeSend(ws, {
      event: "channelJoined",
      data: {
        time: Date.now(),
        channelId: channel.id,
        channel: channelName,
        users,
        message: `채널 '${channelName}'에 참여했습니다.`,
      },
    });

    console.log(`채널 참여: ${channelName} - ${userId} (순서: ${joinOrder})`);
  } catch (error) {
    logError("CHANNEL_JOIN", error);
    sendSystemMessage(ws, "채널 참여 중 오류가 발생했습니다.");
  }
}

// 채널 목록 조회 (해당 유저가 가입한 채널만)
async function handleListChannel(ws, data) {
  const userId = ws.user.id;

  try {
    // Redis 캐시 확인
    const cacheKey = `user:${userId}:channels`;
    const cachedChannels = await safeRedis(async () => {
      return await redis.get(cacheKey);
    });

    if (cachedChannels) {
      try {
        const parsed = JSON.parse(cachedChannels);
        console.log(`채널 목록 조회 (캐시): ${userId}`);
        return safeSend(ws, {
          event: "channelList",
          data: { time: Date.now(), channels: parsed },
        });
      } catch (parseError) {
        logError("CACHE_PARSE", parseError);
        // 캐시 파싱 실패 시 DB에서 조회
      }
    }

    // Supabase에서 유저가 가입한 채널 목록 조회
    let memberships;
    try {
      memberships = await prisma.channelMember.findMany({
        where: { userId: userId },
        include: {
          channel: {
            include: {
              members: {
                include: {
                  user: { select: { id: true, email: true, name: true } },
                },
                orderBy: { joinOrder: "asc" },
              },
            },
          },
        },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_LIST", dbError);
      return sendSystemMessage(
        ws,
        "채널 목록 조회 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    const channels = memberships.map((m) => ({
      channelId: m.channel.id,
      channelName: m.channel.name,
      myPermission: m.permission,
      myJoinOrder: m.joinOrder,
      createdAt: m.channel.createdAt,
      users: m.channel.members.map((member) => ({
        userId: member.user.id,
        email: member.user.email,
        name: member.user.name,
        permission: member.permission,
        joinOrder: member.joinOrder,
      })),
    }));

    // Redis에 캐시 저장 (5분 TTL) - 실패해도 진행
    await safeRedis(async () => {
      await redis.setEx(cacheKey, 300, JSON.stringify(channels));
    });

    safeSend(ws, {
      event: "channelList",
      data: { time: Date.now(), channels },
    });

    console.log(`채널 목록 조회 (DB): ${userId}`);
  } catch (error) {
    logError("CHANNEL_LIST", error);
    sendSystemMessage(ws, "채널 목록 조회 중 오류가 발생했습니다.");
  }
}

// 채널 탈퇴
async function handleQuitChannel(ws, data) {
  const { channel: channelName } = data;
  const userId = ws.user.id;

  if (!channelName || typeof channelName !== "string") {
    return sendSystemMessage(ws, "채널명을 입력해주세요.");
  }

  try {
    // Supabase에서 채널 조회
    let channel;
    try {
      channel = await prisma.channelData.findUnique({
        where: { name: channelName },
        include: { members: true },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (!channel) {
      return sendSystemMessage(ws, "채널이 존재하지 않습니다.");
    }

    // 멤버십 확인
    const membership = channel.members.find((m) => m.userId === userId);
    if (!membership) {
      return sendSystemMessage(ws, "가입되지 않은 채널입니다.");
    }

    // 오너(생성자)가 탈퇴하려는 경우
    if (membership.permission === 0) {
      if (channel.members.length > 1) {
        return sendSystemMessage(
          ws,
          "채널 생성자는 다른 멤버가 있을 때 탈퇴할 수 없습니다. 채널을 삭제하거나 권한을 양도해주세요.",
        );
      }

      // 마지막 멤버(오너)가 탈퇴 = 채널 삭제
      try {
        await prisma.channelData.delete({
          where: { id: channel.id },
        });
      } catch (dbError) {
        logError("DB_CHANNEL_DELETE", dbError);
        return sendSystemMessage(
          ws,
          "채널 삭제 중 데이터베이스 오류가 발생했습니다.",
        );
      }

      // Redis 캐시 삭제 (실패해도 진행)
      await safeRedis(async () => {
        const channelKey = `channel:${channel.id}`;
        const memberKeys = await redis.keys(`${channelKey}:member:*`);
        const keysToDelete = [channelKey, `user:${userId}:channels`];
        if (memberKeys.length > 0) {
          keysToDelete.push(...memberKeys);
        }
        await redis.del(keysToDelete);
      });

      safeSend(ws, {
        event: "channelQuitted",
        data: {
          time: Date.now(),
          channel: channelName,
          message: `채널 '${channelName}'이 삭제되었습니다. (마지막 멤버 탈퇴)`,
        },
      });

      console.log(`채널 삭제: ${channelName} (마지막 멤버 탈퇴)`);
      return;
    }

    // 일반 멤버 탈퇴
    try {
      await prisma.channelMember.delete({
        where: {
          channelId_userId: {
            channelId: channel.id,
            userId: userId,
          },
        },
      });
    } catch (dbError) {
      logError("DB_MEMBER_DELETE", dbError);
      return sendSystemMessage(
        ws,
        "채널 탈퇴 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    // Redis 캐시 삭제 (실패해도 진행)
    await safeRedis(async () => {
      const channelKey = `channel:${channel.id}`;
      await redis.del([
        `${channelKey}:member:${userId}`,
        `user:${userId}:channels`,
      ]);
    });

    safeSend(ws, {
      event: "channelQuitted",
      data: {
        time: Date.now(),
        channel: channelName,
        message: `채널 '${channelName}'에서 탈퇴했습니다.`,
      },
    });

    console.log(`채널 탈퇴: ${channelName} - ${userId}`);
  } catch (error) {
    logError("CHANNEL_QUIT", error);
    sendSystemMessage(ws, "채널 탈퇴 중 오류가 발생했습니다.");
  }
}

// === 서버 시작 ===
server.listen(3000, () => console.log("서버 실행중 :3000"));

// === Graceful Shutdown ===
async function gracefulShutdown(signal) {
  console.log(`\n${signal} 수신 - 서버 종료 중...`);

  // WebSocket 연결 종료
  wss.clients.forEach((client) => {
    try {
      client.close(1001, "Server shutting down");
    } catch (e) {
      // 무시
    }
  });

  // HTTP 서버 종료
  server.close(() => {
    console.log("HTTP 서버 종료됨");
  });

  // Redis 연결 종료
  try {
    if (redis.isOpen) {
      await redis.quit();
      console.log("Redis 연결 종료됨");
    }
  } catch (e) {
    logError("REDIS_CLOSE", e);
  }

  // Prisma 연결 종료
  try {
    await prisma.$disconnect();
    console.log("Prisma 연결 종료됨");
  } catch (e) {
    logError("PRISMA_CLOSE", e);
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
