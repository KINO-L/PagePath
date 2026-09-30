# 开发指南

PagePath 使用原生 JavaScript、SVG、OpenCV.js / WASM 和 Manifest V3。扩展可直接加载，无构建步骤；Node.js 与 Playwright 用于开发、测试和图标渲染。

## 本地环境

使用 Node.js 20 或以上，在项目根目录执行：

```sh
git clone https://github.com/KINO-L/PagePath.git
cd PagePath
npm install
```

浏览器自动化使用 Playwright。Windows 默认优先使用本机 Edge，也可安装 Chromium：

```sh
npx playwright install chromium
```

`PAGEPATH_BROWSER` 可指定浏览器可执行文件的完整路径。扩展的加载方法见 [使用指南](USAGE.md)。

## 架构

| 模块 | 职责 |
| --- | --- |
| `src/background.js` | 扩展开关、截图、后台分析与脚本注入 |
| `config.js` | 难度、墨水、碰撞、图像分析及解锁参数 |
| `opencvRuntime.js` | 离线 OpenCV 初始化与取消等待 |
| `compactDom.js` / `compactMask.js` | 稳定小元素几何采集、截图确认与障碍合并 |
| `imageMapAnalyzer.js` | 局部背景、前景、距离变换与连通区域 |
| `mapCodec.js` / `pageSnapshot.js` | 地图压缩传输、静态画面与视口监测 |
| `collision.js` | 基于通行图的完整线段碰撞，含边与角接触 |
| `grid.js` / `pathfinding.js` | 通道图、路径搜索与路线简化 |
| `levelGenerator.js` / `scoring.js` | 普通关卡节点、参考路线、墨水与得分 |
| `mazeGenerator.js` / `mazeCleanup.js` | 迷宫指标、共享几何与小障碍合并 |
| `mazeRoute.js` / `mazeConnectors.js` | 答案规划、细线连接与短挡板 |
| `routeMazeGenerator.js` | 迷宫生成编排、最终拓扑与碰撞验证 |
| `overlay.js` | SVG 图层、水墨界面与样式隔离 |
| `game.js` / `index.js` | 游戏状态、输入、启动与退出 |

除特别标注外，模块位于 `src/content/`。游戏通过有序注入的普通脚本加载，在 isolated world 中共享命名空间，各模块以 IIFE 隔离内部状态。OpenCV 在扩展 service worker 中运行，使用自带 WASM 与 `wasm-unsafe-eval`，不启用 JavaScript `unsafe-eval`。运行库来源、哈希、许可和 CSP 修补复现方法见 [OpenCV 说明](../vendor/opencv/README.md)。

## 地图与碰撞

1. 截取当前视口，在后台将设备像素缩放为 CSS 像素。截图前后采集小型 DOM 几何，仅保留稳定候选；辅助信息不含网页文字或链接。
2. OpenCV 转换至 Lab 色彩空间，估计局部平坦背景并计算色差，识别前景。过滤低对比装饰细线，进行轻微 morphology cleanup。
3. 小 DOM 候选经截图前景确认后合入 `obstacleMask`。大容器和大图片继续保留图像轮廓与内部留白。
4. 对背景做精确欧氏距离变换，根据笔尖半径、安全留白和像素格补偿生成 `walkableMask`，再计算四连通区域及精确格边轮廓。
5. 地图经压缩传回页面。节点、自动寻路、答案验证和鼠标碰撞共用最终通行图，游戏期间只读取缓存。

通行像素采用行程压缩，以矩形空地和重叠通道建立稀疏导航图；矩形只用于导航，不改变障碍轮廓。节点取自同一连通区域，路线简化仍按原通行图验证。完整鼠标线段检查所有触及像素，避免高速移动穿墙；节点命中也检查到中心的可达线段。

轮廓按本局起点的可达区域过滤。靠近时显示最终碰撞边界，新图短暂高亮原障碍。前三档提示只显示参考路线，第二关隐藏并禁用提示，Game 和 Overlay 都拒绝开启答案显示。

OpenCV 只在重新截图时运行；新地图和切换难度复用缓存。视口上限为 850 万 CSS 像素，导航图、传输与解压均设工作量上限。

## 关卡与输入

前三档内部 ID 为 `normal`、`hell`、`immortal`，对应萌新、糕手、神仙，通常生成 12–14、16–18、18–20 个节点。空间不足时减少节点。最多 12 个节点时使用 Held–Karp 优化节点间路线；更多节点使用有工作量上限的启发式搜索和局部改进。参考路线保证可行，不保证连续空间最短。

`getInkMultiplier(modeId, nodeCount)` 按实际点数计算预算：萌新 1.15、神仙 1.04，糕手为 `1.06 + max(0, N - 8) * 0.005`，N 含起终点、上限 18。鼠标轨迹逐段计费，45px 显示尾迹不影响计费。默认笔尖半径和安全留白均为 1px，通行图额外包含半像素对角线补偿；运行时不二次膨胀。

