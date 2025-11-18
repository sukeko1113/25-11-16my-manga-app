import React, { useState, useEffect, useMemo, useCallback } from "react"; // useCallback をインポート
import { UploadCloud, Vote, Trophy, Trash2, X, Loader2 } from "lucide-react";
import "./App.css"; // ← ★ この行があるか確認してください（なければ追加）

// Firebase設定と関数をインポート
import { db, storage, auth, appId } from "./firebaseConfig.js";
import {
  collection,
  onSnapshot,
  addDoc,
  doc,
  runTransaction,
  deleteDoc,
  getDoc,
  serverTimestamp,
  query,
  orderBy, // orderBy をインポート
} from "firebase/firestore";
import {
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import { onAuthStateChanged } from "firebase/auth";

// --- ELOレーティング計算ロジック (変更なし) ---
const K_FACTOR = 32;
const calculateExpected = (ratingA, ratingB) => {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
};
const updateElo = (oldRating, expected, score) => {
  return Math.floor(oldRating + K_FACTOR * (score - expected));
};

// --- Firebaseコレクション参照 ---
// Geminiキャンバスのセキュリティルールに基づいたパスを使用
const mangaCollectionPath = `artifacts/${appId}/public/data/manga`;
const mangaCollectionRef = collection(db, mangaCollectionPath);

// --- メインコンポーネント ---
export default function App() {
  const [view, setView] = useState("ranking");
  const [mangaList, setMangaList] = useState([]); // 初期値は空配列
  const [isLoading, setIsLoading] = useState(true); // 初回読み込み中はtrue
  const [message, setMessage] = useState(null);
  const [userId, setUserId] = useState(null); // 認証状態を管理
  const [isAuthReady, setIsAuthReady] = useState(false); // 認証準備完了フラグ

  // 認証状態の監視
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (user) {
        setUserId(user.uid);
      } else {
        setUserId(null); // 匿名認証が切れた場合など
      }
      setIsAuthReady(true); // 認証状態が確定
    });
    return () => unsubscribe(); // クリーンアップ
  }, []);

  // Firestoreからリアルタイムでデータを取得
  useEffect(() => {
    // 認証が準備完了になるまで待機
    if (!isAuthReady) {
      return;
    }

    setIsLoading(true);

    // createdAtで降順にソートするクエリ
    const q = query(mangaCollectionRef, orderBy("createdAt", "desc"));

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const list = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setMangaList(list);
        setIsLoading(false);
      },
      (error) => {
        console.error("Firestore Error: ", error);
        setMessage({ type: "error", text: "データの読み込みに失敗しました。" });
        setIsLoading(false);
      }
    );

    return () => unsubscribe(); // クリーンアップ
  }, [isAuthReady]); // isAuthReady が true になったら実行

  // メッセージ自動削除 (変更なし)
  useEffect(() => {
    if (message) {
      const timer = setTimeout(() => setMessage(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [message]);

  // 漫画のアップロード処理 (Firebase対応)
  const handleUpload = async (formData) => {
    setIsLoading(true);
    if (!userId) {
      setMessage({
        type: "error",
        text: "認証エラー。再読み込みしてください。",
      });
      setIsLoading(false);
      return;
    }

    try {
      // 1. 画像をStorageにアップロード
      // ファイル名を一意にする (appIdと時刻を追加)
      const storagePath = `manga_images/${appId}/${Date.now()}_${
        formData.imageFile.name
      }`;
      const imageRef = ref(storage, storagePath);

      await uploadBytes(imageRef, formData.imageFile);

      // 2. アップロードした画像のURLを取得
      const imageUrl = await getDownloadURL(imageRef);

      // 3. Firestoreにメタデータを保存
      // 注意: パスワードを平文で保存しています。
      // 本番環境ではFirebase Functionsでハッシュ化することを強く推奨します。
      await addDoc(mangaCollectionRef, {
        title: formData.title,
        author: formData.author,
        password: formData.password, // 平文で保存
        imageUrl: imageUrl,
        storagePath: storagePath, // 削除用にパスを保存
        elo: 1500, // 初期レート
        createdAt: serverTimestamp(), // サーバー側のタイムスタンプ
        uploaderUid: userId, // アップロードしたユーザーのID (匿名)
      });

      setMessage({ type: "success", text: "アップロードが完了しました！" });
      // ★ アップロード成功後、フォームはリセットされるがビューは 'upload' のままにする
      // setView('ranking'); // この行をコメントアウトまたは削除
    } catch (error) {
      console.error("Upload Error: ", error);
      setMessage({
        type: "error",
        text: `アップロードに失敗しました: ${error.message}`,
      });
    } finally {
      setIsLoading(false);
    }
  };

  // 投票処理 (Firebase トランザクション対応)
  const handleVote = async (winnerId, loserId) => {
    // 連続クリックを防ぐ（簡易的）
    setIsLoading(true);

    const winnerRef = doc(db, mangaCollectionPath, winnerId);
    const loserRef = doc(db, mangaCollectionPath, loserId);

    try {
      await runTransaction(db, async (transaction) => {
        const winnerDoc = await transaction.get(winnerRef);
        const loserDoc = await transaction.get(loserRef);

        if (!winnerDoc.exists() || !loserDoc.exists()) {
          throw new Error("作品データが見つかりません。");
        }

        const winner = winnerDoc.data();
        const loser = loserDoc.data();

        const expectedWinner = calculateExpected(winner.elo, loser.elo);
        const expectedLoser = calculateExpected(loser.elo, winner.elo);

        const newWinnerElo = updateElo(winner.elo, expectedWinner, 1);
        const newLoserElo = updateElo(loser.elo, expectedLoser, 0);

        transaction.update(winnerRef, { elo: newWinnerElo });
        transaction.update(loserRef, { elo: newLoserElo });
      });
      // 投票成功時はメッセージなしで次の対戦へ
    } catch (error) {
      console.error("Vote Error: ", error);
      setMessage({
        type: "error",
        text: `投票処理に失敗しました: ${error.message}`,
      });
    } finally {
      setIsLoading(false); // 次の対戦のためにローディング解除
    }
  };

  // 削除処理 (Firebase対応)
  const handleDelete = async (id, password) => {
    setIsLoading(true);

    const mangaRef = doc(db, mangaCollectionPath, id);

    try {
      const mangaDoc = await getDoc(mangaRef);
      if (!mangaDoc.exists()) {
        setMessage({ type: "error", text: "削除対象の作品が見つかりません。" });
        setIsLoading(false);
        return false;
      }

      const mangaData = mangaDoc.data();

      // パスワード照合 (平文)
      if (mangaData.password === password) {
        // 1. Storageから画像を削除
        const imageRef = ref(storage, mangaData.storagePath);
        await deleteObject(imageRef);

        // 2. Firestoreからドキュメントを削除
        await deleteDoc(mangaRef);

        setMessage({ type: "success", text: "削除しました。" });
        setIsLoading(false);
        return true; // 削除モーダルを閉じるためにtrueを返す
      } else {
        setMessage({ type: "error", text: "パスワードが違います。" });
        setIsLoading(false);
        return false;
      }
    } catch (error) {
      console.error("Delete Error: ", error);
      setMessage({
        type: "error",
        text: `削除に失敗しました: ${error.message}`,
      });
      setIsLoading(false);
      return false;
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 font-sans text-gray-800">
      {/* グローバルローディングオーバーレイ */}
      {(isLoading || !isAuthReady) && ( // 認証準備中もローディング表示
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
          <Loader2 className="w-16 h-16 text-white animate-spin" />
        </div>
      )}

      {/* グローバルメッセージ */}
      {message && (
        <div
          className={`fixed top-4 right-4 p-4 rounded-lg shadow-md z-40 ${
            message.type === "success"
              ? "bg-green-500 text-white"
              : "bg-red-500 text-white"
          }`}
        >
          {message.text}
          <button onClick={() => setMessage(null)} className="ml-2 font-bold">
            X
          </button>
        </div>
      )}

      <Header setView={setView} />

      <main className="max-w-4xl mx-auto p-4 md:p-6">
        {/* --- UploadForm に mangaList と onDelete を渡す (変更なし) --- */}
        {view === "upload" && (
          <UploadForm
            onUpload={handleUpload}
            mangaList={mangaList}
            onDelete={handleDelete}
          />
        )}
        {view === "vote" && (
          <VoteView mangaList={mangaList} onVote={handleVote} />
        )}
        {view === "ranking" && (
          <RankingView mangaList={mangaList} onDelete={handleDelete} />
        )}
      </main>

      <footer className="text-center p-4 text-gray-500 text-sm">
        © 2025 漫画トーナメント (Firebase版)
      </footer>
    </div>
  );
}

// --- ヘッダーコンポーネント (変更なし) ---
function Header({ setView }) {
  return (
    <header className="bg-white shadow-md sticky top-0 z-30">
      <nav className="max-w-4xl mx-auto p-4 flex justify-between items-center">
        <h1
          className="text-2xl font-bold text-blue-600 cursor-pointer"
          onClick={() => setView("ranking")}
        >
          漫画投票アプリ
        </h1>
        <div className="flex space-x-2 md:space-x-4">
          <NavButton
            icon={UploadCloud}
            label="アップロード"
            onClick={() => setView("upload")}
          />
          <NavButton
            icon={Vote}
            label="投票する"
            onClick={() => setView("vote")}
          />
          <NavButton
            icon={Trophy}
            label="ランキング"
            onClick={() => setView("ranking")}
          />
        </div>
      </nav>
    </header>
  );
}

function NavButton({ icon: Icon, label, onClick }) {
  return (
    <button
      onClick={onClick}
      className="flex flex-col md:flex-row items-center space-x-0 md:space-x-1 p-2 rounded-lg text-gray-600 hover:bg-blue-100 hover:text-blue-700 transition-colors duration-200"
    >
      <Icon className="w-5 h-5" />
      <span className="text-xs md:text-sm font-medium">{label}</span>
    </button>
  );
}

// --- UploadForm の修正 (フォームリセットロジックは変更なし) ---
function UploadForm({ onUpload, mangaList, onDelete }) {
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [password, setPassword] = useState("");
  const [imageFile, setImageFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState("");

  // 削除モーダル用のステート
  const [showDeleteModal, setShowDeleteModal] = useState(null);

  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file && file.type.startsWith("image/")) {
      setImageFile(file);
      setPreview(URL.createObjectURL(file));
      setError("");
    } else {
      setImageFile(null);
      setPreview(null);
      setError("画像ファイルを選択してください。");
    }
  };

  const handlePasswordChange = (e) => {
    const val = e.target.value;
    if (/^\d{0,4}$/.test(val)) {
      setPassword(val);
      if (val.length === 4) {
        setError("");
      }
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    if (!title || !author || !password || !imageFile) {
      setError("すべての項目を入力してください。");
      return;
    }
    if (password.length !== 4) {
      setError("パスワードは4桁の数字で入力してください。");
      return;
    }

    await onUpload({ title, author, password, imageFile });

    // リセット
    setTitle("");
    setAuthor("");
    setPassword("");
    setImageFile(null);
    setPreview(null);
    setError("");
    const fileInput = document.getElementById("imageFile");
    if (fileInput) fileInput.value = "";
  };

  return (
    <div className="bg-white p-6 md:p-8 rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-6 text-center">
        漫画をアップロード
      </h2>
      {error && (
        <div className="mb-4 p-3 bg-red-100 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      {/* 入力フォーム */}
      <form onSubmit={handleSubmit} className="space-y-6">
        {/* プレビュー */}
        <div className="w-full flex justify-center">
          {preview ? (
            <img
              src={preview}
              alt="プレビュー"
              className="max-h-96 w-auto object-contain rounded-lg shadow-md border"
            />
          ) : (
            <div className="w-64 h-96 bg-gray-200 rounded-lg flex items-center justify-center text-gray-500">
              画像プレビュー
            </div>
          )}
        </div>

        {/* ファイル選択 */}
        <div>
          <label
            htmlFor="imageFile"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            漫画ファイル (画像)
          </label>
          <input
            id="imageFile"
            type="file"
            accept="image/png, image/jpeg, image/gif"
            onChange={handleImageChange}
            className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          />
        </div>

        {/* 題名 */}
        <div>
          <label
            htmlFor="title"
            className="block text-sm font-medium text-gray-700"
          >
            題名
          </label>
          <input
            id="title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
          />
        </div>

        {/* ペンネーム */}
        <div>
          <label
            htmlFor="author"
            className="block text-sm font-medium text-gray-700"
          >
            ペンネーム
          </label>
          <input
            id="author"
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
          />
        </div>

        {/* パスワード */}
        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-gray-700"
          >
            削除用パスワード (4桁の数字)
          </label>
          <input
            id="password"
            type="password"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength="4"
            value={password}
            onChange={handlePasswordChange}
            required
            className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
          />
        </div>

        <button
          type="submit"
          className="w-full flex justify-center py-3 px-4 border border-transparent rounded-lg shadow-sm text-base font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-transform transform active:scale-95"
        >
          <UploadCloud className="w-5 h-5 mr-2" />
          アップロード
        </button>
      </form>

      {/* --- アップロード済み作品リスト --- */}
      {/* --- アップロード済み作品リスト --- */}
      <div className="mt-12 border-t pt-8">
        <h3 className="text-xl font-bold mb-4 text-center">
          アップロード済み作品リスト
        </h3>
        <div className="space-y-6 max-h-96 overflow-y-auto pr-2">
          {mangaList.length === 0 ? (
            <p className="text-center text-gray-500 py-4">
              まだ作品がありません。
            </p>
          ) : (
            mangaList.map((manga) => (
              <div
                key={manga.id}
                className="flex flex-col items-center bg-gray-50 p-4 rounded-lg shadow-sm border border-gray-200"
              >
                {/* 1. 題名 */}
                <h4 className="text-lg font-bold text-blue-700 mb-1 text-center">
                  {manga.title}
                </h4>

                {/* 2. ペンネーム */}
                <p className="text-sm text-gray-600 mb-3 text-center">
                  作者: {manga.author}
                </p>

                {/* 3. 削除ボタン (ここがペンネームの下、画像の上) */}
                <div className="mb-3">
                  <button
                    onClick={() => setShowDeleteModal(manga.id)}
                    className="flex items-center px-3 py-1 text-sm text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors border border-red-200"
                    title="削除"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    削除
                  </button>
                </div>

                {/* 4. 画像 (0.25倍サイズ、中央配置) */}
                <div className="flex justify-center w-full">
                  <img
                    src={manga.imageUrl}
                    alt={manga.title}
                    className="h-auto object-cover rounded-md shadow-sm"
                    style={{ maxWidth: "80px" }}
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* 削除モーダル */}
      {showDeleteModal && (
        <DeleteModal
          mangaId={showDeleteModal}
          onClose={() => setShowDeleteModal(null)}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

// --- 投票ビュー (変更なし) ---
function VoteView({ mangaList, onVote }) {
  const [match, setMatch] = useState(null); // { a: manga, b: manga }

  // 2作品をランダムに選ぶ (useCallbackでメモ化)
  const getNextMatch = useCallback(() => {
    if (mangaList.length < 2) {
      setMatch(null);
      return;
    }

    // ELOレートが近い作品同士を対戦させるロジック (簡易版)
    const sortedList = [...mangaList].sort((a, b) => a.elo - b.elo);

    let indexA, indexB;

    // 50%の確率で、少し離れた作品とも対戦させる (多様性のため)
    if (Math.random() < 0.5) {
      indexA = Math.floor(Math.random() * mangaList.length);
      indexB = Math.floor(Math.random() * mangaList.length);
      while (indexA === indexB) {
        indexB = Math.floor(Math.random() * mangaList.length);
      }
      setMatch({ a: mangaList[indexA], b: mangaList[indexB] });
    } else {
      // ランダムな起点を選ぶ
      indexA = Math.floor(Math.random() * (sortedList.length - 1));
      indexB = indexA + 1; // 隣り合う作品を選ぶ
      setMatch({ a: sortedList[indexA], b: sortedList[indexB] });
    }
  }, [mangaList]); // mangaListが変更されたら、この関数も再生成される

  // マウント時とgetNextMatch変更時に次の対戦を取得 (修正)
  useEffect(() => {
    // 警告を回避するため、非同期（マクロタスク）で実行
    // これにより、Reactの現在のレンダリングサイクルの直後に実行される
    const timerId = setTimeout(() => {
      getNextMatch();
    }, 0);

    return () => clearTimeout(timerId); // クリーンアップ
  }, [getNextMatch]); // getNextMatch (mangaListに依存) が変更されたら実行

  const handleSelect = (winner, loser) => {
    if (!winner || !loser) return; // 安全装置
    onVote(winner.id, loser.id);
    // 投票後、次の対戦へ (mangaListの更新を待たずに即座に計算)
    getNextMatch();
  };

  if (!match || !match.a || !match.b) {
    // matchオブジェクトの存在も確認
    return (
      <div className="text-center p-10 bg-white rounded-lg shadow-lg">
        <h2 className="text-xl font-semibold text-gray-600">
          {mangaList.length < 2
            ? "作品が2つ以上登録されると投票が開始されます。"
            : "対戦を準備中..."}
        </h2>
      </div>
    );
  }

  return (
    <div className="bg-white p-4 md:p-8 rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-6 text-center">どっちが面白い？</h2>
      <div className="flex flex-col md:flex-row justify-center items-stretch md:space-x-4">
        {/* 作品A */}
        <VoteCandidate
          manga={match.a}
          onSelect={() => handleSelect(match.a, match.b)}
        />

        {/* VS */}
        <div className="flex items-center justify-center text-3xl font-bold text-red-500 my-4 md:my-0">
          VS
        </div>

        {/* 作品B */}
        <VoteCandidate
          manga={match.b}
          onSelect={() => handleSelect(match.b, match.a)}
        />
      </div>
    </div>
  );
}

// 投票画面用の作品表示コンポーネント (変更なし)
function VoteCandidate({ manga, onSelect }) {
  // manga オブジェクトが存在しない場合のフォールバック
  if (!manga) {
    return <div className="flex-1" />;
  }

  return (
    <div className="flex-1 flex flex-col items-center">
      <div
        className="w-full max-w-xs md:max-w-none md:w-auto md:h-[500px] flex justify-center items-center cursor-pointer group transition-transform duration-300 ease-out transform hover:scale-105"
        onClick={onSelect}
      >
        <img
          src={manga.imageUrl}
          alt={manga.title}
          className="h-auto object-cover rounded-md shadow-sm mx-auto"
          style={{ maxWidth: "80px", width: "100%" }}
        />
      </div>
      <div className="text-center mt-4 p-2">
        <h3 className="text-xl font-bold">{manga.title}</h3>
        <p className="text-md text-gray-600">by {manga.author}</p>
      </div>
      <button
        onClick={onSelect}
        className="mt-2 py-2 px-6 bg-blue-600 text-white font-semibold rounded-full shadow-lg hover:bg-blue-700 transition-transform transform active:scale-95"
      >
        選ぶ
      </button>
    </div>
  );
}

// --- ランキングビュー (変更なし) ---
// RankingView コンポーネント全体をこれに置き換えてください
// RankingView コンポーネント全体をこれに置き換えてください
function RankingView({ mangaList, onDelete }) {
  const [showDeleteModal, setShowDeleteModal] = useState(null);

  // ELOレートでソート
  const sortedList = useMemo(() => {
    return [...mangaList].sort((a, b) => b.elo - a.elo);
  }, [mangaList]);

  const getRankColor = (rank) => {
    if (rank === 0) return "bg-yellow-400 text-yellow-900";
    if (rank === 1) return "bg-gray-300 text-gray-800";
    if (rank === 2) return "bg-yellow-600 text-white";
    return "bg-gray-100 text-gray-700";
  };

  const getRankEmoji = (rank) => {
    if (rank === 0) return "🥇";
    if (rank === 1) return "🥈";
    if (rank === 2) return "🥉";
    return `${rank + 1}`;
  };

  return (
    <div className="bg-white p-4 md:p-8 rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold mb-6 text-center flex items-center justify-center">
        <Trophy className="w-8 h-8 mr-2 text-yellow-500" />
        リアルタイム ランキング
      </h2>
      <div className="space-y-6">
        {sortedList.length === 0 ? (
          <p className="text-center text-gray-500 py-4">
            まだ作品がありません。
          </p>
        ) : (
          sortedList.map((manga, index) => (
            <div
              key={manga.id}
              className="flex items-start bg-white p-4 rounded-lg shadow-md border border-gray-200"
            >
              {/* 左側：順位画像 (超特大サイズ: w-64 h-64, text-9xl) */}
              <div
                className={`w-32 h-32 flex-shrink-0 mr-8 flex items-center justify-center rounded-full text-7xl font-bold ${getRankColor(
                  index
                )}`}
                style={{ fontSize: "4rem" }}
              >
                {getRankEmoji(index)}
              </div>

              {/* 右側：情報カラム (縦並び) */}
              <div className="flex-grow flex flex-col justify-center">
                {/* 1. 題名 */}
                <h3 className="text-xl font-bold text-blue-700">
                  {manga.title}
                </h3>

                {/* 2. ペンネーム */}
                <p className="text-sm text-gray-600 mt-1">
                  作者: {manga.author}
                </p>

                {/* 3. 削除ボタン (ペンネームの下、画像の上) */}
                <div className="mt-2 mb-3">
                  <button
                    onClick={() => setShowDeleteModal(manga.id)}
                    className="flex items-center px-3 py-1 text-sm text-red-600 bg-red-50 hover:bg-red-100 rounded-md transition-colors border border-red-200"
                    title="削除"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    削除
                  </button>
                </div>

                {/* 4. 画像 */}
                <img
                  src={manga.imageUrl}
                  alt={manga.title}
                  className="w-20 h-auto object-cover rounded-md mb-2 shadow-sm"
                />

                {/* 5. レート */}
                <p className="text-lg font-semibold text-gray-800 mt-1">
                  レート: {manga.elo}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      {/* 削除モーダル */}
      {showDeleteModal && (
        <DeleteModal
          mangaId={showDeleteModal}
          onClose={() => setShowDeleteModal(null)}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}

// --- 削除モーダル (変更なし) ---
function DeleteModal({ mangaId, onClose, onDelete }) {
  const [password, setPassword] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");

  const handlePasswordChange = (e) => {
    const val = e.target.value;
    if (/^\d{0,4}$/.test(val)) {
      setPassword(val);
      setError("");
    }
  };

  const handleDeleteClick = async () => {
    if (password.length !== 4) {
      setError("4桁の数字を入力してください。");
      return;
    }

    setIsDeleting(true);
    setError("");

    // onDeleteは成功したらtrueを返す (Firebase対応)
    const success = await onDelete(mangaId, password);

    setIsDeleting(false);
    if (success) {
      onClose();
    } else {
      // エラーメッセージはAppコンポーネント側で表示されるか、
      // このモーダル内で即座に「パスワードが違います」と表示する
      setError("パスワードが違うか、削除に失敗しました。");
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex justify-center items-center z-40 p-4">
      <div className="bg-white rounded-lg shadow-xl p-6 md:p-8 w-full max-w-sm">
        <div className="flex justify-between items-center mb-4">
          <h3 className="text-xl font-bold">作品の削除</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        <p className="text-sm text-gray-600 mb-4">
          削除するには、アップロード時に設定した4桁のパスワードを入力してください。
        </p>

        {error && (
          <div className="mb-4 p-2 bg-red-100 text-red-700 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <label
            htmlFor="delete-password"
            className="block text-sm font-medium text-gray-700"
          >
            削除用パスワード (4桁)
          </label>
          <input
            id="delete-password"
            type="password"
            inputMode="numeric"
            pattern="\d{4}"
            maxLength="4"
            value={password}
            onChange={handlePasswordChange}
            className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-lg tracking-[.5em] text-center"
          />
          <button
            onClick={handleDeleteClick}
            disabled={isDeleting || password.length !== 4}
            className="w-full flex justify-center py-2 px-4 border border-transparent rounded-lg shadow-sm text-base font-medium text-white bg-red-600 hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:bg-gray-400 transition-colors"
          >
            {isDeleting ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <Trash2 className="w-5 h-5 mr-2" />
            )}
            削除実行
          </button>
        </div>
      </div>
    </div>
  );
}
