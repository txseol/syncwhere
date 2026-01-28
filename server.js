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

// === 문서 버전 유틸리티 (서비스버전.스냅샷버전.로그버전) ===
const SERVICE_VERSION = "1"; // 현재 서비스 버전

// 버전 문자열 파싱 (예: "1.2.3" → { service: 1, snapshot: 2, log: 3 })
function parseVersion(versionStr) {
  const parts = (versionStr || "1.0.0").split(".");
  return {
    service: parseInt(parts[0]) || 1,
    snapshot: parseInt(parts[1]) || 0,
    log: parseInt(parts[2]) || 0,
  };
}

// 버전 객체를 문자열로 변환
function stringifyVersion(versionObj) {
  return `${versionObj.service}.${versionObj.snapshot}.${versionObj.log}`;
}

// 버전 비교 (-1: a < b, 0: a == b, 1: a > b)
function compareVersion(a, b) {
  const vA = typeof a === "string" ? parseVersion(a) : a;
  const vB = typeof b === "string" ? parseVersion(b) : b;

  if (vA.service !== vB.service) return vA.service > vB.service ? 1 : -1;
  if (vA.snapshot !== vB.snapshot) return vA.snapshot > vB.snapshot ? 1 : -1;
  if (vA.log !== vB.log) return vA.log > vB.log ? 1 : -1;
  return 0;
}

// 로그 버전 증가
function incrementLogVersion(versionStr) {
  const v = parseVersion(versionStr);
  v.log += 1;
  return stringifyVersion(v);
}

// 스냅샷 버전 증가 (로그 버전 리셋)
function incrementSnapshotVersion(versionStr) {
  const v = parseVersion(versionStr);
  v.snapshot += 1;
  v.log = 0;
  return stringifyVersion(v);
}

// 초기 버전 생성
function createInitialVersion() {
  return `${SERVICE_VERSION}.0.0`;
}

// === LSEQ ID 유틸리티 (청크 기반 CRDT 구현) ===
// 
// ## 핵심 개념
// - 청크(Chunk): { id: string, text: string } - 연속 문자열에 단일 ID
// - ID는 LSEQ 알고리즘으로 생성 (정렬 가능한 문자열)
// - 모든 연산은 로그로 기록되어 재생 가능 (CRDT 정합성)
//
// ## 연산 종류
// 1. insert: 두 청크 사이에 새 청크 삽입
// 2. split: 청크 내부 삽입 시 청크를 분할
// 3. delete: 청크 삭제
// 4. update: 청크 텍스트 수정 (부분 삭제)
//
// ## 로그 포맷 (재생 가능)
// - { op: "insert", id, text, leftId, rightId }
// - { op: "split", targetId, offset, leftText, rightId, rightText, insertId?, insertText? }
// - { op: "delete", id }
// - { op: "update", id, text }

const LSEQ_MIN = 1;
const LSEQ_MAX = 65535;
const LSEQ_MID = 32768;
const LSEQ_PAD = 5;

// ===============================
// LSEQ ID 변환 유틸
// ===============================

// 정수 배열 → 문자열 ID (저장/정렬용)
function lseqToString(arr) {
  return arr.map((n) => String(n).padStart(LSEQ_PAD, "0")).join(".");
}

// 문자열 ID → 정수 배열
function stringToLseq(str) {
  if (!str) return [];
  return str.split(".").map((s) => parseInt(s, 10));
}

// ===============================
// LSEQ 비교 (prefix rule 포함)
// ===============================
function compareLseq(a, b) {
  const A = typeof a === "string" ? stringToLseq(a) : a;
  const B = typeof b === "string" ? stringToLseq(b) : b;

  const minLen = Math.min(A.length, B.length);

  for (let i = 0; i < minLen; i++) {
    if (A[i] < B[i]) return -1;
    if (A[i] > B[i]) return 1;
  }

  if (A.length < B.length) return -1;
  if (A.length > B.length) return 1;
  return 0;
}

// ===============================
// 두 ID 사이 새 LSEQ 생성
// ===============================
function generateLseqBetween(leftId, rightId) {
  const left = leftId ? stringToLseq(leftId) : [];
  const right = rightId ? stringToLseq(rightId) : [];

  const result = [];
  let depth = 0;

  while (true) {
    const l = left[depth] ?? 0;
    const r = right[depth] ?? LSEQ_MAX + 1;

    if (r - l > 1) {
      const value = l + 1 + Math.floor(Math.random() * (r - l - 1));
      result.push(value);
      break;
    }

    result.push(l);
    depth++;
  }

  return lseqToString(result);
}

// 초기 ID 생성
function generateInitialLseq() {
  return lseqToString([LSEQ_MID]);
}

// ===============================
// 청크(Chunk) 배열 유틸
// ===============================
// 청크 구조: { id: string, text: string }

// 청크 배열에서 ID로 인덱스 찾기 (이진 탐색)
function findChunkIndex(chunks, id) {
  if (!id || !chunks || chunks.length === 0) return -1;
  
  let lo = 0;
  let hi = chunks.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const cmp = compareLseq(chunks[mid].id, id);

    if (cmp === 0) return mid;
    if (cmp < 0) lo = mid + 1;
    else hi = mid - 1;
  }

  return -1;
}

// 청크 삽입 위치 찾기 (정렬 유지)
function findChunkInsertPos(chunks, id) {
  let lo = 0;
  let hi = chunks.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareLseq(chunks[mid].id, id) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  return lo;
}

