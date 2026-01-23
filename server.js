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

// UUID 생성 (crypto 사용)
const crypto = require("crypto");
function generateUUID() {
  return crypto.randomUUID();
}

// UUID 중복 방지 생성 함수
async function generateUniqueId(model, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    const id = generateUUID();
    try {
      const existing = await prisma[model].findUnique({ where: { id } });
      if (!existing) return id;
      console.warn(
        `UUID 중복 발생 (${model}): ${id}, 재시도 ${i + 1}/${maxRetries}`,
      );
    } catch (error) {
      // findUnique 실패 시 해당 ID 사용 (테이블이 비어있거나 오류)
      return id;
    }
  }
  // 최대 재시도 초과 시에도 새 UUID 반환 (극히 드문 경우)
  return generateUUID();
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

// === Redis 초기화 (실시간 문서 동기화용 - 선택적) ===
const redis = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 3) {
        console.warn("Redis 재연결 포기 - 실시간 문서 동기화 기능 비활성화");
        return false; // 재연결 중단
      }
      return Math.min(retries * 500, 3000); // 최대 3초 대기
    },
  },
});

redis.on("error", (err) => {
  // 연결 거부 에러는 한 번만 로깅
  if (err.code !== "ECONNREFUSED" || !redis._errorLogged) {
    logError("REDIS", err);
    if (err.code === "ECONNREFUSED") redis._errorLogged = true;
  }
});
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
    // Redis 연결 실패는 채널 기능에 영향 없음 (추후 문서 동기화에만 사용)
    console.warn("Redis 연결 실패 - 실시간 문서 동기화 기능 제한됨");
    return false;
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

            // 문서 생성, 삭제
            case "createDoc":
              await handleCreateDoc(ws, data);
              break;

            case "deleteDoc":
              await handleDeleteDoc(ws, data);
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

