// src/firebaseConfig.js

// Firebaseの必要な関数をインポート
import { initializeApp } from "firebase/app";
import { getFirestore, setLogLevel } from "firebase/firestore"; // setLogLevel を追記
import { getStorage } from "firebase/storage";
import { getAuth, signInAnonymously, onAuthStateChanged, signInWithCustomToken } from "firebase/auth";

// あなたのWebアプリのFirebase設定
const firebaseConfig = {
  apiKey: "AIzaSyAGUjjjVMTe9LywLbS97Cp95snlkU6JZrs",
  authDomain: "my-manga-app-9a838.firebaseapp.com",
  projectId: "my-manga-app-9a838",
  storageBucket: "my-manga-app-9a838.firebasestorage.app", // Firebaseコンソールが生成した値を使用してください
  messagingSenderId: "220733136722",
  appId: "1:220733136722:web:a7622d294b4de8c43be48b"
};

// Firebaseアプリを初期化
const app = initializeApp(firebaseConfig);

// 各サービス（Firestore, Storage, Auth）を取得
// これで 'app' が使われるので、警告が消えます
const db = getFirestore(app);
const storage = getStorage(app);
const auth = getAuth(app);

// デバッグログを有効化
setLogLevel('Debug');

// Geminiの指示に基づく認証処理
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

const setupAuth = async () => {
  try {
    // 認証状態を待機
    const user = await new Promise((resolve, reject) => {
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        unsubscribe(); // 一度だけ実行
        resolve(user);
      }, reject);
    });

    // 既に認証済み（カスタムトークンなど）の場合は何もしない
    if (user) {
      console.log("User already signed in:", user.uid);
      return;
    }

    // __initial_auth_token があればカスタムトークン認証
    if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
      await signInWithCustomToken(auth, __initial_auth_token);
      console.log("Signed in with custom token.");
    } else {
      // なければ匿名認証
      await signInAnonymously(auth);
      console.log("Signed in anonymously.");
    }
  } catch (error) {
    console.error("Firebase Auth Error:", error);
  }
};

// 認証状態の監視 (デバッグ用)
onAuthStateChanged(auth, (user) => {
  if (user) {
    console.log("Auth state changed: User is signed in:", user.uid);
  } else {
    console.log("Auth state changed: User is signed out.");
  }
});

// 認証を実行
setupAuth();

// 他のファイル（App.jsxなど）で使えるようにエクスポート
export { db, storage, auth, appId };