// 청크 배열에 새 청크 삽입 (정렬 유지, 중복 방지)
function insertChunk(chunks, chunk) {
  const pos = findChunkInsertPos(chunks, chunk.id);
  
  // 중복 ID 검사
  if (pos < chunks.length && compareLseq(chunks[pos].id, chunk.id) === 0) {
    console.warn(`[CRDT] 중복 청크 ID 무시: ${chunk.id}`);
    return -1;
  }
  
  chunks.splice(pos, 0, chunk);
  return pos;
}

// 청크 배열을 content 문자열로 변환
function chunksToContent(chunks) {
  return chunks.map(c => c.text).join("");
}

// 전체 문자 위치(offset)에서 청크 인덱스와 청크 내 오프셋 찾기
function findChunkByOffset(chunks, globalOffset) {
  let currentPos = 0;
  
  for (let i = 0; i < chunks.length; i++) {
    const chunkLen = chunks[i].text.length;
    
    if (globalOffset < currentPos + chunkLen) {
      return { 
        chunkIndex: i, 
        chunk: chunks[i],
        localOffset: globalOffset - currentPos 
      };
    }
    currentPos += chunkLen;
  }
  
  // 문서 끝 (마지막 청크 뒤)
  return { 
    chunkIndex: chunks.length, 
    chunk: null,
    localOffset: 0 
  };
}

// leftId와 rightId 사이에 청크가 있는지 확인하고 경계 청크 반환
function getInsertBoundary(chunks, leftId, rightId) {
  let leftIdx = -1;
  let rightIdx = chunks.length;
  
  if (leftId) {
    leftIdx = findChunkIndex(chunks, leftId);
  }
  if (rightId) {
    rightIdx = findChunkIndex(chunks, rightId);
    if (rightIdx === -1) rightIdx = chunks.length;
  }
  
  return { leftIdx, rightIdx };
}

// ===============================
// 구버전 호환: chars ↔ chunks 변환
// ===============================

// chars 배열 (단일 문자)를 chunks 배열로 변환
// 연속된 ID prefix를 가진 문자들을 하나의 청크로 병합하지 않음 (정확성 우선)
function charsToChunks(chars) {
  if (!chars || chars.length === 0) return [];
  
  // 이미 청크 형태면 그대로 반환
  if (chars[0]?.text !== undefined) {
    return chars;
  }
  
  // 각 문자를 개별 청크로 변환 (안전한 변환)
  return chars.map(c => ({
    id: c.id,
    text: c.char || ""
  })).filter(c => c.text.length > 0);
}

// chunks 배열을 chars 배열로 변환 (클라이언트 호환용)
function chunksToChars(chunks) {
  const chars = [];
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.text.length; i++) {
      chars.push({
        id: i === 0 ? chunk.id : `${chunk.id}:${i}`,
        char: chunk.text[i]
      });
    }
  }
  return chars;
}

