# 隐私说明

本说明适用于迷页（PageWander / 迷いページ）v3.1.1，更新于 2026-10-15。

## 网页数据的本地处理

迷页在你点击扩展图标后获取当前视口截图，以扩展自带的 OpenCV 分析像素颜色与轮廓，生成迷宫。对于紧凑的小控件、图标和短文字，扩展在页面内检查元素类型、文字是否为空及长度、可见性、样式和位置，辅助合并障碍。传到扩展后台的辅助信息仅包含位置、尺寸、圆角和形状分类，不包含文字、元素引用或链接；大面积元素仍使用图像分析。

截图、几何信息、像素地图、距离图、节点和路线仅在浏览器内存中处理，不保存网页截图、内容或 URL，不上传网页文字、DOM、地址、截图或游戏数据。扩展不发起外部网络请求，不读取浏览历史，没有账号、服务器、广告、统计追踪或第三方分析服务。

## 权限用途

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击图标后临时访问当前标签页并截取可见区域 |
| `scripting` | 将本地游戏代码按需注入当前网页 |
| `storage` | 在当前浏览器本地保存经验、等级进度、成绩与近期结算记录 |
| `offscreen` | 在扩展自己的不可见文档中承载可终止的本地计算线程，使生成迷宫不会阻塞网页操作 |

扩展不申请所有网站的常驻访问权限，不在页面载入时自动开始游戏。本地文件只有在用户自行开启「允许访问文件网址」后才可使用。

## 保存哪些进度

`chrome.storage.local` 保存累计经验、累计分数、通关次数和最高分；等级和称号由累计经验计算。另保留最近最多 128 条结算记录，包含随机局次 ID、分数、经验和实际难度，用于避免重复发奖。早期存档的分档最高分会合并为统一最高分，原有经验和已结算记录继续保留。

尚未保存成功的结算会在当前浏览器会话中暂存，以便后台自动重试；仅包含随机局次 ID、难度参数、收集的经验及泡泡数量、倍率，保存成功后清除。

这些记录不含网页地址、网页内容、截图、鼠标轨迹或账号标识。关闭网页或浏览器后进度保留，只属于当前浏览器的这份扩展安装，不使用 `storage.sync`，不跨设备或浏览器云同步。卸载扩展会清除本地进度。

## 临时数据与退出

DOM 辅助几何仅在截图时采集并合入地图；同一截图换图复用缓存。退出时释放截图、地图、路线和本局轨迹引用，重新截图时释放旧截图。OpenCV 代码与运行内存在扩展后台复用，由浏览器管理回收。

迷宫生成线程只接收截图分析后的像素地图和游戏几何参数，结果在扩展内部传回当前页面。退出或取消时终止对应线程，完成后也会回收线程；没有待处理任务时关闭不可见文档。这些任务不写入本地存档，也不上传。

静态画面不影响原网站自己的数据处理：它的脚本、网络请求、音视频和后台更新仍可能继续运行。本说明仅针对迷页本身。

## 反馈

隐私相关问题可以通过 [项目 Issues](https://github.com/KINO-L/PagePath/issues) 反馈。Issue 内容由你主动提交给 GitHub，请勿上传包含私人信息的网页截图或页面内容。

## English

This policy covers PageWander (迷页 / 迷いページ) v3.1.1. Updated October 15, 2026.

When you click the extension icon, PageWander captures the visible page and analyzes its pixels locally to generate a maze. It also inspects the type, visibility, styles, geometry, and text emptiness or length of compact page elements. Only geometry and shape information from that inspection is passed to the extension background. The current page URL is used temporarily to check that the page has not changed during capture; browsing history is not accessed.

Screenshots, maps, routes and pointer positions stay in browser memory. They are not uploaded or saved as browsing records. Exiting the game releases the current game data. Bundled OpenCV code and its runtime may remain in memory until the browser releases the extension background. The extension makes no external network requests and has no accounts, advertising, analytics or cloud synchronization. The original website may continue its own scripts, audio, video and network activity while the game shows a static snapshot.

Local extension storage keeps accumulated XP, scores, completion counts, a high score and up to 128 recent reward records containing random game identifiers and reward values. Pending rewards may remain in session storage until saved. These records contain no page URLs, screenshots, page text, mouse trails or account identifiers. Progress remains until the extension's data is cleared or the extension is uninstalled.

Permissions are limited to `activeTab` for user-initiated page access and capture, `scripting` for the game interface and local obstacle analysis, `storage` for progress, and `offscreen` for a cancellable local maze-generation worker. No permanent access to every website is requested.

For privacy questions, use [project Issues](https://github.com/KINO-L/PagePath/issues). Information you voluntarily submit there is handled by GitHub; do not post private page contents or screenshots.

## 日本語

この方針は迷いページ（迷页 / PageWander）v3.1.1に適用されます。更新日：2026年10月15日。

拡張機能のアイコンをクリックすると、表示中のページを撮影し、端末内で画像を解析して迷路を生成します。小さなページ要素について、種類、表示状態、スタイル、形状、文字の有無や長さも確認します。この確認結果のうち、拡張機能のバックグラウンドに渡すのは位置や形状に関する情報のみです。現在のURLは撮影中のページ変更を確認するため一時的に使用し、閲覧履歴は読み取りません。

スクリーンショット、マップ、経路、ポインター位置はブラウザーのメモリー内で処理し、アップロードしたり閲覧記録として保存したりしません。終了すると本局のデータを解放します。同梱のOpenCVとその実行用メモリーは、ブラウザーがバックグラウンドを終了するまで残る場合があります。拡張機能から外部への通信、アカウント登録、広告、アクセス解析、クラウド同期はありません。元のウェブサイト自身のスクリプト、音声、動画や通信は、ゲーム中も動作する場合があります。

拡張機能のローカルストレージには、累計経験値、スコア、クリア回数、最高スコアと、ランダムな局次IDや報酬値からなる最大128件の報酬記録を保存します。保存待ちの報酬をセッションストレージに一時保持する場合があります。これらにURL、スクリーンショット、ページの文章、マウスの軌跡、アカウント識別子は含まれません。進行状況は、拡張機能のデータを消去するかアンインストールするまで保存されます。

使用する権限は、ユーザー操作後のページアクセスと撮影のための`activeTab`、ゲーム表示と障害物解析のための`scripting`、進行状況保存のための`storage`、中止可能なローカル迷路生成処理のための`offscreen`です。すべてのサイトへの常時アクセス権限は求めません。

お問い合わせは[プロジェクトのIssues](https://github.com/KINO-L/PagePath/issues)をご利用ください。自分で投稿した情報はGitHub側で処理されます。個人情報を含むページ内容やスクリーンショットは投稿しないでください。
