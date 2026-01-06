require("dotenv").config();

const express = require("express");
const session = require("express-session");
const fetch = require("node-fetch"); // Node.js 18 이하일 경우 필요
const app = express();

// 환경 변수
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// 세션 설정
app.use(
  session({
    secret: "your-secret-key", // 세션 암호화 키
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }, // HTTPS를 사용하는 경우 secure: true로 설정
  })
);

// Google OAuth 로그인 시작
app.get("/auth/google", (req, res) => {
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?response_type=code" +
    `&client_id=${GOOGLE_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    "&scope=openid%20email";

  res.redirect(url);
});

// Google OAuth 콜백
app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;

  try {
    // 1️⃣ code → access token 교환
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

    if (tokenData.error) {
      console.error("Error exchanging code for token:", tokenData.error);
      return res.status(400).send("Failed to exchange code for token");
    }

    // 2️⃣ 액세스 토큰으로 사용자 정보 요청
    const userRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
        },
      }
    );

    const user = await userRes.json();

    if (user.error) {
      console.error("Error fetching user info:", user.error);
      return res.status(400).send("Failed to fetch user info");
    }

    console.log("Google User:", user);

    // 3️⃣ 세션에 사용자 정보 저장
    req.session.user = user;

    // 로그인 성공 후 루트 페이지로 리다이렉트
    res.redirect("/");
  } catch (error) {
    console.error("Error during OAuth process:", error);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
});

// 루트 페이지
app.get("/", (req, res) => {
  if (req.session.user) {
    // 로그인된 경우
    res.send(
      `루트 페이지입니다. 로그인 성공! 사용자: ${req.session.user.email}`
    );
  } else {
    // 로그인되지 않은 경우
    res.send("루트 페이지입니다. 로그인이 필요합니다.");
  }
});

// 로그아웃
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
      return res.status(500).send("Failed to log out");
    }
    res.send("로그아웃 완료");
  });
});

// 서버 실행
app.listen(3000, () => console.log("실행중"));
