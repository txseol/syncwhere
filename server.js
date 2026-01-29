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

// 하위 항목들의 depth를 재귀적으로 업데이트
async function updateChildrenDepthRecursive(tx, channelId, parentDirName, parentDepth, depthDelta, updatedList) {
  try {
    // 해당 디렉토리의 모든 직계 자식 찾기
    const children = await tx.documentData.findMany({
      where: {
        channelId: channelId,
        dir: parentDirName,
        depth: parentDepth,
        status: 0,
      },
    });

    for (const child of children) {
      const newChildDepth = child.depth + depthDelta;
      
      // 자식 depth 업데이트
      await tx.documentData.update({
        where: { id: child.id },
        data: { depth: newChildDepth },
      });

      updatedList.push({
        id: child.id,
        name: child.name,
        oldDepth: child.depth,
        newDepth: newChildDepth,
      });

      // 이 자식이 디렉토리인 경우 재귀 호출
      if (child.isDirectory) {
        await updateChildrenDepthRecursive(tx, channelId, child.name, newChildDepth + 1, depthDelta, updatedList);
      }
    }
  } catch (error) {
    logError("UPDATE_CHILDREN_DEPTH", error);
    throw error;
  }
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

// === 문서 상태 상수 ===
const DOC_STATUS = {
  NORMAL: 0, // 정상 (작업 가능)
  DELETED: 1, // 삭제됨
  LOCKED: 2, // 작업 중 (입력 불가능)
};

// === Prisma 초기화 ===
const prisma = new PrismaClient({
  log: [
    { level: "error", emit: "stdout" },
    { level: "warn", emit: "stdout" },
  ],
});

// === 채널/문서별 웹소켓 연결 관리 ===
// 채널별 연결된 클라이언트: Map<channelId, Set<ws>>
const channelConnections = new Map();
// 문서별 연결된 클라이언트: Map<docId, Set<ws>>
const docConnections = new Map();

// 채널에 웹소켓 추가
function addToChannel(channelId, ws) {
  if (!channelConnections.has(channelId)) {
    channelConnections.set(channelId, new Set());
  }
  channelConnections.get(channelId).add(ws);
  ws.currentChannel = channelId;
}

// 채널에서 웹소켓 제거
function removeFromChannel(channelId, ws) {
  const connections = channelConnections.get(channelId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      channelConnections.delete(channelId);
    }
  }
  if (ws.currentChannel === channelId) {
    ws.currentChannel = null;
  }
}

// 문서에 웹소켓 추가
function addToDoc(docId, ws) {
  if (!docConnections.has(docId)) {
    docConnections.set(docId, new Set());
  }
  docConnections.get(docId).add(ws);
  ws.currentDoc = docId;
}

// 문서에서 웹소켓 제거
function removeFromDoc(docId, ws) {
  const connections = docConnections.get(docId);
  if (connections) {
    connections.delete(ws);
    if (connections.size === 0) {
      docConnections.delete(docId);
    }
  }
  if (ws.currentDoc === docId) {
    ws.currentDoc = null;
  }
}

// 채널 내 모든 유저에게 브로드캐스트 (자신 제외 옵션)
function broadcastToChannel(channelId, event, data, excludeWs = null) {
  const connections = channelConnections.get(channelId);
  if (!connections) return 0;

  let sentCount = 0;
  connections.forEach((ws) => {
    if (ws !== excludeWs) {
      if (safeSend(ws, { event, data })) {
        sentCount++;
      }
    }
  });
  return sentCount;
}

// 문서 열람 중인 유저에게 브로드캐스트 (자신 제외 옵션)
function broadcastToDoc(docId, event, data, excludeWs = null) {
  const connections = docConnections.get(docId);
  if (!connections) return 0;

  let sentCount = 0;
  connections.forEach((ws) => {
    if (ws !== excludeWs) {
      if (safeSend(ws, { event, data })) {
        sentCount++;
      }
    }
  });
  return sentCount;
}

// 채널 내 현재 접속 유저 목록 조회
function getChannelUsers(channelId) {
  const connections = channelConnections.get(channelId);
  if (!connections) return [];

  const users = [];
  connections.forEach((ws) => {
    if (ws.user) {
      users.push({
        id: ws.user.id,
        email: ws.user.email,
        currentDoc: ws.currentDoc || null,
      });
    }
  });
  return users;
}

// 문서 열람 중인 유저 목록 조회
function getDocUsers(docId) {
  const connections = docConnections.get(docId);
  if (!connections) return [];

  const users = [];
  connections.forEach((ws) => {
    if (ws.user) {
      users.push({
        id: ws.user.id,
        email: ws.user.email,
      });
    }
  });
  return users;
}

// 문서 열람 인원 수 조회
function getDocUserCount(docId) {
  const connections = docConnections.get(docId);
  return connections ? connections.size : 0;
}