// chars 배열을 content 문자열로 변환
function charsToContent(chars) {
  if (!chars || chars.length === 0) return "";
  if (chars[0]?.text !== undefined) {
    return chunksToContent(chars);
  }
  return chars.map(c => c.char || c.text || "").join("");
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

// ===================================================
// 청크 기반 CRDT 문서 연산 함수
// ===================================================
// 
// ## 핵심 원칙
// 1. 대량 텍스트는 단일 청크로 저장 (효율성)
// 2. 청크 내부 삽입 시 청크 분할 (정합성)
// 3. 모든 연산은 로그로 기록 (재생 가능)
// 4. 스냅샷 + 로그 재생 = 동일한 결과 (CRDT)
//
// ## 청크 구조
// { id: string, text: string }
//
// ## 로그 연산
// - insert: 새 청크 삽입
// - split: 청크 분할 (내부 삽입 시)
// - delete: 청크 삭제
// - update: 청크 텍스트 수정

// 문서에 텍스트 삽입 (청크 방식)
// leftId: 삽입 위치 왼쪽 청크 ID (null이면 맨 앞)
// rightId: 삽입 위치 오른쪽 청크 ID (null이면 맨 뒤)
// text: 삽입할 텍스트
async function insertTextToDoc(docId, leftId, rightId, text, userId) {
  return await safeRedis(async () => {
    const doc = await getDocFromCache(docId);
    if (!doc) return null;
    if (doc.status !== DOC_STATUS.NORMAL) return null;

    // chunks 배열 가져오기 (구버전 호환)
    let chunks = doc.chunks || charsToChunks(doc.chars) || [];

    // 새 LSEQ ID 생성
    const newId = generateLseqBetween(leftId, rightId);

    // 새 청크 삽입
    const newChunk = { id: newId, text: text };
    const insertPos = insertChunk(chunks, newChunk);
    
    if (insertPos === -1) {
      console.error(`[CRDT] 청크 삽입 실패: ${newId}`);
      return null;
    }

    // 로그 기록 (재생 가능)
    const logEntry = {
      op: "insert",
      id: newId,
      text: text,
      leftId: leftId,
      rightId: rightId,
      userId: userId,
      timestamp: Date.now(),
    };
    const logs = doc.logMetadata || [];
    logs.push(logEntry);

    // 버전 증가
    const newVersion = incrementLogVersion(doc.snapshotVersion);

    // content 재생성
    const newContent = chunksToContent(chunks);

    const updated = {
      ...doc,
      chunks: chunks,
      chars: chunksToChars(chunks), // 클라이언트 호환
      content: newContent,
      logMetadata: logs,
      snapshotVersion: newVersion,
      updatedAt: new Date().toISOString(),
    };

    await setDocToCache(docId, updated);

    return {
      newVersion,
      newId,
      text: text,
      content: newContent,
    };
  }, null);
}

// 청크 내부에 텍스트 삽입 (청크 분할)
// targetId: 분할할 청크 ID
// offset: 분할 위치 (0-based, 이 위치 앞에서 분할)
// text: 삽입할 텍스트
async function splitAndInsert(docId, targetId, offset, text, userId) {
  return await safeRedis(async () => {
    const doc = await getDocFromCache(docId);
    if (!doc) return null;
    if (doc.status !== DOC_STATUS.NORMAL) return null;

    let chunks = doc.chunks || charsToChunks(doc.chars) || [];
    const targetIdx = findChunkIndex(chunks, targetId);

    if (targetIdx === -1) {
      console.error(`[CRDT] 분할 대상 청크 없음: ${targetId}`);
      return null;
    }

    const targetChunk = chunks[targetIdx];
    const originalText = targetChunk.text;

    // 오프셋 유효성 검사
    if (offset < 0 || offset > originalText.length) {
      console.error(`[CRDT] 잘못된 오프셋: ${offset} (길이: ${originalText.length})`);
      return null;
    }

    // 분할 텍스트
    const leftText = originalText.substring(0, offset);
    const rightText = originalText.substring(offset);

    // 새 ID 생성
    // - 왼쪽 청크: 기존 ID 유지
    // - 삽입 청크: 기존 ID와 다음 청크 사이
    // - 오른쪽 청크: 삽입 청크와 다음 청크 사이
    const nextChunk = chunks[targetIdx + 1];
    const nextId = nextChunk ? nextChunk.id : null;
    
    const insertId = generateLseqBetween(targetId, nextId);
    const rightId = generateLseqBetween(insertId, nextId);

    // 기존 청크 제거
    chunks.splice(targetIdx, 1);

    // 새 청크들 삽입 (ID 순서대로)
    const newChunks = [];
    
    if (leftText.length > 0) {
      newChunks.push({ id: targetId, text: leftText }); // 기존 ID 유지
    }
    
    newChunks.push({ id: insertId, text: text }); // 삽입할 텍스트
    
    if (rightText.length > 0) {
      newChunks.push({ id: rightId, text: rightText }); // 새 ID
    }

    // 청크 삽입 (정렬 유지)
    for (const chunk of newChunks) {
      insertChunk(chunks, chunk);
    }

    // 로그 기록 (재생 가능)
    const logEntry = {
      op: "split",
      targetId: targetId,
      offset: offset,
      originalText: originalText,
      leftText: leftText,
      insertId: insertId,
      insertText: text,
      rightId: rightText.length > 0 ? rightId : null,
      rightText: rightText,
      userId: userId,
      timestamp: Date.now(),
    };
    const logs = doc.logMetadata || [];
    logs.push(logEntry);

    // 버전 증가
    const newVersion = incrementLogVersion(doc.snapshotVersion);

    // content 재생성
    const newContent = chunksToContent(chunks);

    const updated = {
      ...doc,
      chunks: chunks,
      chars: chunksToChars(chunks),
      content: newContent,
      logMetadata: logs,
      snapshotVersion: newVersion,
      updatedAt: new Date().toISOString(),
    };

    await setDocToCache(docId, updated);

    return {
      newVersion,
      newId: insertId,
      text: text,
      splitResult: newChunks,
      content: newContent,
    };
  }, null);
}

// 청크 삭제
async function deleteChunk(docId, chunkId, userId) {
  return await safeRedis(async () => {
    const doc = await getDocFromCache(docId);
    if (!doc) return null;
    if (doc.status !== DOC_STATUS.NORMAL) return null;

    let chunks = doc.chunks || charsToChunks(doc.chars) || [];
    const chunkIdx = findChunkIndex(chunks, chunkId);

    if (chunkIdx === -1) {
      return { alreadyDeleted: true };
    }

    const deletedChunk = chunks[chunkIdx];
    chunks.splice(chunkIdx, 1);

    // 로그 기록
    const logEntry = {
      op: "delete",
      id: chunkId,
      text: deletedChunk.text,
      userId: userId,
      timestamp: Date.now(),
    };
    const logs = doc.logMetadata || [];
    logs.push(logEntry);

    // 버전 증가
    const newVersion = incrementLogVersion(doc.snapshotVersion);

    // content 재생성
    const newContent = chunksToContent(chunks);

    const updated = {
      ...doc,
      chunks: chunks,
      chars: chunksToChars(chunks),
      content: newContent,
      logMetadata: logs,
      snapshotVersion: newVersion,
      updatedAt: new Date().toISOString(),
    };

    await setDocToCache(docId, updated);

    return {
      newVersion,
      deletedId: chunkId,
      deletedText: deletedChunk.text,
      content: newContent,
    };
  }, null);
}

// 청크 텍스트 부분 삭제 (trim)
// startOffset: 삭제 시작 위치
// endOffset: 삭제 끝 위치 (exclusive)
async function trimChunk(docId, chunkId, startOffset, endOffset, userId) {
  return await safeRedis(async () => {
    const doc = await getDocFromCache(docId);
    if (!doc) return null;
    if (doc.status !== DOC_STATUS.NORMAL) return null;

    let chunks = doc.chunks || charsToChunks(doc.chars) || [];
    const chunkIdx = findChunkIndex(chunks, chunkId);

    if (chunkIdx === -1) {
      return { alreadyDeleted: true };
    }

    const chunk = chunks[chunkIdx];
    const originalText = chunk.text;
    const deletedText = originalText.substring(startOffset, endOffset);
    const newText = originalText.substring(0, startOffset) + originalText.substring(endOffset);

    if (newText.length === 0) {
      // 전체 삭제 → 청크 제거
      chunks.splice(chunkIdx, 1);
    } else {
      // 부분 삭제 → 텍스트 수정
      chunk.text = newText;
    }

    // 로그 기록
    const logEntry = {
      op: "trim",
      id: chunkId,
      startOffset: startOffset,
      endOffset: endOffset,
      deletedText: deletedText,
      newText: newText,
      userId: userId,
      timestamp: Date.now(),
    };
    const logs = doc.logMetadata || [];
    logs.push(logEntry);

    // 버전 증가
    const newVersion = incrementLogVersion(doc.snapshotVersion);

    // content 재생성
    const newContent = chunksToContent(chunks);

    const updated = {
      ...doc,
      chunks: chunks,
      chars: chunksToChars(chunks),
      content: newContent,
      logMetadata: logs,
      snapshotVersion: newVersion,
      updatedAt: new Date().toISOString(),
    };

    await setDocToCache(docId, updated);

    return {
      newVersion,
      chunkId: chunkId,
      deletedText: deletedText,
      remainingText: newText,
      content: newContent,
    };
  }, null);
}

// ===================================================
// 로그 재생 함수 (CRDT 정합성 보장)
// ===================================================
// 스냅샷에 로그를 순차적으로 적용하여 상태 복구

function applyLogEntry(chunks, entry) {
  switch (entry.op) {
    case "insert": {
      // 새 청크 삽입
      const newChunk = { id: entry.id, text: entry.text };
      insertChunk(chunks, newChunk);
      break;
    }
    
    case "split": {
      // 청크 분할
      const targetIdx = findChunkIndex(chunks, entry.targetId);
      if (targetIdx !== -1) {
        chunks.splice(targetIdx, 1);
        
        if (entry.leftText && entry.leftText.length > 0) {
          insertChunk(chunks, { id: entry.targetId, text: entry.leftText });
        }
        insertChunk(chunks, { id: entry.insertId, text: entry.insertText });
        if (entry.rightId && entry.rightText && entry.rightText.length > 0) {
          insertChunk(chunks, { id: entry.rightId, text: entry.rightText });
        }
      }
      break;
    }
    
    case "delete": {
      // 청크 삭제
      const idx = findChunkIndex(chunks, entry.id);
      if (idx !== -1) {
        chunks.splice(idx, 1);
      }
      break;
    }
    
    case "trim": {
      // 청크 텍스트 수정
      const idx = findChunkIndex(chunks, entry.id);
      if (idx !== -1) {
        if (entry.newText.length === 0) {
          chunks.splice(idx, 1);
        } else {
          chunks[idx].text = entry.newText;
        }
      }
      break;
    }
    
    default:
      console.warn(`[CRDT] 알 수 없는 로그 연산: ${entry.op}`);
  }
  
  return chunks;
}

// 스냅샷에 로그 배열 적용
function applyLogs(snapshotChunks, logs) {
  let chunks = JSON.parse(JSON.stringify(snapshotChunks)); // 깊은 복사
  
  for (const entry of logs) {
    chunks = applyLogEntry(chunks, entry);
  }
  
  return chunks;
}

// ===================================================
// 호환용 래퍼 함수
// ===================================================

// 구버전 호환: 단일 문자 삽입
async function insertCharToDoc(docId, leftId, rightId, value, userId) {
  return await insertTextToDoc(docId, leftId, rightId, value, userId);
}

// 구버전 호환: 단일 문자/청크 삭제
async function deleteCharFromDoc(docId, charId, userId) {
  // charId가 가상 ID (chunkId:offset)인지 확인
  if (charId && charId.includes(":")) {
    const [chunkId, offsetStr] = charId.split(":");
    const offset = parseInt(offsetStr, 10);
    // 해당 위치의 한 글자만 삭제
    return await trimChunk(docId, chunkId, offset, offset + 1, userId);
  }
  // 일반 청크 ID인 경우 전체 삭제
  return await deleteChunk(docId, charId, userId);
}

// 여러 문자 삭제
async function deleteCharsFromDoc(docId, charIds, userId) {
  let lastResult = null;
  
  for (const charId of charIds) {
    const result = await deleteCharFromDoc(docId, charId, userId);
    if (result && !result.alreadyDeleted) {
      lastResult = result;
    }
  }
  
  return lastResult || { alreadyDeleted: true };
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

// Redis 캐시를 Supabase로 동기화 (청크 기반)
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
      select: { snapshotVersion: true, status: true },
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

    // 버전 비교: Redis > Supabase인 경우에만 동기화
    if (compareVersion(cachedDoc.snapshotVersion, dbDoc.snapshotVersion) > 0) {
      // chunks 배열에서 순수 데이터만 추출 (id, text만)
      const chunks = cachedDoc.chunks || [];
      const chunksToSave = chunks.map((c) => ({
        id: c.id,
        text: c.text,
      }));

      await prisma.documentData.update({
        where: { id: docId },
        data: {
          content: cachedDoc.content,
          charsData: chunksToSave, // chunks 배열 저장 (청크 기반)
          logMetadata: cachedDoc.logMetadata || [],
          snapshotVersion: cachedDoc.snapshotVersion,
        },
      });
      console.log(
        `[CRDT] 동기화 완료: ${docId} (${dbDoc.snapshotVersion} → ${cachedDoc.snapshotVersion}) ${chunks.length} chunks`,
      );
      return true;
    }

    console.log(`동기화 스킵 (버전 동일/낮음): ${docId}`);
    return false;
  } catch (error) {
    logError("DOC_SYNC", error);
    return false;
  }
}

