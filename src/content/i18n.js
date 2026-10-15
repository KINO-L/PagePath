(() => {
  'use strict';
  const P = globalThis.__PAGEPATH__ ||= {};

  // Use the browser UI language, never the language of the webpage being played.
  // navigator is the fallback for the local demo and environments without Chrome APIs.
  let language;
  try { language = globalThis.chrome?.i18n?.getUILanguage(); } catch { /* Demo fallback. */ }
  language ||= globalThis.navigator?.language || globalThis.navigator?.languages?.[0] || 'en';
  const primary = String(language).trim().toLowerCase().split(/[-_]/)[0];
  const locale = primary === 'zh' ? 'zh-CN' : primary === 'ja' ? 'ja' : 'en';

  // Chinese source messages stay stable inside the map/error protocol. Translate
  // only at presentation boundaries so error validation and saved XP are unchanged.
  // Each pair is [English, Japanese]; Simplified Chinese uses the source key.
  const messages = {
    '迷页': ['PageWander', '迷いページ'],
    '迷页 迷宫地图': ['PageWander maze', '迷いページの迷路'],
    '迷页 游戏控制': ['PageWander game controls', '迷いページのゲーム操作'],
    '移动悬浮栏': ['Move toolbar', 'ツールバーを移動'],
    '拖动悬浮栏 · 方向键微调': ['Drag toolbar · Arrow keys to adjust', 'ドラッグで移動 · 矢印キーで微調整'],
    '正在准备': ['Getting ready', '準備しています'],
    '准备中': ['Preparing', '準備中'],
    '正在生成星级': ['Generating difficulty', '難易度を決定中'],
    '本局难度': ['Maze difficulty', '今回の難易度'],
    '本局经验': ['XP earned this maze', '今回の獲得経験値'],
    '经验': ['XP', '経験値'],
    '重试': ['Retry', '再挑戦'],
    '重试当前迷宫': ['Retry this maze', 'この迷路に再挑戦'],
    '新地图': ['New maze', '新しい迷路'],
    '生成新迷宫': ['Generate a new maze', '新しい迷路を生成'],
    '重新生成': ['Regenerate', '再生成'],
    '重新截取页面并生成迷宫': ['Capture the page again and regenerate', 'ページを再撮影して迷路を生成'],
    '退出游戏': ['Exit game', 'ゲームを終了'],
    '退出游戏 · 右键 / Esc': ['Exit game · Right-click / Esc', 'ゲームを終了 · 右クリック / Esc'],
    '等级经验': ['Level progress', 'レベルと経験値'],
    '萌新': ['Noob', '初心者'],
    '糕手': ['Pro', 'ガチ勢'],
    '吴迪': ['Invincible', '無敵'],
    '？？？': ['???', '？？？'],
    '神仙': ['Immortal', '仙人'],
    '地图分析视图': ['Map analysis view', 'マップ解析ビュー'],
    '切换地图分析视图': ['Toggle map analysis view', 'マップ解析ビューを切り替え'],
    '正在生成迷宫…': ['Generating maze…', '迷路を生成中…'],
    '已收集 {xp} 经验 · {multiplier} 倍': ['Collected {xp} XP · ×{multiplier}', '獲得 {xp} 経験値 · {multiplier} 倍'],
    '{current} / {required} XP': ['{current} / {required} XP', '{current} / {required} XP'],
    '+{xp} XP': ['+{xp} XP', '+{xp} XP'],
    '已满级': ['Max level', '最高レベル'],
    '待开始': ['Ready', '開始待ち'],
    '生成中': ['Generating', '生成中'],
    '探索中': ['Exploring', '探索中'],
    '正在恢复地图': ['Restoring maze', '迷路を復元中'],
    '再试一次': ['Try again', 'もう一度'],
    '已完成': ['Complete', 'クリア'],
    '已暂停': ['Paused', '一時停止中'],
    '已退出': ['Exited', '終了'],
    '刷新地图': ['Refresh maze', '迷路を更新'],
    '本局难度 {stars} 星': ['Difficulty: {stars} stars', '難易度：星 {stars} 個'],
    '{stars} 星': ['{stars} stars', '星 {stars} 個'],
    '本局获得 {amount} 经验': ['Earned {amount} XP', '今回 {amount} 経験値を獲得'],
    '本图已结算': ['XP already awarded for this maze', 'この迷路の経験値は獲得済み'],
    '升级 Lv.{previous} → Lv.{level}': ['Level up: Lv.{previous} → Lv.{level}', 'レベルアップ Lv.{previous} → Lv.{level}'],
    '单击小火堆开始，引导火苗穿过迷宫，到达洞口。': ['Click the campfire, then guide the flame through the maze to the cave.', '焚き火をクリックして開始。炎を導き、迷路の先の洞窟を目指そう。'],
    '移动小火苗，避开墙壁，找到洞口。': ['Guide the flame around the walls to the cave.', '壁を避けながら小さな炎を動かし、洞窟を探そう。'],
    '地图暂未准备好，请重新截取页面。': ['The maze is not ready. Capture the page again.', '迷路の準備ができていません。ページを再撮影してください。'],
    '碰到障碍了，再次单击小火堆开始。': ['You hit an obstacle. Click the campfire to retry.', '障害物にぶつかりました。焚き火をクリックして再挑戦。'],
    '已走出迷宫。': ['You escaped the maze.', '迷路を脱出しました。'],
    '页面尺寸变化，请重新生成迷宫。': ['The page size changed. Generate a new maze.', 'ページのサイズが変わりました。迷路を再生成してください。'],
    '输入已取消，请从起点重试': ['Input was canceled. Retry from the start.', '操作がキャンセルされました。スタートから再挑戦してください。'],
    '输入已离开游戏，请重试': ['Input left the game. Please retry.', '操作がゲーム領域から外れました。再挑戦してください。'],
    '鼠标已离开游戏，请重试': ['The pointer left the game. Please retry.', 'マウスポインターがゲーム領域から外れました。再挑戦してください。'],
    '窗口已失去焦点，请重新生成关卡': ['The window lost focus. Regenerate the maze.', 'ウィンドウが非アクティブになりました。迷路を再生成してください。'],
    '页面已切到后台，请重新生成关卡': ['The tab moved to the background. Regenerate the maze.', 'タブがバックグラウンドになりました。迷路を再生成してください。'],
    '正在截取并分析页面…': ['Capturing and analyzing the page…', 'ページを撮影・解析中…'],
    '请点击浏览器中的 迷页 扩展图标开始': ['Click the PageWander extension icon in your browser to start.', 'ブラウザーの「迷いページ」拡張機能アイコンをクリックして開始してください。'],
    '窗口尺寸已变化，请刷新地图': ['The window size changed. Refresh the maze.', 'ウィンドウのサイズが変わりました。迷路を更新してください。'],
    '地图暂未准备好，请刷新后重试': ['The maze is not ready. Refresh it and try again.', '迷路の準備ができていません。更新して再挑戦してください。'],
    '本图已结算 · 可练习，或换一张新地图': ['XP already awarded · Practice or try a new maze', '経験値は獲得済み · 練習を続けるか、新しい迷路へ'],
    '单击小火堆，带着火苗寻找出口洞口': ['Click the campfire and guide the flame to the cave exit.', '焚き火をクリックして、炎と一緒に出口の洞窟を探そう。'],
    '探索出口': ['Find the exit', '出口を探索'],
    '离开了当前视口，点击小火堆重试': ['You left the viewport. Click the campfire to retry.', '画面の外に出ました。焚き火をクリックして再挑戦。'],
    '碰到了迷宫边界，点击小火堆重试': ['You hit a maze wall. Click the campfire to retry.', '迷路の壁にぶつかりました。焚き火をクリックして再挑戦。'],
    '输入已抬起，点击小火堆重试': ['Contact was released. Click the campfire to retry.', '指やペンが離れました。焚き火をクリックして再挑戦。'],
    '练习完成 · 本图经验已结算': ['Practice complete · XP already awarded', '練習クリア · この迷路の経験値は獲得済み'],
    '迷宫完成': ['Maze complete', '迷路クリア'],
    '窗口已变化，请刷新地图': ['The window changed. Refresh the maze.', 'ウィンドウが変わりました。迷路を更新してください。'],
    '迷页 · 点击开始 / 关闭': ['PageWander · Click to start / close', '迷いページ · クリックで開始 / 終了'],
    '此页面不允许扩展运行。请打开普通网页；本地文件需开启文件网址权限。': ['Extensions cannot run on this page. Open a regular webpage; local files require file URL access.', 'このページでは拡張機能を実行できません。通常のウェブページを開いてください。ローカルファイルにはファイル URL へのアクセス許可が必要です。'],
    '换一个普通网页开始': ['Open a regular webpage to start', '通常のウェブページで始めよう'],
    '浏览器系统页面、扩展商店、内置 PDF 阅读器及部分受保护页面不允许注入游戏。': ['Browser settings, extension stores, built-in PDF viewers and some protected pages cannot run the game.', 'ブラウザーの設定ページ、拡張機能ストア、内蔵 PDF ビューアー、一部の保護されたページではゲームを実行できません。'],
    '如果是本地 HTML 文件，请在扩展详情中开启「允许访问文件网址」。': ['For local HTML files, enable “Allow access to file URLs” in the extension details.', 'ローカルの HTML ファイルで遊ぶには、拡張機能の詳細で「ファイルの URL へのアクセスを許可する」を有効にしてください。'],
    '打开网页后，再次点击工具栏中的 迷页 图标。': ['After opening a webpage, click the PageWander toolbar icon again.', 'ウェブページを開いたら、ツールバーの「迷いページ」アイコンをもう一度クリックしてください。'],
    '页面已切换，请回到原页面后重新开始。': ['The page changed. Return to the original page and start again.', 'ページが切り替わりました。元のページに戻ってから再開してください。'],
    '暂时无法固定页面，请稍后重新开始。': ['The page could not be captured. Try starting again shortly.', 'ページを固定できませんでした。少し待ってから再開してください。'],
    '截图分析未完成，请重新生成地图或更换页面位置。': ['Screenshot analysis did not finish. Regenerate the maze or scroll to another part of the page.', 'スクリーンショットの解析が完了しませんでした。迷路を再生成するか、ページの別の位置でお試しください。'],
    '截图地图数据过大，请缩小浏览器窗口后重新生成。': ['The screenshot map is too large. Resize the browser window smaller and regenerate.', 'スクリーンショットのマップデータが大きすぎます。ブラウザーのウィンドウを小さくして再生成してください。'],
    '截图中未找到足够清晰的背景空隙，请更换页面位置后重试': ['No clear background space was found. Scroll to another part of the page and retry.', '十分な背景の空き領域が見つかりませんでした。ページの別の位置で再挑戦してください。'],
    '正在固定页面，请稍候再试。': ['Capturing the page. Please try again shortly.', 'ページを固定中です。少し待ってからお試しください。'],
    '无法读取当前游戏进度': ['Game progress could not be loaded.', 'ゲームの進行状況を読み込めませんでした。'],
    '本局成绩数据无效': ['This maze result is invalid.', '今回の結果データが無効です。'],
    '进度正在自动重试': ['Retrying progress save automatically.', '進行状況の保存を自動で再試行しています。'],
    '页面截图已取消': ['Page capture canceled.', 'ページの撮影がキャンセルされました。'],
    '固定页面超时，请保持当前标签页在前台后重试': ['Page capture timed out. Keep this tab active and retry.', 'ページの撮影がタイムアウトしました。このタブを前面にしたまま再試行してください。'],
    '请保持当前标签页在前台后重新固定页面': ['Keep this tab active and capture the page again.', 'このタブを前面にしたまま、ページを再撮影してください。'],
    '请先恢复触控手势缩放，再生成关卡；可使用浏览器菜单调整缩放': ['Reset pinch zoom before generating a maze. You can adjust zoom in the browser menu.', 'ピンチズームを元に戻してから迷路を生成してください。拡大率はブラウザーのメニューで変更できます。'],
    '当前环境不支持固定页面，请通过浏览器扩展启动': ['Page capture is unavailable here. Start from the browser extension.', 'この環境ではページを固定できません。ブラウザーの拡張機能から起動してください。'],
    '无法固定当前页面，请重新点击扩展后重试': ['This page could not be captured. Click the extension again to retry.', 'このページを固定できませんでした。拡張機能をもう一度クリックしてお試しください。'],
    '页面截图为空，请重试': ['The page capture is empty. Please retry.', 'ページのスクリーンショットが空です。再試行してください。'],
    '截图时窗口尺寸或缩放发生变化，请重试': ['The window size or zoom changed during capture. Please retry.', '撮影中にウィンドウサイズまたは拡大率が変わりました。再試行してください。'],
    '视口像素过多，请缩小浏览器窗口后重试': ['The viewport has too many pixels. Resize the browser window smaller and retry.', '画面の画素数が多すぎます。ブラウザーのウィンドウを小さくして再試行してください。'],
    '截图地图与当前视口尺寸不一致，请重新生成': ['The captured map no longer matches the viewport. Regenerate the maze.', '撮影したマップと現在の画面サイズが一致しません。迷路を再生成してください。'],
    '分析时窗口尺寸或缩放发生变化，请重试': ['The window size or zoom changed during analysis. Please retry.', '解析中にウィンドウサイズまたは拡大率が変わりました。再試行してください。'],
    '无法固定当前页面，请重试': ['This page could not be captured. Please retry.', 'このページを固定できませんでした。再試行してください。'],
    '窗口大小或缩放已变化，请重新生成关卡': ['The window size or zoom changed. Regenerate the maze.', 'ウィンドウサイズまたは拡大率が変わりました。迷路を再生成してください。'],
    '截图地图尺寸无效，请重新生成关卡。': ['The captured map size is invalid. Regenerate the maze.', '撮影したマップのサイズが無効です。迷路を再生成してください。'],
    '地图生成已取消': ['Maze generation canceled.', '迷路の生成がキャンセルされました。'],
    '截图尺寸无效，无法生成地图': ['The screenshot size is invalid. The maze could not be generated.', 'スクリーンショットのサイズが無効なため、迷路を生成できません。'],
    '当前视口过大，请缩小浏览器窗口后重新生成地图': ['The viewport is too large. Resize the browser window smaller and regenerate.', '画面が大きすぎます。ブラウザーのウィンドウを小さくして迷路を再生成してください。'],
    '迷宫没有可放置倍率泡泡的通道': ['No passage is available for a multiplier bubble.', '倍率バブルを配置できる通路がありません。'],
    '迷宫起点不在可通行区域': ['The maze start is outside the walkable area.', '迷路のスタートが通行可能な領域の外にあります。'],
    '迷宫连线缺少有效的地图或答案路线': ['Maze connections need a valid map and solution route.', '迷路を接続するための有効なマップまたは正解ルートがありません。'],
    '请先完成当前页面的截图分析': ['Finish analyzing this page capture first.', '先に現在のページのスクリーンショット解析を完了してください。'],
    '迷宫缺少有效截图地图': ['The maze needs a valid screenshot map.', '迷路に有効なスクリーンショットのマップがありません。'],
    '可用视口太小，请放大浏览器窗口后开始': ['The viewport is too small. Enlarge the browser window to start.', '画面が小さすぎます。ブラウザーのウィンドウを大きくして開始してください。'],
    '地图传输失败：{reason}': ['Map transfer failed: {reason}', 'マップの転送に失敗しました：{reason}'],
    '截图尺寸或轮廓长度无效': ['Invalid screenshot dimensions or contour length.', 'スクリーンショットのサイズまたは輪郭の長さが無効です。'],
    '地图数据过大，请缩小浏览器窗口后重试': ['The map is too large. Resize the browser window smaller and retry.', 'マップデータが大きすぎます。ブラウザーのウィンドウを小さくして再試行してください。'],
    '地图区域信息无效': ['Invalid map region data.', 'マップの領域情報が無効です。'],
    '地图区域信息无法编码': ['Map region data could not be encoded.', 'マップの領域情報をエンコードできませんでした。'],
    '地图区域信息过多，请换一个页面位置': ['Too many map regions. Try another part of the page.', 'マップの領域情報が多すぎます。ページの別の位置でお試しください。'],
    '压缩数据超过安全上限，请缩小浏览器窗口': ['Compressed data exceeds the limit. Resize the browser window smaller.', '圧縮データが上限を超えています。ブラウザーのウィンドウを小さくしてください。'],
    '压缩地图长度无效': ['Invalid compressed map length.', '圧縮マップの長さが無効です。'],
    '压缩地图编码无效': ['Invalid compressed map encoding.', '圧縮マップのエンコードが無効です。'],
    '压缩地图超过传输上限': ['The compressed map exceeds the transfer limit.', '圧縮マップが転送サイズの上限を超えています。'],
    '当前浏览器不支持地图压缩，请更新浏览器': ['This browser does not support map compression. Please update it.', 'このブラウザーはマップの圧縮に対応していません。ブラウザーを更新してください。'],
    '地图像素数据长度无效': ['Invalid map pixel data length.', 'マップのピクセルデータの長さが無効です。'],
    '只能传输截图像素地图': ['Only screenshot pixel maps can be transferred.', 'スクリーンショットのピクセルマップのみ転送できます。'],
    '地图压缩未完成': ['Map compression did not finish.', 'マップの圧縮が完了しませんでした。'],
    '地图超过浏览器消息大小上限': ['The map exceeds the browser message size limit.', 'マップがブラウザーのメッセージサイズの上限を超えています。'],
    '地图轮廓坐标无效': ['Invalid map contour coordinates.', 'マップの輪郭座標が無効です。'],
    '地图轮廓过于复杂，请换一个页面位置': ['Map contours are too complex. Try another part of the page.', 'マップの輪郭が複雑すぎます。ページの別の位置でお試しください。'],
    '地图数据格式或版本无效': ['Invalid map data format or version.', 'マップデータの形式またはバージョンが無効です。'],
    '地图数据长度与尺寸不符': ['Map data length does not match its dimensions.', 'マップデータの長さとサイズが一致しません。'],
    '压缩地图已损坏': ['The compressed map is damaged.', '圧縮マップが破損しています。'],
    '解压后的地图长度不符': ['The decompressed map length does not match.', '展開後のマップの長さが一致しません。'],
    '地图像素内容无效': ['Invalid map pixel data.', 'マップのピクセルデータが無効です。'],
  };
  const formatter = new Intl.NumberFormat(locale);
  function t(source, params = {}) {
    const pair = Object.hasOwn(messages, source) ? messages[source] : null;
    const template = locale === 'zh-CN' || !pair ? String(source) : pair[locale === 'ja' ? 1 : 0];
    return template.replace(/\{(\w+)\}/g, (token, key) => Object.hasOwn(params, key) ? String(params[key]) : token);
  }
  function error(message) {
    if (message === '') return '';
    if (typeof message !== 'string' || !message) return t('地图暂未准备好，请刷新后重试');
    const prefix = '地图传输失败：';
    if (message.startsWith(prefix)) {
      const reason = message.slice(prefix.length);
      return t('地图传输失败：{reason}', { reason: Object.hasOwn(messages, reason) ? t(reason) : t('地图暂未准备好，请刷新后重试') });
    }
    // Unknown engine errors are not suitable player instructions.
    return Object.hasOwn(messages, message) ? t(message) : t('地图暂未准备好，请刷新后重试');
  }
  const titles = ['萌新', '糕手', '吴迪', '？？？', '神仙'];
  const title = level => t(titles[Math.max(0, Math.min(4, Math.floor(Number(level) || 1) - 1))]);
  P.I18n = Object.freeze({ locale, t, error, title, number: value => formatter.format(value) });
})();