// === Redis 문서 캐시 함수 ===
const DOC_CACHE_PREFIX = "doc:";
// TTL 제거 - 문서는 영구 캐싱, 서버 시작 시 초기화

// Redis 문서 캐시 키 생성
function getDocCacheKey(docId) {
  return `${DOC_CACHE_PREFIX}${docId}`;
}

// Redis에서 문서 캐시 조회
async function getDocFromCache(docId) {
  return await safeRedis(async () => {
    const key = getDocCacheKey(docId);
    const data = await redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      logError("DOC_CACHE_PARSE", e);
      return null;
    }
  }, null);
}

// Redis에 문서 캐시 저장 (TTL 없음)
async function setDocToCache(docId, docData) {
  return await safeRedis(async () => {
    const key = getDocCacheKey(docId);
    await redis.set(key, JSON.stringify(docData));
    return true;
  }, false);
}

// Redis 문서 캐시 삭제
async function deleteDocFromCache(docId) {
  return await safeRedis(async () => {
    const key = getDocCacheKey(docId);
    await redis.del(key);
    return true;
  }, false);
}

// Redis 문서 캐시 업데이트 (부분 업데이트)
async function updateDocCache(docId, updates) {
  return await safeRedis(async () => {
    const existing = await getDocFromCache(docId);
    if (!existing) return false;

    const updated = { ...existing, ...updates };
    await setDocToCache(docId, updated);
    return true;
  }, false);
}

// === 문서 상태 관리 함수 ===

// 문서 상태 변경 및 전파
async function setDocStatus(docId, status, broadcastMsg = null) {
  // Redis 캐시 업데이트
  const updated = await updateDocCache(docId, { status });

  // 문서 열람 중인 유저들에게 상태 변경 알림
  broadcastToDoc(docId, "docStatusChanged", {
    time: Date.now(),
    docId: docId,
    status: status,
    statusText:
      status === DOC_STATUS.NORMAL
        ? "normal"
        : status === DOC_STATUS.DELETED
          ? "deleted"
          : "locked",
    message: broadcastMsg,
  });

  return updated;
}

// 문서 잠금 (편집 불가)
async function lockDoc(docId, reason = "동기화 작업 중입니다.") {
  console.log(`문서 잠금: ${docId}`);
  return await setDocStatus(docId, DOC_STATUS.LOCKED, reason);
}

// 문서 잠금 해제 (편집 가능)
async function unlockDoc(docId) {
  console.log(`문서 잠금 해제: ${docId}`);
  return await setDocStatus(docId, DOC_STATUS.NORMAL, "편집이 가능합니다.");
}

// 문서가 편집 가능한 상태인지 확인
async function isDocEditable(docId) {
  const doc = await getDocFromCache(docId);
  if (!doc) return false;
  return doc.status === DOC_STATUS.NORMAL;
}

// === Redis → Supabase 동기화 함수 ===

// Redis 캐시를 Supabase로 동기화
async function syncDocToSupabase(docId) {
  const cachedDoc = await getDocFromCache(docId);
  if (!cachedDoc) {
    console.log(`동기화 스킵 (캐시 없음): ${docId}`);
    return false;
  }

  try {
    // Supabase 문서 조회
    const dbDoc = await prisma.documentData.findUnique({
      where: { id: docId },
      select: { status: true },
    });

    if (!dbDoc) {
      console.log(`동기화 스킵 (DB 문서 없음): ${docId}`);
      return false;
    }

    // 삭제된 문서는 동기화하지 않음
    if (dbDoc.status === DOC_STATUS.DELETED) {
      console.log(`동기화 스킵 (삭제된 문서): ${docId}`);
      await deleteDocFromCache(docId);
      return false;
    }

    // 캠시 내용을 DB에 동기화
    await prisma.documentData.update({
      where: { id: docId },
      data: {
        content: cachedDoc.content,
      },
    });
    console.log(`동기화 완료: ${docId}`);
    return true;
  } catch (error) {
    logError("DOC_SYNC", error);
    return false;
  }
}