// Supabase에서 문서를 Redis 캐시로 로드 (청크 기반)
async function loadDocToCache(docId) {
  try {
    const doc = await prisma.documentData.findUnique({
      where: { id: docId },
      select: {
        id: true,
        channelId: true,
        name: true,
        content: true,
        charsData: true, // LSEQ chunks/chars 배열
        logMetadata: true,
        snapshotVersion: true,
        status: true,
        dir: true,
        depth: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!doc) return null;

    // chunks 배열 복원
    let chunks = [];

    // 1순위: charsData 컬럼에서 복원
    if (Array.isArray(doc.charsData) && doc.charsData.length > 0) {
      const firstItem = doc.charsData[0];
      
      // 청크 형태 (text 필드 존재)
      if (firstItem?.id && firstItem?.text !== undefined) {
        chunks = doc.charsData;
      }
      // chars 형태 (char 필드 존재) → 청크로 변환
      else if (firstItem?.id && firstItem?.char !== undefined) {
        chunks = charsToChunks(doc.charsData);
      }
    }
    // 2순위: 구버전 호환 - logMetadata에서 복원
    else if (
      Array.isArray(doc.logMetadata) &&
      doc.logMetadata.length > 0 &&
      doc.logMetadata[0]?.id
    ) {
      chunks = charsToChunks(doc.logMetadata);
    }
    // 3순위: content에서 청크 생성 (마이그레이션)
    else if (doc.content && doc.content.length > 0) {
      // 전체 content를 하나의 청크로 생성
      const initialId = generateInitialLseq();
      chunks = [{ id: initialId, text: doc.content }];
    }

    const cacheData = {
      id: doc.id,
      channelId: doc.channelId,
      name: doc.name,
      content: doc.content || chunksToContent(chunks),
      chunks: chunks, // LSEQ chunks 배열
      chars: chunksToChars(chunks), // 클라이언트 호환용
      logMetadata: [], // 로그는 비움 (캐시에서는 chunks로 관리)
      snapshotVersion: doc.snapshotVersion,
      status: doc.status,
      dir: doc.dir,
      depth: doc.depth,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };

    await setDocToCache(docId, cacheData);
    console.log(`[CRDT] 캐시 로드: ${docId} (${chunks.length} chunks)`);
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

// === 스냅샷 생성 함수 ===
// 스냅샷 생성 함수 (청크 기반)
// 로그를 스냅샷으로 병합하고 새 버전 생성
async function createSnapshot(docId) {
  try {
    // 1. Redis 캐시에서 최신 문서 조회
    const cachedDoc = await getDocFromCache(docId);
    if (!cachedDoc) {
      throw new Error("캐시된 문서가 없습니다.");
    }

    // 2. chunks에서 순수 스냅샷 데이터 생성 (id, text만 유지)
    const chunks = cachedDoc.chunks || [];
    const snapshotChunks = chunks.map((c) => ({ id: c.id, text: c.text }));
    const content = chunksToContent(chunks);

    // 3. 새 버전 생성
    const newSnapshotVersion = incrementSnapshotVersion(
      cachedDoc.snapshotVersion,
    );

    // 4. Supabase 업데이트 (charsData에 chunks 저장, 로그 초기화)
    const updated = await prisma.documentData.update({
      where: { id: docId },
      data: {
        content: content,
        charsData: snapshotChunks, // chunks 배열 저장
        logMetadata: [], // 로그 초기화
        snapshotVersion: newSnapshotVersion,
        lastSnapshotAt: new Date(),
      },
    });

    // 5. Redis 캐시 갱신 (로그 비움)
    const cacheData = {
      id: updated.id,
      channelId: updated.channelId,
      name: updated.name,
      content: content,
      chunks: snapshotChunks, // 스냅샷 chunks
      chars: chunksToChars(snapshotChunks), // 클라이언트 호환
      logMetadata: [], // 로그 초기화
      snapshotVersion: newSnapshotVersion,
      status: updated.status,
      dir: updated.dir,
      depth: updated.depth,
      createdBy: updated.createdBy,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };

    await setDocToCache(docId, cacheData);

    console.log(
      `[CRDT] 스냅샷 생성: ${docId} (v${newSnapshotVersion}, ${snapshotChunks.length} chunks)`,
    );
    return { snapshotVersion: newSnapshotVersion, doc: cacheData };
  } catch (error) {
    logError("CREATE_SNAPSHOT", error);
    throw error;
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

            // === 문서 편집 관련 이벤트 ===
            // 문서 편집 (LSEQ - 단일 문자)
            case "editDoc":
              await handleEditDoc(ws, data);
              break;

            // 문서 편집 (LSEQ - 여러 문자 batch)
            case "editDocBatch":
              await handleEditDocBatch(ws, data);
              break;

            // 문서 동기화 요청 (오너만)
            case "syncDoc":
              await handleSyncDoc(ws, data);
              break;

            // 스냅샷 생성 요청 (오너만)
            case "snapshotDoc":
              await handleSnapshotDoc(ws, data);
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
      return sendSystemMessage(ws, "문서 생성 권한이 없습니다.");
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

    // 초기 버전 생성
    const initialVersion = createInitialVersion();

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
          snapshotVersion: initialVersion, // "1.0.0" 형식
          permission: 0, // 채널 멤버 전체 편집 가능
          status: DOC_STATUS.NORMAL,
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

    // 채널 내 모든 유저에게 문서 생성 알림 (목록 새로고침 트리거)
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
        createdBy: userId,
      },
      ws, // 자신에게는 별도로 전송
    );

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
          createdAt: true,
          snapshotVersion: true,
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
          createdAt: d.createdAt.toISOString(),
          snapshotVersion: d.snapshotVersion,
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
        content: document.content,
        chars: document.chars || [], // LSEQ chars 배열 (id, char)
        snapshotVersion: document.snapshotVersion,
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
    if (typeof newDir !== "string" || newDir.length > 100) {
      return sendSystemMessage(ws, "디렉토리명이 올바르지 않습니다.");
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

    // 최종 경로 계산 (변경되지 않는 값은 기존값 유지)
    const finalName = newName !== undefined ? newName : document.name;
    const finalDir = newDir !== undefined ? newDir : document.dir;
    const finalDepth = newDepth !== undefined ? newDepth : document.depth;

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

    // 문서 업데이트
    let updatedDoc;
    try {
      updatedDoc = await prisma.documentData.update({
        where: { id: docId },
        data: {
          name: finalName,
          dir: finalDir,
          depth: finalDepth,
        },
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
    if (newName !== undefined && newName !== document.name) {
      changes.name = { from: document.name, to: newName };
    }
    if (newDir !== undefined && newDir !== document.dir) {
      changes.dir = { from: document.dir, to: newDir };
    }
    if (newDepth !== undefined && newDepth !== document.depth) {
      changes.depth = { from: document.depth, to: newDepth };
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
        message: `문서가 수정되었습니다.`,
      },
    });

    console.log(
      `문서 수정: ${document.name} → ${finalName} (${docId}) in ${channelId} by ${userId}`,
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

// === 문서 편집 핸들러 (CRDT 로그 추가) ===

// === LSEQ 문서 편집 핸들러 ===
// 클라이언트는 의도(intent)만 전송, 서버가 ID 생성
// insert: { intent: "insert", leftId, rightId, value }
// delete: { intent: "delete", id }
async function handleEditDoc(ws, data) {
  const { docId, intent, leftId, rightId, id, value } = data;
  const userId = ws.user.id;

  // 필수값 검증
  if (!docId || typeof docId !== "string") {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }
  if (!intent || !["insert", "delete"].includes(intent)) {
    return sendSystemMessage(
      ws,
      "유효한 편집 의도가 필요합니다 (insert/delete).",
    );
  }

  // 현재 문서를 열람 중인지 확인
  if (ws.currentDoc !== docId) {
    return sendSystemMessage(ws, "해당 문서를 열람하고 있지 않습니다.");
  }

  try {
    // 문서 편집 가능 상태 확인
    const editable = await isDocEditable(docId);
    if (!editable) {
      return safeSend(ws, {
        event: "editRejected",
        data: {
          time: Date.now(),
          docId: docId,
          reason: "문서가 잠겨있어 편집할 수 없습니다.",
        },
      });
    }

    if (intent === "insert") {
      // === INSERT 작업 ===
      if (typeof value !== "string" || value.length !== 1) {
        return sendSystemMessage(ws, "삽입할 문자를 지정해주세요 (1글자).");
      }

      // Redis에 삽입 (서버가 ID 생성)
      const result = await insertCharToDoc(
        docId,
        leftId || null,
        rightId || null,
        value,
        userId,
      );
      if (!result) {
        return sendSystemMessage(ws, "문자 삽입에 실패했습니다.");
      }

      // 모든 문서 열람자에게 브로드캐스트 (자신 포함)
      broadcastToDoc(docId, "docOp", {
        time: Date.now(),
        docId: docId,
        op: "insert",
        id: result.newId,
        char: value,
        editedBy: userId,
        logVersion: result.newVersion,
      });

      console.log(
        `LSEQ 삽입: ${docId} id=${result.newId} char='${value}' by ${userId}`,
      );
    } else if (intent === "delete") {
      // === DELETE 작업 ===
      if (!id || typeof id !== "string") {
        return sendSystemMessage(ws, "삭제할 문자의 ID를 지정해주세요.");
      }

      // Redis에서 삭제
      const result = await deleteCharFromDoc(docId, id, userId);
      if (!result) {
        return sendSystemMessage(ws, "문자 삭제에 실패했습니다.");
      }

      if (result.alreadyDeleted) {
        // 이미 삭제된 문자 (중복 삭제 요청) - 무시하고 성공 처리
        console.log(`LSEQ 삭제 무시: ${docId} id=${id} (이미 없음)`);
        return;
      }

      // 모든 문서 열람자에게 브로드캐스트 (자신 포함)
      broadcastToDoc(docId, "docOp", {
        time: Date.now(),
        docId: docId,
        op: "delete",
        id: id,
        editedBy: userId,
        logVersion: result.newVersion,
      });

      console.log(`LSEQ 삭제: ${docId} id=${id} by ${userId}`);
    }
  } catch (error) {
    logError("DOC_EDIT_LSEQ", error);
    sendSystemMessage(ws, "문서 편집 중 오류가 발생했습니다.");
  }
}

// === Batch 편집 핸들러 ===
// 여러 문자를 한번에 처리
// 지원 작업:
// - insertText: { intent: "insertText", leftId, rightId, text } - 텍스트 삽입
// ===================================================
// 청크 기반 Batch 편집 핸들러
// ===================================================
// 
// ## 지원 연산
// 1. 텍스트 삽입 (대량): text + leftId + rightId → 단일 청크로 삽입
// 2. 청크 내부 삽입: targetId + offset + text → 청크 분할 후 삽입
// 3. 청크 삭제: id → 청크 전체 삭제
// 4. 부분 삭제: id + startOffset + endOffset → 청크 텍스트 수정
//
// ## 클라이언트 요청 포맷
// - 대량 삽입: { text, leftId, rightId }
// - 내부 삽입: { text, targetId, offset }
// - operations 배열: [{ intent, ... }, ...]
//
async function handleEditDocBatch(ws, data) {
  const { docId, text: batchText, targetId, offset, leftId, rightId, operations } = data;
  const userId = ws.user.id;

  // 필수값 검증
  if (!docId || typeof docId !== "string") {
    return sendSystemMessage(ws, "문서 ID를 입력해주세요.");
  }

  // 현재 문서를 열람 중인지 확인
  if (ws.currentDoc !== docId) {
    return sendSystemMessage(ws, "해당 문서를 열람하고 있지 않습니다.");
  }

  try {
    // 문서 편집 가능 상태 확인
    const editable = await isDocEditable(docId);
    if (!editable) {
      return safeSend(ws, {
        event: "editRejected",
        data: {
          time: Date.now(),
          docId: docId,
          reason: "문서가 잠겨있어 편집할 수 없습니다.",
        },
      });
    }

    // ===================================================
    // 케이스 1: 청크 내부 삽입 (분할)
    // ===================================================
    if (batchText && targetId && typeof offset === "number") {
      const result = await splitAndInsert(
        docId,
        targetId,
        offset,
        batchText,
        userId,
      );

      if (!result) {
        return sendSystemMessage(ws, "텍스트 삽입에 실패했습니다.");
      }

      // 브로드캐스트: 분할 결과
      broadcastToDoc(docId, "docOpBatch", {
        time: Date.now(),
        docId: docId,
        operations: [{
          op: "split",
          targetId: targetId,
          offset: offset,
          insertId: result.newId,
          insertText: batchText,
          splitResult: result.splitResult,
        }],
        editedBy: userId,
        logVersion: result.newVersion,
      });

      console.log(`[CRDT] 청크 분할 삽입: ${docId} target=${targetId} offset=${offset} len=${batchText.length}`);
      return;
    }

    // ===================================================
    // 케이스 2: 청크 사이 삽입 (대량 텍스트)
    // ===================================================
    if (batchText && typeof batchText === "string" && batchText.length > 0) {
      const result = await insertTextToDoc(
        docId,
        leftId || null,
        rightId || null,
        batchText,
        userId,
      );

      if (!result) {
        return sendSystemMessage(ws, "텍스트 삽입에 실패했습니다.");
      }

      // 브로드캐스트: 단일 청크 삽입
      broadcastToDoc(docId, "docOpBatch", {
        time: Date.now(),
        docId: docId,
        operations: [{
          op: "insert",
          id: result.newId,
          text: batchText,
          leftId: leftId || null,
          rightId: rightId || null,
        }],
        editedBy: userId,
        logVersion: result.newVersion,
      });

      console.log(`[CRDT] 청크 삽입: ${docId} id=${result.newId} len=${batchText.length}`);
      return;
    }

    // ===================================================
    // 케이스 3: operations 배열 처리
    // ===================================================
    if (!Array.isArray(operations) || operations.length === 0) {
      return sendSystemMessage(ws, "편집 작업 목록이 필요합니다.");
    }

    const results = [];
    let lastVersion = null;
    const tempIdMap = new Map(); // temp_N → 실제 ID 매핑

    // 임시 ID 해석
    const resolveTempId = (id) => {
      if (!id) return null;
      const match = id.match(/^temp_(\d+)$/);
      if (match) {
        return tempIdMap.get(parseInt(match[1], 10)) || null;
      }
      return id;
    };

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];

      if (op.intent === "insert" || op.intent === "insertText") {
        // 텍스트 삽입
        const text = op.text || op.value;
        if (!text || text.length === 0) continue;

        const resolvedLeftId = resolveTempId(op.leftId);
        const resolvedRightId = resolveTempId(op.rightId);

        let result;
        
        // 청크 내부 삽입인 경우
        if (op.targetId && typeof op.offset === "number") {
          result = await splitAndInsert(
            docId,
            resolveTempId(op.targetId),
            op.offset,
            text,
            userId,
          );
        } else {
          // 청크 사이 삽입
          result = await insertTextToDoc(
            docId,
            resolvedLeftId,
            resolvedRightId,
            text,
            userId,
          );
        }

        if (result) {
          tempIdMap.set(i, result.newId);
          results.push({
            op: op.targetId ? "split" : "insert",
            id: result.newId,
            text: text,
            splitResult: result.splitResult,
          });
          lastVersion = result.newVersion;
        }

      } else if (op.intent === "delete") {
        // 삭제
        const resolvedId = resolveTempId(op.id);
        if (!resolvedId) continue;

        let result;
        
        // 부분 삭제인 경우
        if (typeof op.startOffset === "number" && typeof op.endOffset === "number") {
          result = await trimChunk(docId, resolvedId, op.startOffset, op.endOffset, userId);
        } else {
          // 전체 삭제
          result = await deleteChunk(docId, resolvedId, userId);
        }

        if (result && !result.alreadyDeleted) {
          results.push({
            op: "delete",
            id: resolvedId,
            text: result.deletedText,
          });
          lastVersion = result.newVersion;
        }

      } else if (op.intent === "deleteRange") {
        // 여러 청크 삭제
        for (const delId of (op.ids || [])) {
          const resolvedId = resolveTempId(delId);
          if (!resolvedId) continue;

          const result = await deleteChunk(docId, resolvedId, userId);
          if (result && !result.alreadyDeleted) {
            results.push({
              op: "delete",
              id: resolvedId,
              text: result.deletedText,
            });
            lastVersion = result.newVersion;
          }
        }
      }
    }

    if (results.length === 0) {
      return sendSystemMessage(ws, "처리된 작업이 없습니다.");
    }

    // 브로드캐스트
    broadcastToDoc(docId, "docOpBatch", {
      time: Date.now(),
      docId: docId,
      operations: results,
      editedBy: userId,
      logVersion: lastVersion,
    });

    console.log(`[CRDT] Batch: ${docId} ${results.length}개 작업`);

  } catch (error) {
    logError("DOC_EDIT_BATCH", error);
    sendSystemMessage(ws, "문서 편집 중 오류가 발생했습니다.");
  }
}

// === 문서 동기화 핸들러 (오너만 - Redis → Supabase) ===

async function handleSyncDoc(ws, data) {
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
    // 채널 멤버십 및 권한 확인
    let membership;
    try {
      membership = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId: channelId,
            userId: userId,
          },
        },
      });
    } catch (dbError) {
      logError("DB_MEMBER_FIND", dbError);
      return sendSystemMessage(ws, "권한 확인 중 오류가 발생했습니다.");
    }

    if (!membership || membership.status !== 0) {
      return sendSystemMessage(ws, "해당 채널에 가입되어 있지 않습니다.");
    }

    // 오너 권한 확인 (permission: 0)
    if (membership.permission !== 0) {
      return sendSystemMessage(ws, "동기화 권한이 없습니다. (오너만 가능)");
    }

    // 문서 존재 확인
    const doc = await getDocFromCache(docId);
    if (!doc || doc.channelId !== channelId) {
      return sendSystemMessage(ws, "문서가 존재하지 않습니다.");
    }

    // 1. 문서 잠금
    await lockDoc(docId, "동기화 작업 중입니다.");

    // 2. Supabase로 동기화
    const synced = await syncDocToSupabase(docId);

    // 3. 문서 잠금 해제
    await unlockDoc(docId);

    // 동기화 결과 전송
    safeSend(ws, {
      event: "docSynced",
      data: {
        time: Date.now(),
        docId: docId,
        channelId: channelId,
        synced: synced,
        snapshotVersion: doc.snapshotVersion,
        message: synced
          ? "동기화가 완료되었습니다."
          : "동기화할 변경사항이 없습니다.",
      },
    });

    // 채널 내 유저들에게 동기화 완료 알림
    broadcastToChannel(channelId, "docSyncCompleted", {
      time: Date.now(),
      docId: docId,
      channelId: channelId,
      synced: synced,
      syncedBy: userId,
    });

    console.log(`문서 동기화: ${docId} by ${userId} (synced: ${synced})`);
  } catch (error) {
    logError("DOC_SYNC_HANDLER", error);

    // 오류 시 잠금 해제 시도
    try {
      await unlockDoc(docId);
    } catch (e) {
      // 무시
    }

    sendSystemMessage(ws, "문서 동기화 중 오류가 발생했습니다.");
  }
}

