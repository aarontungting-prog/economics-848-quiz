# 經濟學題庫網站部署

本專案是可直接部署的靜態網站，不需要 Node.js build step，也不依賴 ChatGPT 預覽網址。

## GitHub Pages

1. 建立一個 GitHub repository，將本資料夾內的檔案放到 repository 根目錄。
2. 將預設分支命名為 `main`，或保留 `master`。
3. 到 GitHub repository 的 **Settings → Pages**，將 Source 設為 **GitHub Actions**。
4. push 後，`.github/workflows/pages.yml` 會自動部署。
5. GitHub 會在 Actions 完成後顯示公開網址，通常是 `https://你的帳號.github.io/你的repository/`。

這個網址不需要使用者登入 ChatGPT；任何能開啟網頁的手機或電腦瀏覽器都可以使用。

## Firebase 設定

網站已放入使用者提供的 Firebase Web 設定，會員資料路徑為 `users/{uid}/attempts/{timestamp}`。要啟用雲端會員功能，請在 Firebase Console 完成：

1. Authentication → Sign-in method → 開啟 **Email/Password**。
2. Firestore Database → 建立資料庫。
3. 將本專案的 `firestore.rules` 套用到 Firestore Rules。
4. Authentication → Settings → Authorized domains，加入 GitHub Pages 網域，例如 `你的帳號.github.io`。

若 Firebase 尚未完成設定，網站仍可用「訪客模式」與瀏覽器 localStorage；登入表單使用標準 `email`、`password` 與 autocomplete 屬性，支援 Chrome、Edge、Safari 等瀏覽器的密碼儲存與自動填入。

## 題庫檢查範圍

`question_manifest.csv` 與網站內的 848 題資料保留原始章節、題型、題號、答案與詳解。程式化檢查已確認資料筆數、題型、ID、選項與答案欄位完整；第 2 章是非題題號 22 與第 6 章單選題題號 25 的重複是原始題庫狀況，網站以題目 ID 辨識。若要逐題核對文字、答案與詳解，仍需要拿原始 PDF 逐題比對，不能只依題庫自身資料判斷。
