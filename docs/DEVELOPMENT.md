# 开发指南

迷页 v3.1.1 使用原生 JavaScript、SVG、OpenCV.js / WASM 和 Manifest V3，需要 Chrome / Edge 109+。扩展可直接加载，无构建步骤；Node.js 与 Playwright 用于开发和测试。

## 本地环境

使用 Node.js 20 或以上：

```sh
git clone https://github.com/KINO-L/PagePath.git
cd PagePath
npm install
```

浏览器自动化在 Windows 默认使用本机 Edge。也可执行 `npx playwright install chromium`，或通过 `PAGEPATH_BROWSER` 指定浏览器可执行文件。扩展加载方法见 [使用指南](USAGE.md)。

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/background.js` | 扩展开关、截图、后台分析、脚本注入及本地成绩结算 |
| `src/generationHost.js` / `src/offscreen.js` / `src/mazeWorker.js` | 请求归属验证、独立线程生成、取消及资源回收 |
| `mazeClient.js` / `mazeTransport.js` | 可取消的生成请求、压缩地图传输及共享碰撞图重建 |
| `i18n.js` / `_locales/` | 游戏界面翻译、浏览器语言选择及扩展元信息 |
| `config.js` | 全范围难度、星级换算、碰撞与图像分析参数 |
| `opencvRuntime.js` | 离线 OpenCV 初始化与取消等待 |
| `compactDom.js` / `compactMask.js` | 稳定小元素几何采集、截图确认与障碍合并 |
| `imageMapAnalyzer.js` | 局部背景、前景、距离变换与连通区域 |
| `mapCodec.js` / `pageSnapshot.js` | 地图压缩传输、静态画面与视口监测 |
| `collision.js` | 基于最终通行图的完整线段碰撞 |
| `levelGenerator.js` | 随机迷宫入口及通道内的随机经验、倍率泡泡 |
| `mazeGenerator.js` / `mazeCleanup.js` | 像素几何、小障碍合并与地图重建 |
| `mazeRoute.js` / `mazeConnectors.js` | 原页面通道规划、细线连接与短挡板 |
| `routeMazeGenerator.js` | 原页面路线选择、唯一通路验证与结构复杂度评估 |
| `scoring.js` / `progression.js` | 单局积分、经验、等级、称号与重复结算去重 |
| `overlay.js` | SVG 图层、星级、悬浮栏及栏内结算 |
| `game.js` / `index.js` | 游戏状态、输入、泡泡收集、启动与退出 |

除特别标注外，模块位于 `src/content/`。游戏通过有序注入的普通脚本加载，在 isolated world 中共享命名空间，各模块以 IIFE 隔离内部状态。OpenCV 在扩展 service worker 中运行，使用自带 WASM 与 `wasm-unsafe-eval`，不启用 JavaScript `unsafe-eval`。来源、许可和 CSP 修补方法见 [OpenCV 说明](../vendor/opencv/README.md)。

## 地图与迷宫

1. 截取当前视口，将设备像素缩放为 CSS 像素。截图前后采集小型 DOM 几何，仅保留稳定候选；辅助数据不含文字或链接。
2. OpenCV 转换至 Lab 色彩空间，估计局部背景并计算色差，识别前景，过滤低对比装饰细线并清理噪点。
3. 小 DOM 候选经截图前景确认后合入 `obstacleMask`。大容器和大图片保留图像轮廓与内部留白。
4. 距离变换结合玩家碰撞半径、安全留白和像素补偿生成 `walkableMask`，计算四连通区域和精确格边轮廓。
5. 合并紧邻的小障碍，优先在原有通道中选定答案，再用斜线、折线和挡板封住绕行通道。
6. 原有通道不足时，沿原页面地形补充细墙，必要时局部开通障碍。随机强度控制路线选择及补线策略。
7. 重建最终距离图、通行图及行段拓扑图；起终点路径上的每条图边必须为桥。按最终碰撞图检查答案与端点，评估几何难度后进入游戏。

原有 `LevelGenerator.generate()` 及下层算法在 `mazeWorker.js` 的独立 Worker 中执行，不改变候选尝试次数、路线规则或难度评估。Offscreen 文档只负责启动和终止线程；后台校验标签页、文档身份和请求 ID。取消、导航或关闭游戏会终止对应任务，晚到的结果不能覆盖新地图。没有待处理任务时关闭 Offscreen 文档。

截图返回的压缩原图复用于换图请求；最终地图和必要的生成基底通过 `MazeTransport` 传输，消息保持在 60 MiB 内。页面侧分段解码并让出执行时间，可在还原像素与轮廓时响应退出。重建的碰撞索引直接共享最终 `walkableMask`；原始截图地图保持不变。截图完成后通过定向消息恢复悬浮栏，不必等 OpenCV 分析结束才显示加载提示。

`MazeGenerator.assess()` 只验证截图地图结构，不以面积、内容分布或连通面积锁定玩法。`Difficulty.profile()` 从原始障碍图的覆盖率、分布和边缘密度估计页面复杂度，并缓存结果；五档目标概率在简单页面的 `[36,29,20,10,5]%` 与复杂页面的 `[5,10,20,29,36]%` 之间插值，每档始终有非零概率。`Difficulty.draw()` 抽取目标星级和档内强度，生成器据此选择路线、转弯和分支，并按实测结果调整后续候选。

`RouteMazeGenerator.measuredChallenge()` 根据最终路线长度相对视口对角线的比例、有效转弯和答案直接连出的有效支路评估 `challenge.complexity`（`Q`，范围 `0..1`）。远处同一支路中的小分叉不重复计分，微小墙尖不计为选择。`level.difficulty` 为 `100Q` 取整，范围 `0..100`；`P.Difficulty.stars()` 将其换算为 1–5 星。目标只控制生成，显示与经验结算始终使用最终几何的实测难度；搜索有次数上限，保留经过唯一通路和碰撞验证的可玩候选。

`LevelGenerator.generate(analysis, reservedRects, random, history)` 返回两个端点、参考路线、最终分析图、碰撞索引、实际难度和 `challenge`。`level.maze` 表示迷宫数据，`unlimitedInk` 为 `true`。参考路线仅供生成验证和算法测试，产品没有答案提示。

原始截图地图保持不可变。`mazeOriginalAnalysis` 为原图，`mazeSourceAnalysis` 为生成基底；`mazeOpenings` 仅记录实际打通的前景，不用于绘制填色或覆盖网页。打通通道与新增细墙只改变碰撞地图，在所有星级和游戏状态下均保持透明。轮廓按起点可达区域过滤，原障碍与新增细墙分别缓存；靠近时显示实际碰撞边界。

生成、参考路线验证与玩家碰撞始终使用同一份最终 `walkableMask`。完整鼠标线段检查所有触及像素，避免高速移动穿墙；运行时不再二次膨胀碰撞范围。OpenCV 仅在重新截图时运行，新地图复用分析缓存。视口上限为 850 万 CSS 像素，搜索次数、导航图和传输均有工作量上限。

## 输入与结算

左键命中小火堆后进入 `DRAWING`，随后直接移动，与 `buttons` 状态无关，松开左键不会失败。仅探索时隐藏系统光标并显示小火苗和最近 30px 的火星尾迹；火苗底部的亮点对应实际碰撞位置。悬浮栏折叠，失败、完成、暂停后恢复。右键与 Esc 退出。

每张新地图分配随机 `runId`。`LevelGenerator` 在最终 `walkableMask` 的通关前可达区域内放置 `level.collectibles`，优先放置每图必出的随机倍率泡泡，再放经验泡泡。正常放置逐像素验证整个泡泡、端点避让及工具栏避让；狭窄区域通过缩小倍率泡泡及调整留白保证可拾取，不修改迷宫通道。数量及奖励权重统一定义于 `Config.COLLECTIBLES`。经验泡泡通过距离及碰撞视线显现，所有倍率泡泡始终以呼吸光提示。

移动线段通过真实碰撞检测后，按线段与泡泡的距离拾取，并核验两者之间无墙。同一个泡泡每次尝试只拾取一次，重试重置收集，通关才提交奖励。`Scoring.calculate()` 用实测结构强度 `D = 100 × challenge.complexity` 计分；缺少 `complexity` 时兼容使用 `level.difficulty`：

- 通关得分：`round(600 + 20 × D)`。
- 难度基础经验：`round(得分 / 10)`。
- 最终经验：`(难度基础经验 + collectedXp) × multiplier`。

计分没有时间、距离或失败次数因素。`collectionStats()` 验证经验总和能够由对应数量的 10/20/40 经验泡泡组成，倍率只能为 1、2、3、5、8。

`progression.js` 定义五级经验曲线，累计阈值依次为 `[0, 1500, 15000, 60000, 150000]`，单次升级需求为 `1500 / 13500 / 45000 / 90000 XP`。五级称号依次为「萌新」「糕手」「吴迪」「？？？」「神仙」。按每次新地图通关平均获得 500 XP、包含重试平均每次通关 4 分钟估算，满级目标约 20 小时；这只是曲线设计假设，不参与单局计分。

结算消息携带 `difficulty`、可选的 `challenge.complexity` 和收集汇总 `collectedXp`、`collectedCount`、`multiplier`。通关时立即在本地计入经验，原悬浮栏显示「+经验」及升级结果；待结算队列在后台自动提交，不阻塞重试或换图。后台验证数值范围并重新计分，通过串行读改写保存 `chrome.storage.local`，避免多个标签页同时结算丢失进度。暂时保存失败会自动退避重试，会话缓存保留待办供 worker 重建后恢复。确认后的存档与未确认奖励按 `runId` 去重合并。当前地图只奖励一次，最近 128 条结算记录用于去重；同图再次完成作为练习，不重复增加经验。

存档 schema 3 只保留统一最高分，兼容读取早期按档位存储的最高分并合并；累计经验、总分、通关次数及近期已结算 ID 原样保留，旧记录的用时字段移除。旧会话待办按新难度基础经验结算，收集默认为 0、倍率为 1。五级曲线继续使用 schema 3，读取时按原有 `totalXp` 和新阈值重新推导等级，不缩减累计经验，也不重置结算去重记录。

## 测试与试玩

```sh
npm test
```

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run test:browser` / `npm run test:mv3` | 真实 MV3 扩展加载、截图、鼠标通关、计分与本地进度 |
| `npm run test:maze` | 迷宫生成、噪点合并、唯一通路与连线算法单元测试 |
| `npm run test:analysis` | 真实截图、背景、DPR 与缓存 |
| `npm run test:vision` | OpenCV 分割、装饰线、通道、距离图与轮廓 |
| `npm run test:hybrid` | 小 DOM 采集、过滤及混合地图随机迷宫 |
| `npm run test:opencv` | 离线 WASM 与严格网页 CSP |
| `npm run test:ui` | 三语悬浮栏、火苗、拖动、等级与结算界面 |

MV3 测试使用临时浏览器配置与 CDP `Extensions.triggerAction`，需要支持此接口及命令行加载扩展的 Chromium / Edge。修改权限、截图、注入或本地结算时应运行 MV3，其余改动运行对应测试。

执行 `npm run demo` 后打开 `http://127.0.0.1:4173`，可在测试页面上点击已安装的扩展图标试玩完整流程。服务器仅绑定本机，Ctrl+C 停止。

## 图标与打包

修改 `icons/icon.svg` 后，运行 `node scripts/render-icons.cjs` 生成 PNG。保持 `manifest.json`、`package.json` 与文档版本一致，确认 `Config.DEBUG` 为 `false`。PowerShell 打包命令：

```powershell
./scripts/package.ps1
```

脚本按 manifest 版本生成 `dist/Miye-v<版本号>.zip`，本版为 `dist/Miye-v3.1.1.zip`。开发时可开启 `DEBUG` 查看地图分析图层，测试夹具不要包含私人网页内容。