// Supabase에서 문서를 Redis 캐시로 로드
async function loadDocToCache(docId) {
  try {
    const doc = await prisma.documentData.findUnique({
      where: { id: docId },
      select: {
        id: true,
        channelId: true,
        name: true,
        content: true,
        isDirectory: true,
        status: true,
        dir: true,
        depth: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!doc) return null;

    const cacheData = {
      id: doc.id,
      channelId: doc.channelId,
      name: doc.name,
      content: doc.content || "",
      isDirectory: doc.isDirectory,
      status: doc.status,
      dir: doc.dir,
      depth: doc.depth,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };

    await setDocToCache(docId, cacheData);
    console.log(`캐시 로드: ${docId}`);
    return cacheData;
  } catch (error) {
    logError("DOC_CACHE_LOAD", error);
    return null;
  }
}

// 문서 연결 해제 시 동기화 체크 (마지막 유저 퇴장 시)
async function onDocDisconnect(docId) {
  const remainingUsers = getDocUserCount(docId);

  if (remainingUsers === 0) {
    console.log(`마지막 유저 퇴장, 동기화 시작: ${docId}`);
    await syncDocToSupabase(docId);
  }
}

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

    // 서버 시작시 모든 Redis 캐시 초기화
    try {
      await redis.flushDb();
      console.log("Redis 초기화: 모든 캐시 삭제됨");
    } catch (cacheError) {
      logError("REDIS_CACHE_CLEAR", cacheError);
      // 캐시 초기화 실패는 치명적이지 않으므로 계속 진행
    }

    // 모든 활성 문서를 Supabase에서 Redis로 로드
    try {
      const documents = await prisma.documentData.findMany({
        where: {
          status: { not: DOC_STATUS.DELETED },
        },
      });

      let loadedCount = 0;
      for (const doc of documents) {
        await loadDocToCache(doc.id);
        loadedCount++;
      }
      console.log(`Redis 문서 캐싱 완료: ${loadedCount}개 문서 로드됨`);
    } catch (loadError) {
      logError("REDIS_DOC_LOAD", loadError);
      console.warn("문서 캐싱 실패 - 요청 시 개별 로드됨");
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

            // 문서 생성, 삭제, 목록
            case "createDoc":
              await handleCreateDoc(ws, data);
              break;

            case "deleteDoc":
              await handleDeleteDoc(ws, data);
              break;

            case "listDoc":
              await handleListDoc(ws, data);
              break;

            // 채널 입장/퇴장 (실시간 연결 관리)
            case "enterChannel":
              await handleEnterChannel(ws, data);
              break;

            case "leaveChannel":
              await handleLeaveChannel(ws, data);
              break;

            // 문서 열람 입장/퇴장
            case "enterDoc":
              await handleEnterDoc(ws, data);
              break;

            case "leaveDoc":
              await handleLeaveDoc(ws, data);
              break;

            // 문서 수정 (경로, 이름 변경)
            case "updateDoc":
              await handleUpdateDoc(ws, data);
              break;

            // 채널 내 현재 접속 유저 조회
            case "getChannelUsers":
              await handleGetChannelUsers(ws, data);
              break;

            // 문서 열람 중인 유저 조회
            case "getDocUsers":
              await handleGetDocUsers(ws, data);
              break;

            // 문서 상태 조회
            case "getDocStatus":
              await handleGetDocStatus(ws, data);
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

        // 웹소켓 연결 종료 시 채널/문서에서 정리
        const userId = ws.user?.id;
        const channelId = ws.currentChannel;
        const docId = ws.currentDoc;

        // 문서에서 퇴장 처리
        if (docId) {
          removeFromDoc(docId, ws);
          // 문서 열람 중인 다른 유저들에게 퇴장 알림
          broadcastToDoc(docId, "userLeftDoc", {
            time: Date.now(),
            docId: docId,
            userId: userId,
            email: ws.user?.email,
            reason: "disconnected",
          });

          // 마지막 유저 퇴장 시 동기화 체크
          onDocDisconnect(docId);
        }

        // 채널에서 퇴장 처리
        if (channelId) {
          removeFromChannel(channelId, ws);
          // 채널 내 다른 유저들에게 퇴장 알림
          broadcastToChannel(channelId, "userLeft", {
            time: Date.now(),
            channelId: channelId,
            userId: userId,
            email: ws.user?.email,
            reason: "disconnected",
          });
        }
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

// === 문서 핸들러 ===

// 문서/디렉토리 생성
async function handleCreateDoc(ws, data) {
  // parentDir: 부모 디렉토리 경로 ("root" 또는 "root/pathA" 등)
  // isDirectory: true이면 디렉토리 생성
  const { channelId, docName, parentDir = "root", isDirectory = false } = data;
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
  if (typeof parentDir !== "string" || parentDir.length > 500) {
    return sendSystemMessage(ws, "부모 디렉토리 경로가 올바르지 않습니다.");
  }

  // parentDir에서 dir과 depth 계산
  // 예: parentDir="root" → dir="root", depth=0
  // 예: parentDir="root/pathA" → dir="pathA", depth=1
  const pathParts = parentDir.split("/").filter(p => p.length > 0);
  if (pathParts.length === 0 || pathParts[0] !== "root") {
    return sendSystemMessage(ws, "경로는 'root'로 시작해야 합니다.");
  }
  
  const depth = pathParts.length - 1;
  const dir = pathParts[pathParts.length - 1];
  
  if (depth > 20) {
    return sendSystemMessage(ws, "디렉토리 깊이가 너무 깊습니다. (최대 20)");
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
      return sendSystemMessage(ws, "문서 생성 권한이 없습니다.");
    }

    // 경로 유효성 검증: 부모 디렉토리가 존재하는지 확인 (root 제외)
    if (depth > 0) {
      // 부모 디렉토리(isDirectory=true)가 존재해야 함
      let parentDirectory;
      try {
        parentDirectory = await prisma.documentData.findFirst({
          where: {
            channelId: channelId,
            name: dir,
            isDirectory: true,
            status: 0,
          },
        });
      } catch (dbError) {
        logError("DB_DOC_FIND_PARENT", dbError);
        return sendSystemMessage(ws, "부모 디렉토리 확인 중 오류가 발생했습니다.");
      }

      if (!parentDirectory) {
        return sendSystemMessage(
          ws,
          `부모 디렉토리 '${dir}'가 존재하지 않습니다. 먼저 디렉토리를 생성해주세요.`,
        );
      }
    }

    // 같은 경로에 동일한 이름의 문서 존재 여부 확인
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
        isDirectory 
          ? `'${docName}' 디렉토리가 이미 존재합니다.`
          : "같은 경로에 동일한 이름의 문서가 이미 존재합니다.",
      );
    }

    // UUID 중복 방지
    const docId = await generateUniqueId("documentData");

    // 문서/디렉토리 생성
    let document;
    try {
      document = await prisma.documentData.create({
        data: {
          id: docId,
          channelId: channelId,
          name: docName,
          dir: dir,
          depth: depth,
          isDirectory: isDirectory,
          content: "",
          permission: 0,
          status: DOC_STATUS.NORMAL,
          createdBy: userId,
        },
      });
    } catch (dbError) {
      logError("DB_DOC_CREATE", dbError);
      if (dbError.code === "P2002") {
        return sendSystemMessage(
          ws,
          isDirectory 
            ? `'${docName}' 디렉토리가 이미 존재합니다.`
            : "같은 경로에 동일한 이름의 문서가 이미 존재합니다.",
        );
      }
      return sendSystemMessage(
        ws,
        "문서 생성 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    // 채널 내 모든 유저에게 생성 알림 (목록 새로고침 트리거)
    broadcastToChannel(
      channelId,
      "docListChanged",
      {
        time: Date.now(),
        channelId: channelId,
        action: "created",
        docId: document.id,
        docName: docName,
        dir: dir,
        depth: depth,
        parentDir: parentDir,
        isDirectory: isDirectory,
        createdBy: userId,
      },
      ws,
    );

    safeSend(ws, {
      event: isDirectory ? "directoryCreated" : "docCreated",
      data: {
        time: Date.now(),
        docId: document.id,
        channelId: channelId,
        docName: docName,
        dir: dir,
        depth: depth,
        parentDir: parentDir,
        isDirectory: isDirectory,
        message: isDirectory 
          ? `디렉토리 '${docName}'이 생성되었습니다.`
          : `문서 '${docName}'이 생성되었습니다.`,
      },
    });

    console.log(
      `${isDirectory ? "디렉토리" : "문서"} 생성: ${docName} (${document.id}) in ${channelId} at ${dir}/${depth} by ${userId}`,
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
      return sendSystemMessage(ws, "문서 삭제 권한이 없습니다.");
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

    // 채널 내 모든 유저에게 문서 삭제 알림 (목록 새로고침 트리거)
    broadcastToChannel(
      channelId,
      "docListChanged",
      {
        time: Date.now(),
        channelId: channelId,
        action: "deleted",
        docId: docId,
        docName: document.name,
        dir: document.dir,
        depth: document.depth,
        deletedBy: userId,
      },
      ws, // 자신에게는 별도로 전송
    );

    // 해당 문서를 열람 중인 유저들에게도 알림
    broadcastToDoc(docId, "docDeleted", {
      time: Date.now(),
      docId: docId,
      docName: document.name,
      deletedBy: userId,
      message: `문서 '${document.name}'이 삭제되었습니다.`,
    });

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

// 문서 목록 조회
async function handleListDoc(ws, data) {
  const { channelId } = data;
  const userId = ws.user.id;

  // 필수값 검증
  if (!channelId || typeof channelId !== "string") {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
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

    // 문서 목록 조회 (삭제되지 않은 문서만)
    let documents;
    try {
      documents = await prisma.documentData.findMany({
        where: { channelId: channelId, status: 0 },
        select: {
          id: true,
          channelId: true,
          name: true,
          dir: true,
          depth: true,
          isDirectory: true,
          createdAt: true,
        },
        orderBy: [{ dir: "asc" }, { depth: "asc" }, { name: "asc" }],
      });
    } catch (dbError) {
      logError("DB_DOC_LIST", dbError);
      return sendSystemMessage(
        ws,
        "문서 목록 조회 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    safeSend(ws, {
      event: "docList",
      data: {
        time: Date.now(),
        channelId: channelId,
        documents: documents.map((d) => ({
          docId: d.id,
          channelId: d.channelId,
          name: d.name,
          dir: d.dir,
          depth: d.depth,
          isDirectory: d.isDirectory,
          createdAt: d.createdAt.toISOString(),
        })),
      },
    });

    console.log(`문서 목록 조회: ${channelId} by ${userId}`);
  } catch (error) {
    logError("DOC_LIST", error);
    sendSystemMessage(ws, "문서 목록 조회 중 오류가 발생했습니다.");
  }
}

// === 채널 입장/퇴장 핸들러 (실시간 연결 관리) ===

// 채널 입장 (실시간 연결)
async function handleEnterChannel(ws, data) {
  const { channelId } = data;
  const userId = ws.user.id;

  if (!channelId || typeof channelId !== "string") {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
  }

  try {
    // 이미 다른 채널에 입장한 상태면 먼저 퇴장
    if (ws.currentChannel && ws.currentChannel !== channelId) {
      const prevChannelId = ws.currentChannel;
      removeFromChannel(prevChannelId, ws);

      // 이전 채널 유저들에게 퇴장 알림
      broadcastToChannel(prevChannelId, "userLeft", {
        time: Date.now(),
        channelId: prevChannelId,
        userId: userId,
        email: ws.user.email,
      });
    }

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

    // 채널에 입장
    addToChannel(channelId, ws);

    // 채널 내 다른 유저들에게 입장 알림
    broadcastToChannel(
      channelId,
      "userEntered",
      {
        time: Date.now(),
        channelId: channelId,
        userId: userId,
        email: ws.user.email,
      },
      ws,
    );

    // 현재 채널 접속 유저 목록
    const onlineUsers = getChannelUsers(channelId);

    safeSend(ws, {
      event: "channelEntered",
      data: {
        time: Date.now(),
        channelId: channelId,
        channelName: channel.name,
        myPermission: membership.permission,
        myJoinOrder: membership.joinOrder,
        onlineUsers: onlineUsers,
        message: `채널 '${channel.name}'에 입장했습니다.`,
      },
    });

    console.log(`채널 입장: ${channel.name} (${channelId}) - ${userId}`);
  } catch (error) {
    logError("CHANNEL_ENTER", error);
    sendSystemMessage(ws, "채널 입장 중 오류가 발생했습니다.");
  }
}

// 채널 퇴장 (실시간 연결 해제)
async function handleLeaveChannel(ws, data) {
  const { channelId } = data;
  const userId = ws.user.id;

  // channelId 없으면 현재 채널에서 퇴장
  const targetChannelId = channelId || ws.currentChannel;

  if (!targetChannelId) {
    return sendSystemMessage(ws, "퇴장할 채널이 없습니다.");
  }

  // 문서 열람 중이면 먼저 문서에서 퇴장
  if (ws.currentDoc) {
    const docId = ws.currentDoc;
    removeFromDoc(docId, ws);

    // 문서 열람 유저들에게 퇴장 알림
    broadcastToDoc(docId, "userLeftDoc", {
      time: Date.now(),
      docId: docId,
      userId: userId,
      email: ws.user.email,
    });
  }

  // 채널에서 퇴장
  removeFromChannel(targetChannelId, ws);

  // 채널 내 다른 유저들에게 퇴장 알림
  broadcastToChannel(targetChannelId, "userLeft", {
    time: Date.now(),
    channelId: targetChannelId,
    userId: userId,
    email: ws.user.email,
  });

  safeSend(ws, {
    event: "channelLeft",
    data: {
      time: Date.now(),
      channelId: targetChannelId,
      message: "채널에서 퇴장했습니다.",
    },
  });

  console.log(`채널 퇴장: ${targetChannelId} - ${userId}`);
}

// === 문서 열람 입장/퇴장 핸들러 ===

// 문서 열람 시작 (입장)
async function handleEnterDoc(ws, data) {
  const { channelId, docId } = data;
  const userId = ws.user.id;

  if (!channelId || typeof channelId !== "string") {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
  }
  if (!docId || typeof docId !== "string") {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }

  // 채널에 입장하지 않은 상태면 먼저 채널 입장 필요
  if (ws.currentChannel !== channelId) {
    return sendSystemMessage(ws, "먼저 해당 채널에 입장해주세요.");
  }

  try {
    // 이미 다른 문서를 열람 중이면 먼저 퇴장
    if (ws.currentDoc && ws.currentDoc !== docId) {
      const prevDocId = ws.currentDoc;
      removeFromDoc(prevDocId, ws);

      // 이전 문서 열람 유저들에게 퇴장 알림
      broadcastToDoc(prevDocId, "userLeftDoc", {
        time: Date.now(),
        docId: prevDocId,
        userId: userId,
        email: ws.user.email,
      });

      // 마지막 유저 퇴장 시 동기화 체크
      onDocDisconnect(prevDocId);
    }

    // Redis 캐시에서 문서 조회 (없으면 DB에서 로드)
    let document = await getDocFromCache(docId);

    if (!document) {
      // DB에서 문서 조회 후 캐시에 로드
      document = await loadDocToCache(docId);
    }

    // 문서가 없거나 채널 불일치 또는 삭제된 경우
    if (!document || document.channelId !== channelId) {
      return sendSystemMessage(ws, "문서가 존재하지 않습니다.");
    }

    if (document.status === DOC_STATUS.DELETED) {
      return sendSystemMessage(ws, "삭제된 문서입니다.");
    }

    // 문서에 입장
    addToDoc(docId, ws);

    // 문서 열람 중인 다른 유저들에게 입장 알림
    broadcastToDoc(
      docId,
      "userEnteredDoc",
      {
        time: Date.now(),
        docId: docId,
        userId: userId,
        email: ws.user.email,
      },
      ws,
    );

    // 채널 내 유저들에게도 상태 변경 알림 (누군가가 문서를 열람 시작함)
    broadcastToChannel(
      channelId,
      "userDocStatusChanged",
      {
        time: Date.now(),
        channelId: channelId,
        userId: userId,
        email: ws.user.email,
        docId: docId,
        docName: document.name,
        status: "viewing",
      },
      ws,
    );

    // 현재 문서 열람 유저 목록
    const viewingUsers = getDocUsers(docId);

    safeSend(ws, {
      event: "docEntered",
      data: {
        time: Date.now(),
        docId: docId,
        channelId: channelId,
        docName: document.name,
        dir: document.dir,
        depth: document.depth,
        isDirectory: document.isDirectory,
        content: document.content,
        status: document.status,
        statusText:
          document.status === DOC_STATUS.NORMAL
            ? "normal"
            : document.status === DOC_STATUS.DELETED
              ? "deleted"
              : "locked",
        viewingUsers: viewingUsers,
        message: `문서 '${document.name}'을 열람합니다.`,
      },
    });

    console.log(`문서 입장: ${document.name} (${docId}) - ${userId}`);
  } catch (error) {
    logError("DOC_ENTER", error);
    sendSystemMessage(ws, "문서 열람 중 오류가 발생했습니다.");
  }
}

// 문서 열람 종료 (퇴장)
async function handleLeaveDoc(ws, data) {
  const { docId } = data;
  const userId = ws.user.id;

  // docId 없으면 현재 문서에서 퇴장
  const targetDocId = docId || ws.currentDoc;

  if (!targetDocId) {
    return sendSystemMessage(ws, "퇴장할 문서가 없습니다.");
  }

  const channelId = ws.currentChannel;

  // 문서에서 퇴장
  removeFromDoc(targetDocId, ws);

  // 문서 열람 중인 다른 유저들에게 퇴장 알림
  broadcastToDoc(targetDocId, "userLeftDoc", {
    time: Date.now(),
    docId: targetDocId,
    userId: userId,
    email: ws.user.email,
  });

  // 채널 내 유저들에게도 상태 변경 알림
  if (channelId) {
    broadcastToChannel(
      channelId,
      "userDocStatusChanged",
      {
        time: Date.now(),
        channelId: channelId,
        userId: userId,
        email: ws.user.email,
        docId: null,
        docName: null,
        status: "idle",
      },
      ws,
    );
  }

  safeSend(ws, {
    event: "docLeft",
    data: {
      time: Date.now(),
      docId: targetDocId,
      message: "문서 열람을 종료했습니다.",
    },
  });

  // 마지막 유저 퇴장 시 동기화 체크
  onDocDisconnect(targetDocId);

  console.log(`문서 퇴장: ${targetDocId} - ${userId}`);
}

// === 문서 수정 핸들러 (경로, 이름 변경) ===

async function handleUpdateDoc(ws, data) {
  // newDir: 이동할 상위 디렉토리명 ("root", "pathA" 등)
  // newDepth: 이동할 위치의 depth (0, 1, 2...)
  // newName: 새 파일/폴더명 (이름 변경 시)
  const { channelId, docId, newName, newDir, newDepth } = data;
  const userId = ws.user.id;

  // 필수값 검증
  if (!channelId || typeof channelId !== "string") {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
  }
  if (!docId || typeof docId !== "string") {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }

  // 수정할 값이 하나도 없으면
  if (newName === undefined && newDir === undefined && newDepth === undefined) {
    return sendSystemMessage(ws, "수정할 항목을 입력해주세요.");
  }

  // 유효성 검증
  if (newName !== undefined) {
    if (typeof newName !== "string" || newName.length === 0) {
      return sendSystemMessage(ws, "문서명이 올바르지 않습니다.");
    }
    if (newName.length > 100) {
      return sendSystemMessage(ws, "문서명은 100자 이하로 입력해주세요.");
    }
  }
  if (newDir !== undefined) {
    if (typeof newDir !== "string" || newDir.length === 0) {
      return sendSystemMessage(ws, "디렉토리명이 올바르지 않습니다.");
    }
    if (newDir.length > 100) {
      return sendSystemMessage(ws, "디렉토리명은 100자 이하로 입력해주세요.");
    }
  }
  if (newDepth !== undefined) {
    if (typeof newDepth !== "number" || newDepth < 0 || newDepth > 20) {
      return sendSystemMessage(ws, "디렉토리 깊이가 올바르지 않습니다. (0~20)");
    }
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
      return sendSystemMessage(ws, "문서 수정 권한이 없습니다.");
    }

    // 문서 존재 여부 확인
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

    // 최종 값 계산 (변경되지 않는 값은 기존값 유지)
    const finalName = newName !== undefined ? newName : document.name;
    const finalDir = newDir !== undefined ? newDir : document.dir;
    const finalDepth = newDepth !== undefined ? newDepth : document.depth;

    // 이동하는 경우 대상 디렉토리 존재 확인 (root 제외)
    if ((newDir !== undefined || newDepth !== undefined) && finalDir !== "root") {
      let targetDirectory;
      try {
        targetDirectory = await prisma.documentData.findFirst({
          where: {
            channelId: channelId,
            name: finalDir,
            isDirectory: true,
            status: 0,
          },
        });
      } catch (dbError) {
        logError("DB_DIR_FIND", dbError);
        return sendSystemMessage(ws, "디렉토리 조회 중 오류가 발생했습니다.");
      }

      if (!targetDirectory) {
        return sendSystemMessage(ws, `대상 디렉토리 '${finalDir}'가 존재하지 않습니다.`);
      }
    }

    // 경로/이름이 변경되는 경우 중복 체크
    if (
      finalName !== document.name ||
      finalDir !== document.dir ||
      finalDepth !== document.depth
    ) {
      let existingDoc;
      try {
        existingDoc = await prisma.documentData.findFirst({
          where: {
            channelId: channelId,
            name: finalName,
            dir: finalDir,
            depth: finalDepth,
            status: 0,
            NOT: { id: docId }, // 자기 자신 제외
          },
        });
      } catch (dbError) {
        logError("DB_DOC_FIND_DUP", dbError);
        return sendSystemMessage(ws, "문서 중복 확인 중 오류가 발생했습니다.");
      }

      if (existingDoc) {
        return sendSystemMessage(
          ws,
          `해당 경로에 '${finalName}' 이름의 문서가 이미 존재합니다.`,
        );
      }
    }

    // 문서 업데이트 (디렉토리인 경우 하위 항목들도 함께 업데이트)
    const depthDelta = finalDepth - document.depth;
    let updatedChildDocs = [];

    try {
      // 트랜잭션으로 처리
      await prisma.$transaction(async (tx) => {
        // 1. 현재 문서 업데이트
        await tx.documentData.update({
          where: { id: docId },
          data: {
            name: finalName,
            dir: finalDir,
            depth: finalDepth,
          },
        });

        // 2. 디렉토리인 경우 하위 항목들의 dir/depth 업데이트
        if (document.isDirectory) {
          const childDepth = document.depth + 1;
          const newChildDepth = finalDepth + 1;

          // 해당 디렉토리 내의 모든 직계 자식 항목
          const childDocs = await tx.documentData.findMany({
            where: {
              channelId: channelId,
              dir: document.name,
              depth: childDepth,
              status: 0,
            },
          });

          for (const child of childDocs) {
            await tx.documentData.update({
              where: { id: child.id },
              data: {
                dir: finalName, // 폴더 이름이 변경된 경우
                depth: newChildDepth,
              },
            });
            updatedChildDocs.push({
              id: child.id,
              name: child.name,
              oldDepth: child.depth,
              newDepth: newChildDepth,
              oldDir: child.dir,
              newDir: finalName,
            });

            // 이 자식이 디렉토리인 경우 재귀적으로 하위도 업데이트
            if (child.isDirectory) {
              await updateChildrenDepthRecursive(tx, channelId, child.name, newChildDepth + 1, depthDelta, updatedChildDocs);
            }
          }
        }
      });
    } catch (dbError) {
      logError("DB_DOC_UPDATE", dbError);
      if (dbError.code === "P2002") {
        return sendSystemMessage(
          ws,
          `해당 경로에 '${finalName}' 이름의 문서가 이미 존재합니다.`,
        );
      }
      return sendSystemMessage(
        ws,
        "문서 수정 중 데이터베이스 오류가 발생했습니다.",
      );
    }

    // 변경 내용 구성
    const changes = {};
    if (finalName !== document.name) {
      changes.name = { from: document.name, to: finalName };
    }
    if (finalDir !== document.dir) {
      changes.dir = { from: document.dir, to: finalDir };
    }
    if (finalDepth !== document.depth) {
      changes.depth = { from: document.depth, to: finalDepth };
    }
    if (updatedChildDocs.length > 0) {
      changes.childrenUpdated = updatedChildDocs.length;
    }

    // 채널 내 모든 유저에게 문서 변경 알림 (목록 새로고침 트리거)
    broadcastToChannel(
      channelId,
      "docUpdated",
      {
        time: Date.now(),
        docId: docId,
        channelId: channelId,
        oldName: document.name,
        oldDir: document.dir,
        oldDepth: document.depth,
        newName: finalName,
        newDir: finalDir,
        newDepth: finalDepth,
        changes: changes,
        updatedChildren: updatedChildDocs, // 하위 항목 변경 내역
        updatedBy: userId,
      },
      ws, // 자신에게는 별도로 전송
    );

    // 문서 열람 중인 유저들에게도 알림
    broadcastToDoc(
      docId,
      "docInfoChanged",
      {
        time: Date.now(),
        docId: docId,
        newName: finalName,
        newDir: finalDir,
        newDepth: finalDepth,
        changes: changes,
      },
      ws,
    );

    safeSend(ws, {
      event: "docUpdated",
      data: {
        time: Date.now(),
        docId: docId,
        channelId: channelId,
        oldName: document.name,
        oldDir: document.dir,
        oldDepth: document.depth,
        newName: finalName,
        newDir: finalDir,
        newDepth: finalDepth,
        changes: changes,
        updatedChildren: updatedChildDocs, // 하위 항목 변경 내역
        message: updatedChildDocs.length > 0 
          ? `문서가 수정되었습니다. (하위 ${updatedChildDocs.length}개 항목 업데이트)`
          : `문서가 수정되었습니다.`,
      },
    });

    console.log(
      `문서 수정: ${document.name} → ${finalName} (${docId}) in ${channelId} by ${userId}` +
      (updatedChildDocs.length > 0 ? ` (하위 ${updatedChildDocs.length}개 항목 depth 업데이트)` : ""),
    );
  } catch (error) {
    logError("DOC_UPDATE", error);
    sendSystemMessage(ws, "문서 수정 중 오류가 발생했습니다.");
  }
}

// === 채널/문서 유저 조회 핸들러 ===

// 채널 내 현재 접속 유저 조회
async function handleGetChannelUsers(ws, data) {
  const { channelId } = data;
  const userId = ws.user.id;

  // channelId 없으면 현재 채널
  const targetChannelId = channelId || ws.currentChannel;

  if (!targetChannelId) {
    return sendSystemMessage(ws, "채널 ID를 입력해주세요.");
  }

  try {
    // 멤버십 확인
    let membership;
    try {
      membership = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId: targetChannelId,
            userId: userId,
          },
        },
      });
    } catch (dbError) {
      logError("DB_MEMBER_FIND", dbError);
      return sendSystemMessage(ws, "멤버 조회 중 오류가 발생했습니다.");
    }

    if (!membership || membership.status !== 0) {
      return sendSystemMessage(ws, "해당 채널에 가입되어 있지 않습니다.");
    }

    const onlineUsers = getChannelUsers(targetChannelId);

    safeSend(ws, {
      event: "channelUsers",
      data: {
        time: Date.now(),
        channelId: targetChannelId,
        users: onlineUsers,
      },
    });
  } catch (error) {
    logError("GET_CHANNEL_USERS", error);
    sendSystemMessage(ws, "유저 목록 조회 중 오류가 발생했습니다.");
  }
}