// === 스냅샷 생성 핸들러 (오너만) ===

async function handleSnapshotDoc(ws, data) {
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
    // 채널 멤버십 및 권한 확인
    let membership;
    try {
      membership = await prisma.channelMember.findUnique({
        where: {
          channelId_userId: {
            channelId: channelId,
            userId: userId,
          },
        },
      });
    } catch (dbError) {
      logError("DB_MEMBER_FIND", dbError);
      return sendSystemMessage(ws, "권한 확인 중 오류가 발생했습니다.");
    }

    if (!membership || membership.status !== 0) {
      return sendSystemMessage(ws, "해당 채널에 가입되어 있지 않습니다.");
    }

    // 오너 권한 확인 (permission: 0)
    if (membership.permission !== 0) {
      return sendSystemMessage(ws, "스냅샷 권한이 없습니다. (오너만 가능)");
    }

    // 문서 존재 확인
    const doc = await getDocFromCache(docId);
    if (!doc || doc.channelId !== channelId) {
      return sendSystemMessage(ws, "문서가 존재하지 않습니다.");
    }

    const oldVersion = doc.snapshotVersion;

    // 1. 문서 잠금
    await lockDoc(docId, "스냅샷 생성 중입니다.");

    // 2. 스냅샷 생성 (Redis → Supabase → 로그 초기화 → Redis 갱신)
    const result = await createSnapshot(docId);

    // 3. 문서 잠금 해제
    await unlockDoc(docId);

    // 문서 열람 중인 유저들에게 새 문서 상태 전파
    broadcastToDoc(docId, "docSnapshotCreated", {
      time: Date.now(),
      docId: docId,
      oldVersion: oldVersion,
      newVersion: result.snapshotVersion,
      content: result.doc.content,
      logMetadata: result.doc.logMetadata,
      createdBy: userId,
    });

    // 스냅샷 결과 전송
    safeSend(ws, {
      event: "snapshotCreated",
      data: {
        time: Date.now(),
        docId: docId,
        channelId: channelId,
        oldVersion: oldVersion,
        newVersion: result.snapshotVersion,
        message: `스냅샷이 생성되었습니다. (v${result.snapshotVersion})`,
      },
    });

    // 채널 내 유저들에게 스냅샷 완료 알림
    broadcastToChannel(channelId, "docSnapshotCompleted", {
      time: Date.now(),
      docId: docId,
      channelId: channelId,
      newVersion: result.snapshotVersion,
      snapshotBy: userId,
    });

    console.log(
      `스냅샷 생성: ${docId} by ${userId} (v${result.snapshotVersion})`,
    );
  } catch (error) {
    logError("DOC_SNAPSHOT_HANDLER", error);

    // 오류 시 잠금 해제 시도
    try {
      await unlockDoc(docId);
    } catch (e) {
      // 무시
    }

    sendSystemMessage(ws, "스냅샷 생성 중 오류가 발생했습니다.");
  }
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
      snapshotVersion: doc.snapshotVersion,
      logCount: (doc.logMetadata || []).length,
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