左键命中砚台后进入 `DRAWING`，鼠标移动持续绘制，与 `buttons` 状态无关，松开左键不会失败。仅 `DRAWING` 隐藏系统光标并显示毛笔、墨量及局部障碍提示。绘制时悬浮栏折叠；失败、完成、暂停后恢复普通鼠标并展开。右键与 Esc 退出。

## 第二关生成

`Config.MAZE_REQUIREMENTS` 定义解锁条件：`minObstacleRatio: 0.2`、`minOccupiedRegions: 30`。指标来自补线前的原始 `obstacleMask`，不计安全距离扩张。分散度将视口划为 8×6 格，格内障碍约占 10% 即计入。`MazeGenerator.assess()` 只评估这两项，界面使用同一份指标显示锁或五角星。

`MazeGenerator.generate()` 委托 `RouteMazeGenerator`：

1. `MazeCleanup.merge()` 合并紧邻的小组件，约束尺寸、距离、密度和新增像素，并保护局部连通性。
2. `MazeRoute.plan()` 在主要通行区域选择长的简单路线，先固定起终点与答案；原空间不足时沿选定路径做有限的窄开口。
3. `MazeConnectors.plan()` 在答案保护带外寻找原障碍之间的斜线或折线连接，以 3px 圆帽线逐像素栅格化。短挡板从障碍边界伸出，封住捷径。
4. 重建最终距离图、通行图和行段拓扑图；起终点路径上的每条图边必须为桥，验证不存在另一条通向终点的绕行分支。
5. 沿唯一主通道重建答案，检查最终碰撞、起终点留白、间距、路线范围与必要转弯。

各尝试要求端点距障碍至少 12px；间距至少 `max(80px, 18% 视口对角线)`，路径长度至少 `max(220px, 65% 视口对角线)`，覆盖跨度至少 `max(128px, 32% 视口对角线)`，至少 4 次必要转弯。尝试次数有界，地图通过验证后才进入游戏。

迷宫模式 ID 为 `maze`，仅两个节点，`unlimitedInk: true`、`maxInk: Infinity`。`mazeOriginalAnalysis` 保留原分析；`mazeSourceAnalysis` 为加墙前基底；`mazeMergedObstacles`、`mazeWallSegments` 和 `mazeCarvedPaths` 分别记录聚合、细墙与必要开口。`mazeOpenings` 只含实际删除的前景像素，Overlay 仅覆盖这些像素。

原图保持不可变，切回普通难度恢复原地图。新增墙平时透明、靠近才显示；原障碍与新墙的显示轮廓分别缓存，碰撞始终共用最终地图。普通关卡无可用空间但第二关已解锁时，保留截图与入口供用户选择。

## 测试与试玩

算法、游戏状态和扩展配置测试：

```sh
npm test
```

安装开发依赖后可运行浏览器测试：

| 命令 | 覆盖范围 |
| --- | --- |
| `npm run test:browser` | 代表性页面、鼠标通关、提示、重试与退出 |
| `npm run test:analysis` | 真实截图、背景、DPR 与缓存 |
| `npm run test:vision` | OpenCV 分割、装饰线、通道、距离图与轮廓 |
| `npm run test:hybrid` | 小 DOM 采集、过滤与截图融合 |
| `npm run test:opencv` | 离线 WASM 与严格网页 CSP |
| `npm run test:ui` | 工具栏、笔尖、墨量、拖动与退出 |
| `npm run test:maze` | 解锁、唯一通路、墙体碰撞、无限墨水与鼠标通关 |
| `npm run test:mv3` | 实际扩展加载、权限、隔离注入与截图 |

MV3 测试使用临时浏览器配置与 CDP `Extensions.triggerAction`，需要支持此接口及命令行加载扩展的 Chromium / Edge。修改权限、截图或注入时应运行 MV3；其他改动运行对应测试，发布前完成相关回归并人工试玩。

```sh
npm run demo
```

打开 `http://127.0.0.1:4173`，可试玩空白、文章、代码、Dashboard、电商和 SPA 夹具。服务器仅绑定本机，Ctrl+C 停止。在页面上点击已安装扩展图标测试完整截图流程；页面内启动按钮用于自动化环境。

## 图标与打包

修改 `icons/icon.svg` 后生成 PNG：

```sh
node scripts/render-icons.cjs
```

同步更新 `manifest.json`、`package.json` 及文档版本，确认 `Config.DEBUG` 为 `false`，然后在 PowerShell 打包：

```powershell
./scripts/package.ps1
```

脚本根据 manifest 版本生成 `dist/PagePath-v<版本号>.zip`。`DEBUG` 可在开发时显示地图分析图层。反馈改动时请附复现步骤和验证结果，测试夹具避免包含私人网页内容。