// 문서 열람 중인 유저 조회
async function handleGetDocUsers(ws, data) {
  const { docId } = data;
  const userId = ws.user.id;

  // docId 없으면 현재 문서
  const targetDocId = docId || ws.currentDoc;

  if (!targetDocId) {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }

  // 채널 입장 상태 확인
  if (!ws.currentChannel) {
    return sendSystemMessage(ws, "먼저 채널에 입장해주세요.");
  }

  const viewingUsers = getDocUsers(targetDocId);

  safeSend(ws, {
    event: "docUsers",
    data: {
      time: Date.now(),
      docId: targetDocId,
      users: viewingUsers,
    },
  });
}

// === 문서 상태 조회 핸들러 ===

async function handleGetDocStatus(ws, data) {
  const { docId } = data;

  // docId 없으면 현재 문서
  const targetDocId = docId || ws.currentDoc;

  if (!targetDocId) {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }

  const doc = await getDocFromCache(targetDocId);

  if (!doc) {
    return sendSystemMessage(ws, "문서가 존재하지 않거나 캐시되지 않았습니다.");
  }

  safeSend(ws, {
    event: "docStatus",
    data: {
      time: Date.now(),
      docId: targetDocId,
      status: doc.status,
      statusText:
        doc.status === DOC_STATUS.NORMAL
          ? "normal"
          : doc.status === DOC_STATUS.DELETED
            ? "deleted"
            : "locked",
    },
  });
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
