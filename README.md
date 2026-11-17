# Image Search Hub

![Image Search Hub](https://img.shields.io/badge/Image%20Search-Hub-111827?style=for-the-badge)

一次準備圖片，集中開啟多個反向圖片搜尋引擎。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/louis99941/image-search-hub)

> 本 repo 使用 Cloudflare Workers + Static Assets。圖片暫存使用 Workers KV，不需要 R2、D1 或其他外部儲存。

## V1.4

- V1.3 的真人照片 / 人臉、一般圖片、動漫 / 插畫搜尋分類與引擎狀態
- 新增登入畫面，帳號密碼由 Cloudflare Worker 環境變數讀取
- Worker 使用 HMAC-SHA256 簽署 Session，Cookie 為 HttpOnly、Secure、SameSite=Strict
- 登入 Session 有效期限 12 小時，並提供登出
- 登入失敗限制：每個 IP 每 5 分鐘最多 5 次嘗試
- 圖片上傳與刪除 API 必須登入
- 搜尋引擎讀取的隨機短期圖片 URL 保留公開 GET 權限，避免外部搜尋引擎無法抓圖
- 靜態前端檔案本身不是機密資料；未登入時只顯示登入畫面，所有受保護操作由 Worker 驗證
- 搜尋引擎勾選狀態記住在目前瀏覽器，可一鍵恢復預設
- 不保存圖片或搜尋歷史
- Cloudflare Worker + Static Assets
- Worker KV 十分鐘暫存 URL

## Cloudflare 登入設定

在 Cloudflare Dashboard 開啟 **Workers & Pages → image-search-hub → Settings → Variables and Secrets**，新增：

| 名稱 | 類型 | 用途 |
|---|---|---|
| `AUTH_USERNAME` | Secret（建議） | 登入帳號 |
| `AUTH_PASSWORD` | Secret | 登入密碼 |
| `SESSION_SECRET` | Secret | Session 簽章密鑰，請使用至少 32 bytes 的隨機值 |

三個值都必須設定，修改後重新部署或使用 Dashboard 的部署流程讓新設定生效。不要把密碼或 Session Secret 寫進 `wrangler.toml`、GitHub 原始碼或公開 Issue。

可用以下方式產生隨機 Session Secret（在本機 PowerShell 7 執行）：

```powershell
$bytes = [byte[]]::new(48)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

將輸出結果貼到 Cloudflare 的 `SESSION_SECRET` Secret 欄位。帳號與密碼可自行設定，不要使用容易猜測的值。

## 搜尋策略

真人照片用途優先使用人臉與一般反向圖片搜尋服務交叉查找。URL 型引擎使用短期圖片 URL 啟動搜尋；不支援穩定 URL 啟動的引擎則開啟官方搜尋頁，讓使用者自行完成上傳。刻意避免依賴網站私有 API、CAPTCHA 或容易變動的頁面 DOM。

## 一鍵部署

點擊上方 **Deploy to Cloudflare**，使用 Cloudflare 官方 Workers 部署流程。部署後 Worker 同時提供網站與 `/api/image` 暫存圖片 API。

不需要建立 R2 bucket，也不需要設定 R2 binding。

**注意：Cloudflare 官方 Deploy to Cloudflare button 要求 GitHub repository 可被部署流程存取；repository visibility / access 需依 Cloudflare 當下的部署流程要求設定。**

## 暫存圖片

本機圖片只有在需要提供公開圖片 URL 給反向圖片搜尋引擎時，才會 POST 到 Worker。

Worker 會：

1. 驗證登入 Session。
2. 驗證請求是否來自同一個網站來源。
3. 以 Cloudflare-Connecting-IP 做每分鐘上傳次數限制。
4. 產生隨機 UUID。
5. 將圖片放進 Workers KV。
6. 回傳 `/api/image/<uuid>` URL。
7. 將圖片 TTL 設為 600 秒。
8. 前端換圖、清除或離開頁面時盡可能發出 DELETE（DELETE 需要登入）。
9. TTL 到期後 KV 自然失效，無法再取得圖片。

為了讓 Google Lens 等外部搜尋服務讀取圖片，帶有隨機 UUID 的短期圖片 GET URL 不要求登入。請勿將這類 URL 分享給不信任的人；圖片最長保留約 10 分鐘。

## 開發

這是一個無 bundler 的 ES module 專案。可直接用 Wrangler 本機預覽或部署：

```bash
npx wrangler dev
npx wrangler deploy
```

本機開發也需要設定 `AUTH_USERNAME`、`AUTH_PASSWORD`、`SESSION_SECRET` 三個環境變數及既有的 `IMAGE_KV` binding。

## 目前限制

- 本地檔案的自動 URL 搜尋需要 Cloudflare Worker 暫存 endpoint。
- TinEye、Lenso、Copyseeker 尚未模擬網站內部上傳流程。
- 不包含圖片裁切、不保存搜尋紀錄、不建立帳號或雲端歷史。
- 簡單 rate limit 使用 KV 計數，屬於基礎防濫用措施，不是嚴格的全域流量控制。
- PimEyes、FaceCheck.ID 等人臉搜尋服務的實際使用方式與結果受各服務本身的條款、地區與反自動化機制限制。
- V1.3 的「引擎健康狀態」是前端啟動狀態與已知能力提示，不代表遠端搜尋服務的即時可用性。

## Roadmap

V1.5：自訂搜尋組、搜尋結果啟動紀錄（只保留在目前頁面，不寫入歷史）。

V2：瀏覽器擴充功能、PWA share target。

V3：在官方 API 或穩定資料來源可用的前提下，加入結果聚合、去重與來源摘要。