// === 채널 핸들러 (Supabase 직접 조회) ===

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
    // Supabase에서 채널 존재 여부 확인 (삭제되지 않은 채널만)
    let existingChannel;
    try {
      existingChannel = await prisma.channelData.findFirst({
        where: { name: channelName, status: 0 },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (existingChannel) {
      return sendSystemMessage(ws, "이미 존재하는 채널입니다.");
    }

    // UUID 중복 방지
    const channelId = await generateUniqueId("channelData");
    const memberId = await generateUniqueId("channelMember");

    // Supabase에 채널 생성 (트랜잭션으로 채널 + 멤버 동시 생성)
    let channel;
    try {
      channel = await prisma.$transaction(async (tx) => {
        const newChannel = await tx.channelData.create({
          data: {
            id: channelId,
            name: channelName,
            createdBy: userId,
          },
        });

        // 생성자를 멤버로 추가 (permission: 0 = 오너)
        await tx.channelMember.create({
          data: {
            id: memberId,
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
    // Supabase에서 채널 조회 (삭제되지 않은 채널만, 활성 멤버만)
    let channel;
    try {
      channel = await prisma.channelData.findFirst({
        where: { name: channelName, status: 0 },
        include: {
          members: {
            where: { status: 0 }, // 활성 멤버만
          },
        },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (!channel) {
      return sendSystemMessage(ws, "채널이 존재하지 않습니다.");
    }

    // 기존 멤버십 확인 (탈퇴한 멤버 포함)
    let existingMember;
    try {
      existingMember = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId: channel.id,
            userId: userId,
          },
        },
      });
    } catch (dbError) {
      logError("DB_MEMBER_FIND", dbError);
      return sendSystemMessage(ws, "멤버 조회 중 오류가 발생했습니다.");
    }

    // 이미 활성 멤버인 경우
    if (existingMember && existingMember.status === 0) {
      return sendSystemMessage(ws, "이미 가입된 채널입니다.");
    }

    // 강제 퇴장 등으로 재가입 불가 상태인 경우 (status >= 2)
    if (existingMember && existingMember.status >= 2) {
      return sendSystemMessage(ws, "해당 채널에 가입할 수 없습니다.");
    }

    // 탈퇴한 멤버 재가입 (status === 1)
    if (existingMember && existingMember.status === 1) {
      try {
        await prisma.channelMember.update({
          where: { id: existingMember.id },
          data: { status: 0 },
        });
      } catch (dbError) {
        logError("DB_MEMBER_REJOIN", dbError);
        return sendSystemMessage(ws, "채널 재가입 중 오류가 발생했습니다.");
      }

      // 활성 멤버 수 조회
      let memberCount;
      try {
        memberCount = await prisma.channelMember.count({
          where: { channelId: channel.id, status: 0 },
        });
      } catch (dbError) {
        logError("DB_MEMBER_COUNT", dbError);
        memberCount = channel.members.length + 1;
      }

      safeSend(ws, {
        event: "channelJoined",
        data: {
          time: Date.now(),
          channelId: channel.id,
          channel: channelName,
          memberCount,
          myPermission: existingMember.permission,
          myJoinOrder: existingMember.joinOrder,
          message: `채널 '${channelName}'에 재참여했습니다.`,
        },
      });

      console.log(`채널 재참여: ${channelName} - ${userId}`);
      return;
    }

    // 신규 가입: 가입 순서 계산 (전체 멤버 기록 기준, 탈퇴 포함)
    let maxJoinOrder;
    try {
      const result = await prisma.channelMember.aggregate({
        where: { channelId: channel.id },
        _max: { joinOrder: true },
      });
      maxJoinOrder = result._max.joinOrder || 0;
    } catch (dbError) {
      logError("DB_JOIN_ORDER", dbError);
      maxJoinOrder = channel.members.length;
    }
    const joinOrder = maxJoinOrder + 1;

    // UUID 중복 방지
    const memberId = await generateUniqueId("channelMember");

    // Supabase에 멤버 추가
    try {
      await prisma.channelMember.create({
        data: {
          id: memberId,
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

    // 활성 멤버 수 조회
    let memberCount;
    try {
      memberCount = await prisma.channelMember.count({
        where: { channelId: channel.id, status: 0 },
      });
    } catch (dbError) {
      logError("DB_MEMBER_COUNT", dbError);
      memberCount = joinOrder;
    }

    safeSend(ws, {
      event: "channelJoined",
      data: {
        time: Date.now(),
        channelId: channel.id,
        channel: channelName,
        memberCount,
        myPermission: 1,
        myJoinOrder: joinOrder,
        message: `채널 '${channelName}'에 참여했습니다.`,
      },
    });

    console.log(`채널 참여: ${channelName} - ${userId} (순서: ${joinOrder})`);
  } catch (error) {
    logError("CHANNEL_JOIN", error);
    sendSystemMessage(ws, "채널 참여 중 오류가 발생했습니다.");
  }
}

// 채널 목록 조회 (공개 채널 목록 + 가입 여부)
async function handleListChannel(ws, data) {
  const userId = ws.user.id;

  try {
    // 공개 채널 목록 조회 (visibility = 0, status = 0)
    let publicChannels;
    try {
      publicChannels = await prisma.channelData.findMany({
        where: { visibility: 0, status: 0 },
        select: {
          id: true,
          name: true,
          visibility: true,
          createdAt: true,
          members: {
            where: { userId: userId, status: 0 }, // 활성 멤버만
            select: { id: true, permission: true, joinOrder: true },
          },
          _count: {
            select: {
              members: { where: { status: 0 } }, // 활성 멤버 수만
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_LIST", dbError);
      return sendSystemMessage(
        ws,
        "채널 목록 조회 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    const channels = publicChannels.map((channel) => {
      const membership = channel.members[0]; // 가입되어 있으면 1개, 없으면 빈 배열
      return {
        channelId: channel.id,
        channelName: channel.name,
        memberCount: channel._count.members,
        createdAt: channel.createdAt,
        joined: !!membership,
        myPermission: membership?.permission ?? null,
        myJoinOrder: membership?.joinOrder ?? null,
      };
    });

    safeSend(ws, {
      event: "channelList",
      data: { time: Date.now(), channels },
    });

    console.log(`채널 목록 조회: ${userId}`);
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
    // Supabase에서 채널 조회 (삭제되지 않은 채널, 활성 멤버만)
    let channel;
    try {
      channel = await prisma.channelData.findFirst({
        where: { name: channelName, status: 0 },
        include: {
          members: {
            where: { status: 0 }, // 활성 멤버만
          },
        },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (!channel) {
      return sendSystemMessage(ws, "채널이 존재하지 않습니다.");
    }

    // 멤버십 확인 (활성 멤버만)
    const membership = channel.members.find((m) => m.userId === userId);
    if (!membership) {
      return sendSystemMessage(ws, "가입되지 않은 채널입니다.");
    }

    // 오너(생성자)가 탈퇴하려는 경우
    if (membership.permission === 0) {
      // 활성 멤버가 본인만 있는 경우
      if (channel.members.length === 1) {
        // 마지막 멤버(오너)가 탈퇴 = 채널 소프트 삭제
        try {
          await prisma.$transaction([
            // 멤버 소프트 삭제
            prisma.channelMember.update({
              where: { id: membership.id },
              data: { status: 1 },
            }),
            // 채널 소프트 삭제
            prisma.channelData.update({
              where: { id: channel.id },
              data: { status: 1 },
            }),
          ]);
        } catch (dbError) {
          logError("DB_CHANNEL_SOFT_DELETE", dbError);
          return sendSystemMessage(
            ws,
            "채널 삭제 중 데이터베이스 오류가 발생했습니다.",
          );
        }

        safeSend(ws, {
          event: "channelQuitted",
          data: {
            time: Date.now(),
            channel: channelName,
            message: `채널 '${channelName}'이 삭제되었습니다. (마지막 멤버 탈퇴)`,
          },
        });

        console.log(`채널 소프트 삭제: ${channelName} (마지막 멤버 탈퇴)`);
        return;
      }

      // 다른 활성 멤버가 있는 경우
      return sendSystemMessage(
        ws,
        "채널 생성자는 다른 멤버가 있을 때 탈퇴할 수 없습니다. 채널을 삭제하거나 권한을 양도해주세요.",
      );
    }

    // 일반 멤버 탈퇴 (소프트 삭제)
    try {
      await prisma.channelMember.update({
        where: { id: membership.id },
        data: { status: 1 },
      });
    } catch (dbError) {
      logError("DB_MEMBER_SOFT_DELETE", dbError);
      return sendSystemMessage(
        ws,
        "채널 탈퇴 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    safeSend(ws, {
      event: "channelQuitted",
      data: {
        time: Date.now(),
        channel: channelName,
        message: `채널 '${channelName}'에서 탈퇴했습니다.`,
      },
    });

    console.log(`채널 탈퇴 (소프트 삭제): ${channelName} - ${userId}`);
  } catch (error) {
    logError("CHANNEL_QUIT", error);
    sendSystemMessage(ws, "채널 탈퇴 중 오류가 발생했습니다.");
  }
}

// === 문서 핸들러 (채널 오너만 생성/삭제 가능) ===

// 문서 생성 (LSEQ CRDT 기반)
async function handleCreateDoc(ws, data) {
  const { channelId, docName, dir = "root", depth = 0 } = data;
  const userId = ws.user.id;

  // 필수값 검증
  if (!channelId || typeof channelId !== "string") {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
  }
  if (!docName || typeof docName !== "string") {
    return sendSystemMessage(ws, "문서명을 입력해주세요.");
  }
  if (docName.length > 100) {
    return sendSystemMessage(ws, "문서명은 100자 이하로 입력해주세요.");
  }
  if (typeof dir !== "string" || dir.length > 100) {
    return sendSystemMessage(ws, "디렉토리명이 올바르지 않습니다.");
  }
  if (typeof depth !== "number" || depth < 0 || depth > 20) {
    return sendSystemMessage(ws, "디렉토리 깊이가 올바르지 않습니다. (0~20)");
  }

  try {
    // 채널 존재 여부 및 멤버십 확인
    let channel;
    try {
      channel = await prisma.channelData.findFirst({
        where: { id: channelId, status: 0 },
        include: {
          members: {
            where: { userId: userId, status: 0 },
            select: { permission: true, joinOrder: true },
          },
        },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (!channel) {
      return sendSystemMessage(ws, "채널이 존재하지 않습니다.");
    }

    // 멤버십 확인
    const membership = channel.members[0];
    if (!membership) {
      return sendSystemMessage(ws, "해당 채널에 가입되어 있지 않습니다.");
    }

    // 오너(생성자) 권한 확인 (permission: 0 = 오너)
    if (membership.permission !== 0) {
      return sendSystemMessage(
        ws,
        "문서 생성 권한이 없습니다. (채널 오너만 가능)",
      );
    }

    // 같은 경로에 동일한 이름의 문서 존재 여부 확인 (삭제되지 않은 문서만)
    let existingDoc;
    try {
      existingDoc = await prisma.documentData.findFirst({
        where: {
          channelId: channelId,
          name: docName,
          dir: dir,
          depth: depth,
          status: 0,
        },
      });
    } catch (dbError) {
      logError("DB_DOC_FIND", dbError);
      return sendSystemMessage(ws, "문서 조회 중 오류가 발생했습니다.");
    }

    if (existingDoc) {
      return sendSystemMessage(
        ws,
        "같은 경로에 동일한 이름의 문서가 이미 존재합니다.",
      );
    }

    // UUID 중복 방지
    const docId = await generateUniqueId("documentData");

    // 문서 생성 (LSEQ CRDT 초기 상태)
    let document;
    try {
      document = await prisma.documentData.create({
        data: {
          id: docId,
          channelId: channelId,
          name: docName,
          dir: dir,
          depth: depth,
          content: "", // 초기 본문 비어있음
          logMetadata: [], // 초기 로그 비어있음 (LSEQ 편집 기록용)
          snapshotVersion: 0,
          permission: 0, // 채널 멤버 전체 편집 가능
          status: 0,
          createdBy: userId,
        },
      });
    } catch (dbError) {
      logError("DB_DOC_CREATE", dbError);
      // unique constraint 위반 시
      if (dbError.code === "P2002") {
        return sendSystemMessage(
          ws,
          "같은 경로에 동일한 이름의 문서가 이미 존재합니다.",
        );
      }
      return sendSystemMessage(
        ws,
        "문서 생성 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    safeSend(ws, {
      event: "docCreated",
      data: {
        time: Date.now(),
        docId: document.id,
        channelId: channelId,
        docName: docName,
        dir: dir,
        depth: depth,
        snapshotVersion: document.snapshotVersion,
        message: `문서 '${docName}'이 생성되었습니다.`,
      },
    });

    console.log(
      `문서 생성: ${docName} (${document.id}) in ${channelId} at ${dir}/${depth} by ${userId}`,
    );
  } catch (error) {
    logError("DOC_CREATE", error);
    sendSystemMessage(ws, "문서 생성 중 오류가 발생했습니다.");
  }
}

// 문서 삭제 (소프트 삭제)
async function handleDeleteDoc(ws, data) {
  const { channelId, docId } = data;
  const userId = ws.user.id;

  // 필수값 검증
  if (!channelId || typeof channelId !== "string") {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
  }
  if (!docId || typeof docId !== "string") {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }

  try {
    // 채널 존재 여부 및 멤버십 확인
    let channel;
    try {
      channel = await prisma.channelData.findFirst({
        where: { id: channelId, status: 0 },
        include: {
          members: {
            where: { userId: userId, status: 0 },
            select: { permission: true },
          },
        },
      });
    } catch (dbError) {
      logError("DB_CHANNEL_FIND", dbError);
      return sendSystemMessage(ws, "채널 조회 중 오류가 발생했습니다.");
    }

    if (!channel) {
      return sendSystemMessage(ws, "채널이 존재하지 않습니다.");
    }

    // 멤버십 확인
    const membership = channel.members[0];
    if (!membership) {
      return sendSystemMessage(ws, "해당 채널에 가입되어 있지 않습니다.");
    }

    // 오너(생성자) 권한 확인
    if (membership.permission !== 0) {
      return sendSystemMessage(
        ws,
        "문서 삭제 권한이 없습니다. (채널 오너만 가능)",
      );
    }

    // 문서 존재 여부 확인 (삭제되지 않은 문서만)
    let document;
    try {
      document = await prisma.documentData.findFirst({
        where: {
          id: docId,
          channelId: channelId,
          status: 0,
        },
      });
    } catch (dbError) {
      logError("DB_DOC_FIND", dbError);
      return sendSystemMessage(ws, "문서 조회 중 오류가 발생했습니다.");
    }

    if (!document) {
      return sendSystemMessage(ws, "문서가 존재하지 않습니다.");
    }

    // 소프트 삭제 (status: 1)
    try {
      await prisma.documentData.update({
        where: { id: docId },
        data: { status: 1 },
      });
    } catch (dbError) {
      logError("DB_DOC_SOFT_DELETE", dbError);
      return sendSystemMessage(
        ws,
        "문서 삭제 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    safeSend(ws, {
      event: "docDeleted",
      data: {
        time: Date.now(),
        docId: docId,
        channelId: channelId,
        docName: document.name,
        dir: document.dir,
        depth: document.depth,
        message: `문서 '${document.name}'이 삭제되었습니다.`,
      },
    });

    console.log(
      `문서 소프트 삭제: ${document.name} (${docId}) in ${channelId} by ${userId}`,
    );
  } catch (error) {
    logError("DOC_DELETE", error);
    sendSystemMessage(ws, "문서 삭제 중 오류가 발생했습니다.");
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
