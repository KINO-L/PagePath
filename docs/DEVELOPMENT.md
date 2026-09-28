# 开发指南

PagePath 使用原生 JavaScript、SVG 和 Chrome Manifest V3。运行文件可直接加载，无构建步骤；Node.js 和 Playwright 仅用于开发、测试和图标渲染。

## 本地环境

克隆仓库后在项目根目录执行命令，建议使用 Node.js 20 或以上。仅加载扩展时，按 [使用指南](USAGE.md) 选择含 `manifest.json` 的根目录即可。

```sh
git clone https://github.com/KINO-L/PagePath.git
cd PagePath
npm install
```

浏览器自动化使用 Playwright。Windows 上默认优先使用已安装的 Edge；也可安装测试用 Chromium：

```sh
npx playwright install chromium
```

如需指定浏览器，设置 `PAGEPATH_BROWSER` 为本机浏览器可执行文件的完整路径。部分浏览器测试也兼容 `CHROME_PATH`，统一配置时建议使用前者。

## 目录结构

```text
manifest.json                 扩展配置与最小权限
src/background.js             工具栏开关、按需注入与截图服务
src/unavailable.html/.css      受限页面说明
src/content/
  config.js                   难度、墨水、碰撞和生成参数
  obstacleDetector.js         可见元素矩形提取与裁剪
  pageAnalyzer.js             地图分析与一致性检查
  pageSnapshot.js             本地截图与视口变化监测
  collision.js                空间索引与线段碰撞
  grid.js / pathfinding.js     连通区域、路径搜索与简化
  levelGenerator.js           节点选择、参考路线与预算
  scoring.js                  难度和得分计算
  overlay.js                  SVG、水墨控件与样式隔离
  game.js / index.js          游戏状态、输入、启动与退出
icons/                        PNG 图标和 SVG 源文件
tests/                        单元测试与浏览器测试
tests/fixtures/               本地代表性网页
scripts/                      本地服务器、图标与发布工具
docs/                         使用、隐私与开发说明
```

各模块通过有序注入的普通脚本加载，在扩展的 isolated world 中共享命名空间，并以 IIFE 隔离模块内部状态。运行时无需 bundler、动态 import、远程代码或 `web_accessible_resources`。

## 测试

无需第三方依赖的算法、游戏状态与扩展配置测试：

```sh
npm test
```

等价命令为：

```sh
node --test tests/core.test.cjs tests/difficulty.test.cjs tests/modes.test.cjs tests/variation.test.cjs tests/trail.test.cjs tests/extension.test.cjs tests/game.test.cjs
```

安装开发依赖后，按需运行浏览器测试：

| 命令 | 主要覆盖范围 |
| --- | --- |
| `npm run test:browser` | 六类页面中的实际鼠标通关、提示、重试、模式切换与退出 |
| `npm run test:analysis` | 文字行框、可见性、裁剪、媒体、页面变化及观察器清理 |
| `npm run test:ui` | 不同视口和状态下的工具栏、笔尖、墨量、拖动及退出 |
| `npm run test:mv3` | 原始扩展加载、activeTab、隔离注入、静态截图与真实扩展动作 |

MV3 测试使用临时浏览器配置与 CDP 的 `Extensions.triggerAction`。需要支持该调试接口和命令行加载未打包扩展的 Chromium / Edge；部分 Chrome 发行版会限制这些操作。测试专用调试参数不用于日常安装。自动化覆盖本地代表性页面，真实网页仍需人工检查。

修改截图、注入或权限相关逻辑时，应运行 MV3 测试；修改 DOM 分析、输入或界面时，运行对应的浏览器测试。发布前建议完整运行以上检查，并人工从浏览器工具栏启动、通关、退出一次。

## 本地试玩

```sh
npm run demo
```

打开 `http://127.0.0.1:4173`，可切换空白、文章、代码、Dashboard、电商和 SPA 场景。服务器仅绑定本机，Ctrl+C 停止。

在这些页面上点击已安装扩展的图标，可测试完整静态截图模式。页面内的「试玩 PagePath」按钮没有扩展截图权限，使用实时网页模式，仅用于基础模块检查。退出后再切换布局，避免同时启动两个实例。

## 算法与配置

主要参数集中在 `src/content/config.js`。生成器先建立可通行网格并选择连通区域，再抽样节点、计算安全路线和访问顺序；参考最近四张地图的节点位置以减少重复布局。每张地图都有一条经过所有节点的安全参考路线。

最多 12 个节点时，用 Held–Karp 动态规划优化已计算的节点间路线成本；更多节点时改用工作量有上限的启发式搜索和局部改进。参考路线是可行解，不保证连续空间中的数学最短解。

`getInkMultiplier(modeId, nodeCount)` 按实际节点数计算墨水倍率，生成时保存到关卡，界面与预算共用该值。普通为 1.22，神仙为 1.10；地狱为 `1.10 + max(0, N - 5) * 0.015`，N 包含起终点且上限 16。实际鼠标轨迹逐段计费，不做抖动免扣；显示尾迹不改变计费或节点记录。

碰撞使用完整线段检测，网页内容留白 1px，加上笔尖半径 1px；节点收集半径 12px。移动悬浮栏只改变界面位置，不能留下旧位置的碰撞障碍。修改参数后重新加载扩展并刷新测试网页。

将 `DEBUG` 设为 `true` 可显示地图分析图层，包括障碍、网格和参考路线。发布前恢复为 `false`。

## 图标与发行包

修改 `icons/icon.svg` 后，运行以下命令生成浏览器使用的 PNG 图标：

```sh
node scripts/render-icons.cjs
```

在 PowerShell 中打包：

```powershell
./scripts/package.ps1
```

脚本读取 `manifest.json` 的版本号，生成 `dist/PagePath-v<版本号>.zip`。发布时同步更新 `manifest.json` 与 `package.json` 的版本，并确认 `DEBUG` 关闭。

发行包仅包含 `manifest.json`、`src/`、`icons/`、README 和使用/隐私文档；测试、开发脚本、依赖、测试截图、旧压缩包及初始需求文件不进入发行包。`tests/` 和 `scripts/` 保留在源码仓库中，方便维护和复现验证。

反馈或提交改动前，请说明改动目的、复现步骤和已运行的验证，并避免把实际网页的私人内容加入测试夹具。项目讨论见 [Issues](https://github.com/KINO-L/PagePath/issues)。
