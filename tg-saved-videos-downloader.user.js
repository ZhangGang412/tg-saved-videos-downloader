// ==UserScript==
// @name         Telegram 收藏视频批量下载器
// @name:en      Telegram Saved Messages Video Downloader
// @namespace    https://github.com/workbuddy/tg-saved-videos-downloader
// @version      1.3.0
// @description  扫描 Telegram Web 收藏夹（Saved Messages）中的全部视频，勾选后批量下载。双引擎：官方下载管线 + 分片流式下载（带进度与自定义命名）。WebK 与新版 WebA（CSS Modules 化后）均支持。
// @description:en  Scan all videos in Telegram Web Saved Messages, check and batch download. Dual engine: official download pipeline + chunked streaming download (with progress & custom naming). Supports WebK & WebA.
// @author       WorkBuddy
// @match        https://web.telegram.org/*
// @match        https://webk.telegram.org/*
// @match        https://webz.telegram.org/*
// @icon         https://web.telegram.org/favicon.ico
// @grant        none
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  使用说明                                                          ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║ 1. 安装本脚本到 Tampermonkey / Violentmonkey（需 Chrome/Edge）      ║
 * ║ 2. 打开 web.telegram.org 并登录（K 版 /k/ 与 A 版 /a/ 均支持：        ║
 * ║    K 版多一个「官方管线」引擎可选，大文件最稳；A 版走分片流式）        ║
 * ║ 3. 在左侧聊天列表打开「收藏 / Saved Messages」                      ║
 * ║ 4. 页面右上角出现「收藏视频下载器」面板：                             ║
 * ║    - [扫描当前]   扫描当前已加载到屏幕上的消息                       ║
 * ║    - [滚动扫描全部] 自动滚动到顶部，加载并登记全部历史视频            ║
 * ║    - 勾选想要的视频 → [下载选中] → 选择保存目录                      ║
 * ║ 5. 文件命名：原始文件名_消息ID.mp4；无文件名时 msg_消息ID_时间.mp4    ║
 * ║                                                                    ║
 * ║ 提示：                                                             ║
 * ║ - 大文件建议用 Chrome/Edge（分片引擎依赖目录流式写盘）               ║
 * ║ - 下载为串行队列（每项间隔 1 秒），这是大文件可靠性的关键             ║
 * ║ - 「官方管线」引擎文件名由 Telegram 决定（不含消息ID后缀）           ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

(function () {
  'use strict';

  /* ================================================================
   * [1] 常量与工具
   * ================================================================ */

  const VERSION = '1.3.0';
  const LS_KEY = 'tgsvd_settings_v1';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function sanitizeName(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
  }

  /** 折叠空白 + 截断的消息文本清洗 */
  function cleanCaptionText(t) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s ? s.slice(0, 200) : null;
  }

  /** 消息标题（caption）提取：克隆节点剥离时间戳等噪声后取纯文本
   *  WebA：.text-content（Message.tsx 全局类，caption 与文本共用）
   *  WebK：.bubble 内 .message */
  function extractCaptionText(el) {
    if (!el) return null;
    try {
      const clone = el.cloneNode(true);
      clone.querySelectorAll('.MessageMeta, .message-meta, .message-time, .time, .date, .replies, .reply-details')
        .forEach((n) => n.remove());
      const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      // 时间戳元素未能剥离时兜底：去掉尾部 "21:45"
      return cleanCaptionText(t.replace(/\s*\d{1,2}:\d{2}\s*$/, ''));
    } catch { return null; }
  }

  function extractCaption(bubbleEl) {
    return extractCaptionText(bubbleEl.querySelector(ENV.S.caption));
  }

  /** 列表/预览用展示名：文件名 > 消息标题 > msg_ID（实际命名另按设置优先级） */
  function displayName(meta) {
    return meta.fileName || meta.caption || `msg_${meta.mid}`;
  }

  /** 定位高亮样式（注入页面主文档，一次性） */
  let _locateStyleOk = false;
  function injectLocateStyle() {
    if (_locateStyleOk) return;
    try {
      const st = document.createElement('style');
      st.textContent = `
        @keyframes tgsvd-locate-flash {
          0%, 100% { box-shadow: 0 0 0 3px rgba(82,170,255,.95), 0 0 26px rgba(82,170,255,.5); }
          50% { box-shadow: 0 0 0 7px rgba(82,170,255,.30), 0 0 38px rgba(82,170,255,.22); }
        }
        .tgsvd-located {
          animation: tgsvd-locate-flash .9s ease-in-out 3 !important;
          outline: 2px solid rgba(82,170,255,.9) !important;
          outline-offset: 2px;
          border-radius: 10px;
          position: relative;
          z-index: 5;
        }`;
      (document.head || document.documentElement).appendChild(st);
      _locateStyleOk = true;
    } catch { /* ignore */ }
  }

  function formatSize(bytes) {
    if (!bytes || bytes <= 0) return '未知大小';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(n >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
  }

  /** HTML 转义（文件名等来自页面 DOM 的文本进入 innerHTML 前必须过一遍） */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  /** 列表项副标题：大小（高亮/未知）· 时长 · #mid */
  function subLineHtml(meta) {
    const dur = meta.duration ? formatDuration(meta.duration) : (meta.durationText || '');
    return [
      meta.size
        ? `<span class="sz">${esc(formatSize(meta.size))}</span>`
        : '<span class="unknown">大小未知</span>',
      dur ? esc(dur) : '',
      `#${esc(meta.mid)}`,
    ].filter(Boolean).join(' · ');
  }

  function formatDuration(sec) {
    if (!sec || sec <= 0) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0
      ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      : `${m}:${String(s).padStart(2, '0')}`;
  }

  function parseSizeText(text) {
    // "12.5 MB" / "1.2 GB" → 字节数；解析失败返回 0
    if (!text) return 0;
    const m = String(text).trim().match(/^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!m) return 0;
    const n = parseFloat(m[1].replace(',', ''));
    const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2].toUpperCase()];
    return Math.round(n * mult);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function formatDateTs(dateSecOrMs) {
    // 消息时间(unix 秒)或当前时间 → "20260815-143022"
    const d = dateSecOrMs > 1e12 ? new Date(dateSecOrMs) : new Date(dateSecOrMs * 1000);
    if (isNaN(d)) return String(Date.now());
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  }

  /** 生成保存文件名：按设置优先「消息标题 / 原始文件名」，统一追加消息 ID；
   *  两者皆无 → 回退「msg_消息ID_时间戳」 */
  function buildFileName(meta) {
    const ts = formatDateTs(meta.date || Date.now() / 1000);
    const preferCaption = settings.preferCaption !== false;
    const primary = preferCaption
      ? (meta.caption || meta.fileName)
      : (meta.fileName || meta.caption);
    if (primary) {
      const dot = primary.lastIndexOf('.');
      const hasExt = dot > 0 && dot >= primary.length - 6;
      const base = sanitizeName(hasExt ? primary.slice(0, dot) : primary);
      let ext = hasExt ? primary.slice(dot + 1) : '';
      if (!/^[a-z0-9]{1,5}$/i.test(ext)) {
        ext = (meta.mime || 'video/mp4').split('/')[1] || 'mp4';
        ext = ext.replace('quicktime', 'mov');
      }
      return `${base || 'msg'}_${meta.mid}.${ext}`;
    }
    const ext = ((meta.mime || 'video/mp4').split('/')[1] || 'mp4').replace('quicktime', 'mov');
    return `msg_${meta.mid}_${ts}.${ext}`;
  }

  function loadSettings() {
    try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LS_KEY) || '{}')); }
    catch { return Object.assign({}, DEFAULT_SETTINGS); }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
  }

  const DEFAULT_SETTINGS = {
    engine: 'b',          // 'auto' = 官方管线优先+分片回退 | 'k' = 仅官方管线 | 'b' = 仅分片流式（可自定义命名+进度）
    includeGif: true,     // 是否包含 GIF 动图（video/mp4 + animated 标记）
    includeRound: true,   // 是否包含圆形视频消息
    clearOnChatSwitch: true, // 切换聊天时清空扫描列表
    preferCaption: true,  // 命名优先用消息标题（caption）；关闭则优先原始文件名
  };

  /* ================================================================
   * [2] 环境检测 ENV（WebK / WebA 选择器适配层）
   * ================================================================ */

  const ENV = (() => {
    const p = location.pathname;
    const isK = location.hostname === 'webk.telegram.org' || p.startsWith('/k/');
    const isA = location.hostname === 'webz.telegram.org' || p.startsWith('/a/');
    if (!isK && !isA) return null;

    const S = isK ? {
      // ---- WebK (tweb) ----
      messageRoot: '#column-center .bubbles',
      bubble: '.bubble[data-mid]',
      midAttr: 'data-mid',
      peerAttr: 'data-peer-id',
      scrollEl: '.chat',
      videoMark: '.media-video, .document-wrapper, video, .video, .gif',
      thumb: 'img.thumbnail',
      mediaViewerVideo: '.ckin__player video, .media-viewer-whole video',
      viewerClose: '.media-viewer-whole .btn-icon',
      mediaClickTarget: '.media-video, .document-wrapper',
      caption: '.message',                 // WebK：气泡内文本/说明容器
    } : {
      // ---- WebA (webz / telegram-tt 2025+ CSS Modules 版) ----
      // 容器类名已哈希化（如 Y7owXZmb），只依赖稳定锚点：
      //   data 属性、内容区语义类名（.media-inner/.File）、.custom-scroll 滚动容器
      messageRoot: '[data-message-id]',   // 出现消息元素即视为聊天已打开
      bubble: '[data-message-id]',
      midAttr: 'data-message-id',
      peerAttr: '',                        // 消息元素无 peer 属性 → 用 URL hash 提取
      scrollEl: '.custom-scroll',
      videoMark: '.media-inner, .icon-large-play, video, .message-media-duration, .File',
      thumb: '.media-inner img',
      mediaViewerVideo: '',                // 用「点击前后 diff 新增 video」检测 viewer
      viewerClose: '[aria-label="Close"], button[aria-label="Close"], .close-button',
      mediaClickTarget: '.media-inner, .File .file-icon-container, .File',
      caption: '.text-content',            // WebA：caption/文本全局类（Message.tsx 确认非哈希）
    };
    return { isK, isA, S };
  })();

  if (!ENV) return; // 登录跳转页等场景，安静退出

  // @grant none 时脚本与页面共享 realm，window 即页面 window
  const page = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  /* ================================================================
   * [3] 注册表 REGISTRY（去重 + 抗虚拟滚动回收）
   * ================================================================ */

  const REGISTRY = new Map(); // key: `${peerId}_${mid}` → meta
  let settings = loadSettings();

  function registerVideo(meta) {
    if (REGISTRY.has(meta.key)) { REGISTRY.get(meta.key).lastSeen = Date.now(); return false; }
    meta.status = 'idle'; // idle | queued | downloading | done | failed
    meta.error = null;
    REGISTRY.set(meta.key, meta);
    UI.appendItem(meta);
    return true;
  }

  /** WebK：查询消息对象。注意 getMessageByPeer 返回 Promise（异步 API），需兼容同步实现并加超时防卡 */
  async function lookupMessage(peerId, mid) {
    const fn = page.mtprotoMessagePort?.getMessageByPeer;
    if (typeof fn !== 'function') return null;
    try {
      const r = fn.call(page.mtprotoMessagePort, String(peerId), Number(mid));
      // 兼容同步 / 异步两种实现
      const msg = (r && typeof r.then === 'function') ? await Promise.race([
        r,
        new Promise((_, rej) => setTimeout(() => rej(new Error('lookup timeout')), 3000)),
      ]) : r;
      return msg || null;
    } catch { return null; }
  }

  /** WebA：消息元素无 peer 属性，从 URL hash（如 #-im?p=u123）提取；仅用于列表去重 key */
  function currentPeerId() {
    const m = (location.hash || '').match(/[?&]p=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : 'saved';
  }

  /** "1:23" / "1:02:03" / "GIF" 文本 → 秒数（GIF 返回 null，由调用方按 isGif 语义处理） */
  function parseDurationText(text) {
    if (!text) return null;
    const dm = String(text).match(/(\d+):(\d{1,2})(?::(\d{1,2}))?/);
    if (!dm) return null;
    return dm[3] !== undefined ? +dm[1] * 3600 + +dm[2] * 60 + +dm[3] : +dm[1] * 60 + +dm[2];
  }

  /** 内部 API 是否可用（用于启动诊断与引擎可用性判断） */
  function internalApiOk() {
    return typeof page.mtprotoMessagePort?.getMessageByPeer === 'function';
  }

  /** 从消息对象提取视频 document（排除图片/音频/普通文件；按设置过滤 GIF 与圆形视频） */
  function videoDocOf(msg) {
    const doc = msg?.media?.document;
    if (!doc) return null;
    const mime = doc.mime_type || '';
    if (!mime.startsWith('video/')) return null;
    const attrs = doc.attributes || [];
    const isAnimated = attrs.some((a) => a?._ === 'documentAttributeAnimated');
    const videoAttr = attrs.find((a) => a?._ === 'documentAttributeVideo');
    const isRound = !!(videoAttr?.round_message ?? videoAttr?.roundMessage);
    if (isAnimated && !settings.includeGif) return null;
    if (isRound && !settings.includeRound) return null;
    return doc;
  }

  /* ================================================================
   * [4] 元数据提取 Meta
   * ================================================================ */

  function docFileName(doc) {
    return doc.file_name
      ?? doc.attributes?.find?.((a) => a?._ === 'documentAttributeFilename')?.file_name
      ?? null;
  }

  const Meta = {
    async extract(peerId, mid, bubbleEl) {
      return ENV.isK ? this.extractK(peerId, mid, bubbleEl) : this.extractA(peerId, mid, bubbleEl);
    },

    /** WebK：优先从内部 API 取消息对象（真相源）；API 不可用/失败时回退 DOM 判断 */
    async extractK(peerId, mid, bubbleEl) {
      if (internalApiOk()) {
        try {
          const msg = await lookupMessage(peerId, mid);
          const doc = videoDocOf(msg);
          if (doc) {
            return {
              key: `${peerId}_${mid}`, peerId: String(peerId), mid: String(mid),
              fileName: docFileName(doc),
              caption: cleanCaptionText(msg?.content?.text?.text) || extractCaption(bubbleEl),
              size: doc.size ?? 0,
              mime: doc.mime_type,
              duration: videoDurationOf(doc),
              date: msg?.date ?? null,
              thumb: captureThumb(bubbleEl.querySelector(ENV.S.thumb)),
              via: 'api',
            };
          }
          // API 查到了消息但不是视频 → 明确排除，无需 DOM 兜底
          if (msg) return null;
        } catch { /* 落入 DOM 兜底 */ }
      }
      return this.fromDomK(peerId, mid, bubbleEl);
    },

    /** WebK DOM 兜底：内部 API 缺失/超时/异常时，直接从气泡 DOM 判定视频 */
    fromDomK(peerId, mid, bubbleEl) {
      const hasVideoEl = !!bubbleEl.querySelector('video');
      const hasMediaVideo = !!bubbleEl.querySelector('.media-video');
      const title = bubbleEl.querySelector('.document-title')?.textContent?.trim() || null;
      const isVideoDoc = !!(
        bubbleEl.querySelector('.document-wrapper') &&
        title && /\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v|ts|3gp|mpg|mpeg)$/i.test(title)
      );
      if (!hasVideoEl && !hasMediaVideo && !isVideoDoc) return null;
      // GIF（documentAttributeAnimated 在 DOM 上体现为 .gif 类）按设置过滤
      const looksGif = !!bubbleEl.querySelector('.gif, .media-gif');
      if (looksGif && !settings.includeGif) return null;
      const durText = bubbleEl.querySelector('.media-duration')?.textContent?.trim() || '';
      return {
        key: `${peerId}_${mid}`, peerId: String(peerId), mid: String(mid),
        fileName: title,
        caption: extractCaption(bubbleEl),
        size: parseSizeText(bubbleEl.querySelector('.document-size, .file-size')?.textContent),
        mime: null, // 下载时从 stream URL / Content-Type 回补
        duration: parseDurationText(durText),
        date: null,
        thumb: captureThumb(bubbleEl.querySelector(ENV.S.thumb)),
        via: 'dom',
      };
    },

    /** WebA（新版 telegram-tt）：纯锚点判定，不依赖任何容器类名。
     *  媒体型视频：.media-inner 内含播放按钮 / 内联 video / 时长徽标（纯图片的 media-inner 没有这些）
     *  文件型视频：.File 气泡 + .file-title 的文件名是视频扩展名
     *  两者均为 camelCase ApiVideo 的 DOM 侧等价判定（源码锚点：Video.tsx / File.tsx） */
    async extractA(peerId, mid, bubbleEl) {
      let mediaEl = null, durationText = null;
      for (const m of bubbleEl.querySelectorAll('.media-inner')) {
        const hasVideoMark = m.querySelector('.icon-large-play, video, .message-media-duration, .media-loading');
        if (!hasVideoMark) continue; // 纯图片（含相册中的照片格）→ 跳过
        mediaEl = m;
        durationText = m.querySelector('.message-media-duration')?.textContent?.trim() || null;
        break;
      }
      if (mediaEl) {
        if (durationText === 'GIF' && !settings.includeGif) return null;
        return {
          key: `${peerId}_${mid}`, peerId: String(peerId), mid: String(mid),
          fileName: null, // 媒体型气泡不显示文件名，下载时从 stream URL / Content-Type 回补
          caption: extractCaption(bubbleEl), // 消息标题（caption）优先用于命名
          size: 0,        // 同上，下载时从 Content-Range 回补
          mime: null,
          duration: parseDurationText(durationText),
          durationText,
          date: null,
          thumb: captureThumb(mediaEl.querySelector('img.thumbnail, img')),
          via: 'dom',
        };
      }
      // 文件型视频：新版 File 组件保留语义类名（.File/.file-title/.file-subtitle）
      const fileEl = bubbleEl.querySelector('.File');
      if (fileEl) {
        const titleEl = fileEl.querySelector('.file-title');
        const title = titleEl?.getAttribute('title') || titleEl?.textContent?.trim() || null;
        if (title && /\.(mp4|mkv|mov|avi|webm|flv|wmv|m4v|ts|3gp|mpg|mpeg)$/i.test(title)) {
          const subText = (fileEl.querySelector('.file-subtitle')?.textContent || '').trim();
          // "12.5 MB · finger" → 取小圆点前的尺寸部分
          const sizePart = subText.split('•')[0].trim();
          return {
            key: `${peerId}_${mid}`, peerId: String(peerId), mid: String(mid),
            fileName: title,
            caption: extractCaption(bubbleEl),
            size: parseSizeText(sizePart),
            mime: null,
            duration: null, durationText: null,
            date: null,
            thumb: captureThumb(fileEl.querySelector('img')),
            via: 'dom',
          };
        }
      }
      return null;
    },
  };

  function videoDurationOf(doc) {
    // documentAttributeVideo.duration（秒）
    const attr = (doc.attributes || []).find((a) => a?._ === 'documentAttributeVideo');
    return attr?.duration ?? doc.duration ?? null;
  }

  /** 缩略图立即转 dataURL 固化（blob URL 会被回收失效） */
  function captureThumb(imgEl) {
    if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return null;
    try {
      const c = document.createElement('canvas');
      const w = 128, h = Math.max(1, Math.round(imgEl.naturalHeight * w / imgEl.naturalWidth));
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(imgEl, 0, 0, w, h);
      return c.toDataURL('image/jpeg', 0.72);
    } catch { return null; } // 跨域画布污染等
  }

  /** 从 WebK 的 stream URL（stream/{json}）解析原始文件名与 mime（Neet-Nestor 验证的格式） */
  function parseStreamUrlMeta(url) {
    try {
      const last = url.split('/').pop();
      const json = decodeURIComponent(last);
      if (!json.startsWith('{')) return null;
      const m = JSON.parse(json);
      return { fileName: m.fileName || null, mime: m.mimeType || null, size: m.size || 0 };
    } catch { return null; }
  }

  /* ================================================================
   * [5] 扫描器 Scanner（MutationObserver + 防抖）
   * ================================================================ */

  const Scanner = {
    _t: null,
    _scanning: false,
    enabled: true,

    start() {
      const mo = new MutationObserver(() => this.scheduleScan());
      mo.observe(document.body, { childList: true, subtree: true });
      // 捕获阶段监听滚动：滚动容器不是 window，虚拟滚动会回收/重挂节点
      window.addEventListener('scroll', () => this.scheduleScan(), true);
      this.scan();
    },

    scheduleScan() {
      if (!this.enabled) return;
      clearTimeout(this._t);
      this._t = setTimeout(() => { this.scan(); }, 300);
    },

    /** 扫描当前 DOM 中已加载的消息气泡，登记视频。返回 { added, funnel } */
    async scan(verbose) {
      if (!document.querySelector(ENV.S.messageRoot)) return { added: 0, funnel: null }; // 聊天未打开
      if (this._scanning) return { added: 0, funnel: null }; // 重入保护：异步查询未完成时跳过本轮
      this._scanning = true;
      // 漏斗统计：定位"扫描不到"卡在哪一环
      const f = { bubbles: 0, withMid: 0, marked: 0, apiHit: 0, domHit: 0, apiMiss: 0, added: 0 };
      try {
        // WebK: '.bubble[data-mid]'；WebA: '[data-message-id]'（均为带属性的完整选择器）
        const bubbles = document.querySelectorAll(ENV.S.bubble);
        for (const b of bubbles) {
          f.bubbles++;
          const rawMid = b.getAttribute(ENV.S.midAttr);
          const mid = parseInt(rawMid, 10);
          if (!mid || mid <= 0) continue; // 负数=发送中临时消息；NaN=service 消息
          const peerId = (ENV.S.peerAttr && b.getAttribute(ENV.S.peerAttr))
            || b.closest('[data-peer-id]')?.getAttribute('data-peer-id')
            || (ENV.isA ? currentPeerId() : null); // WebA：URL hash 提取
          if (!peerId) continue;
          f.withMid++;
          // 快速预筛：气泡内无视频标记就不走元数据提取（标记放宽：video 元素也算）
          if (!b.querySelector(ENV.S.videoMark)) continue;
          f.marked++;
          const meta = await Meta.extract(peerId, mid, b);
          if (!meta) { f.apiMiss++; continue; }
          if (meta.via === 'api') f.apiHit++; else f.domHit++;
          if (registerVideo(meta)) f.added++;
        }
      } finally {
        this._scanning = false;
      }

      UI.updateStatus(`消息 ${f.withMid} · 视频 ${REGISTRY.size} 个` + (f.added ? ` · 新增 ${f.added}` : ''));
      UI.updateDownloadButton();
      if (verbose) {
        const parts = [
          `气泡 ${f.bubbles}`, `有效 ${f.withMid}`,
          `视频标记 ${f.marked}`,
          ENV.isK ? `API识别 ${f.apiHit} / DOM识别 ${f.domHit}` : `DOM识别 ${f.domHit}`,
          `新增 ${f.added}`,
        ];
        if (f.marked === 0 && f.withMid > 0) {
          UI.log(`[诊断] 当前视图未发现视频气泡（消息 ${f.withMid} 条）。若收藏里确有视频，请滚动到视频所在位置再扫`, 'warn');
        } else if (f.marked > 0 && f.apiHit + f.domHit === 0 && ENV.isK) {
          UI.log(`[诊断] 发现 ${f.marked} 个疑似视频但全部识别失败：内部API ${internalApiOk() ? '存在但查询未命中' : '不可用（已用DOM兜底仍失败）'}，请反馈控制台报错`, 'error');
        } else {
          UI.log(`[诊断] ${parts.join(' · ')}`);
        }
      }
      return { added: f.added, funnel: f };
    },
  };

  /* ================================================================
   * [6] 滚动泵 ScrollPump（自动滚动加载全部历史）
   * ================================================================ */

  const ScrollPump = {
    running: false, abort: false,
    MAX_IDLE_ROUNDS: 6,
    ROUND_DELAY: 1300,

    getScrollContainer() {
      // 从消息根向上找真正可滚动的元素（对两版都稳）
      let el = document.querySelector(ENV.S.messageRoot) || document.querySelector(ENV.S.bubble);
      while (el && el !== document.body) {
        const st = getComputedStyle(el);
        if (el.scrollHeight > el.clientHeight + 50 && st.overflowY !== 'visible') return el;
        el = el.parentElement;
      }
      return document.querySelector(ENV.S.scrollEl) || document.scrollingElement;
    },

    async run() {
      if (this.running) { UI.log('扫描已在进行中'); return; }
      this.running = true; this.abort = false;
      UI.setBusy(true, 'scan');
      const box = this.getScrollContainer();
      if (!box) { UI.log('未找到消息滚动容器，请先打开一个聊天', 'error'); this.running = false; UI.setBusy(false); return; }

      UI.log('开始滚动扫描（自动加载全部历史，可随时点停止）…');
      let idle = 0, lastCount = REGISTRY.size, round = 0;
      while (!this.abort && idle < this.MAX_IDLE_ROUNDS) {
        round++;
        box.scrollTop = 0; // 顶到头触发加载更早历史
        await sleep(this.ROUND_DELAY);
        await Scanner.scan();
        if (REGISTRY.size > lastCount) { idle = 0; lastCount = REGISTRY.size; UI.setStatusScanning(`第 ${round} 轮 · 视频 ${REGISTRY.size}`); }
        else { idle++; UI.setStatusScanning(`第 ${round} 轮 · 无新增 (${idle}/${this.MAX_IDLE_ROUNDS})`); }
      }

      // 滚回底部方便查看
      try { box.scrollTop = box.scrollHeight; } catch { /* ignore */ }
      this.running = false;
      UI.setBusy(false);
      UI.log(`扫描完成：共登记 ${REGISTRY.size} 个视频${this.abort ? '（用户停止）' : ''}`);
      UI.updateStatus(`视频 ${REGISTRY.size} 个`);
    },

    stop() { this.abort = true; },
  };

  /* ================================================================
   * [7] 触发加载 TriggerLoader（打开媒体查看器抓 video.src）
   * ================================================================ */

  const TriggerLoader = {
    /** 让指定视频完成加载并返回可下载 URL；完成后自动关闭查看器 */
    async load(meta) {
      const bubble = document.querySelector(`[${ENV.S.midAttr}="${meta.mid}"]`);
      if (!bubble) throw new Error('消息不在当前视图（已被虚拟滚动回收），请先在聊天中滚到该消息附近再下载');

      // 点击前快照：用于 diff 检测 viewer 打开后新出现的 video（WebA viewer 容器类名已哈希化）
      const beforeSet = new Set(document.querySelectorAll('video'));
      const hadSrcBefore = new Set(
        [...document.querySelectorAll('video')].filter((v) => v.src || v.currentSrc)
      );

      const clickTarget = bubble.querySelector(ENV.S.mediaClickTarget) || bubble;
      clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      // 三层检测：① WebK 精确选择器 ② 点击后新增的 video（viewer） ③ 已有 video 新获得 src
      const video = await this.waitFor(() => {
        if (ENV.S.mediaViewerVideo) {
          const exact = document.querySelector(ENV.S.mediaViewerVideo);
          if (exact) return exact;
        }
        const all = document.querySelectorAll('video');
        for (const v of all) {
          if (!beforeSet.has(v) && (v.src || v.currentSrc)) return v;
        }
        for (const v of all) {
          if ((v.src || v.currentSrc) && !hadSrcBefore.has(v)) return v;
        }
        return null;
      }, 7000);
      if (!video) { this.closeViewer(); throw new Error('未能打开媒体查看器'); }

      let url = null;
      try {
        await this.waitFor(() => (video.src || video.currentSrc) || null, 9000);
        url = video.src || video.currentSrc;
      } catch { /* 超时继续，下面兜底 */ }

      this.closeViewer();
      if (!url) throw new Error('视频地址未就绪（可重试）');
      return url;
    },

    closeViewer() {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
      }));
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
      }));
      // Esc 不生效时点关闭按钮兜底
      setTimeout(() => {
        const probe = ENV.S.mediaViewerVideo
          ? document.querySelector(ENV.S.mediaViewerVideo)
          : document.querySelector('video');
        if (!probe) return;
        const btn = document.querySelector(`${ENV.S.viewerClose}, .MediaViewer button[aria-label="Close"], .media-viewer-whole .btn-icon.tgico-close`);
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }, 300);
    },

    waitFor(getter, timeout) {
      return new Promise((resolve, reject) => {
        const t0 = Date.now();
        (function tick() {
          const v = getter();
          if (v) return resolve(v);
          if (Date.now() - t0 > timeout) return reject(new Error('等待超时'));
          setTimeout(tick, 200);
        })();
      });
    },
  };

  /* ================================================================
   * [8] 下载引擎 ENGINE
   *    engineK：WebK 官方下载管线（downloadToDisc，大文件最稳）
   *    engineB：分片 Range + 目录流式写盘（自定义命名 + 进度）
   * ================================================================ */

  const engineK = {
    name: '官方管线',
    available: () => ENV.isK && !!page.appDownloadManager?.downloadToDisc && internalApiOk(),
    async download(meta, onProgress) {
      const msg = await lookupMessage(meta.peerId, meta.mid);
      const media = msg?.media?.document || msg?.media?.photo;
      if (!media) throw new Error('消息对象未找到（请回到原聊天滚动加载后重试）');
      onProgress({ stage: 'downloading', pct: -1 }); // 官方管线无进度回调，显示"进行中"
      // 参数签名与社区验证一致：{ message, media }（缺 message 时部分版本会静默失败）
      await page.appDownloadManager.downloadToDisc({ message: msg, media });
      // 文件由浏览器下载管理器接管，保存名由 Telegram 决定（原始文件名）
      onProgress({ stage: 'done', pct: 100 });
    },
  };

  const engineB = {
    name: '分片流式',
    dirHandle: null, // 会话级目录句柄（批量只选一次目录）

    resetDir() { this.dirHandle = null; UI.updateDirLabel(); },

    async ensureDir() {
      if (this.dirHandle) return this.dirHandle;
      if (typeof page.showDirectoryPicker !== 'function') {
        throw new Error('当前浏览器不支持目录保存（请用 Chrome/Edge，或切换到官方管线引擎）');
      }
      this.dirHandle = await page.showDirectoryPicker({ mode: 'readwrite' });
      UI.updateDirLabel();
      return this.dirHandle;
    },

    /** 取可下载 URL：找已加载的 video 元素，否则触发查看器加载 */
    async resolveStreamUrl(meta) {
      const inBubble = document.querySelector(`[${ENV.S.midAttr}="${meta.mid}"] video`);
      const inViewer = ENV.S.mediaViewerVideo ? document.querySelector(ENV.S.mediaViewerVideo) : null;
      for (const el of [inBubble, inViewer]) {
        if (el) {
          const u = el.src || el.currentSrc;
          if (u) return u;
        }
      }
      const url = await TriggerLoader.load(meta);
      // WebK：stream URL 自带原始文件名/mime → 回补元数据
      if (!meta.fileName) {
        const sm = parseStreamUrlMeta(url);
        if (sm) {
          meta.fileName = sm.fileName;
          if (sm.mime) meta.mime = sm.mime;
          if (sm.size && !meta.size) meta.size = sm.size;
          UI.refreshItem(meta);
        }
      }
      return url;
    },

    async download(meta, onProgress) {
      const url = await this.resolveStreamUrl(meta);
      const fileName = buildFileName(meta);
      const dir = await this.ensureDir();
      const fh = await dir.getFileHandle(fileName, { create: true });
      const writable = await fh.createWritable();
      try {
        const isBlob = url.startsWith('blob:');
        let offset = 0, total = Infinity;

        if (isBlob) {
          // blob URL 不支持 Range → 流式读 body 写盘（内存占用 ≈ 单 chunk）
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value && value.byteLength) {
                  await writable.write(value);
                  offset += value.byteLength;
                  onProgress({
                    stage: 'downloading',
                    pct: meta.size ? Math.min(99, Math.round(offset / meta.size * 100)) : -1,
                    bytes: offset,
                  });
                }
              }
            } finally { try { await reader.cancel(); } catch { /* ignore */ } }
          } else {
            const buf = await res.arrayBuffer();
            await writable.write(buf);
            offset = buf.byteLength;
          }
          // blob 无 Content-Length → 读完才知道总大小，回补元数据
          if (offset) {
            const changed = meta.size !== offset;
            meta.size = offset;
            if (changed) UI.refreshItem(meta);
          }
          total = offset;
        } else {
          // stream URL 支持 Range → 分片流式写盘（内存占用 ≈ 单片大小）
          let mime = meta.mime;
          while (offset < total) {
            const res = await fetch(url, { headers: { Range: `bytes=${offset}-` } });
            if (res.status !== 200 && res.status !== 206) throw new Error(`HTTP ${res.status}`);
            const ctype = res.headers.get('Content-Type');
            if (ctype && !mime && ctype.startsWith('video/')) mime = meta.mime = ctype.split(';')[0];
            const cr = res.headers.get('Content-Range'); // "bytes start-end/total"
            const m = cr?.match(/^bytes (\d+)-(\d+)\/(\d+)/);
            if (!m) {
              // 服务器不支持 Range → 整包
              const buf = await res.arrayBuffer();
              await writable.write(buf);
              total = offset = buf.byteLength;
              break;
            }
            const [, s, e, t] = m.map(Number);
            if (s !== offset) throw new Error(`分片错位（期望 ${offset}，收到 ${s}）`);
            total = t;
            // 首个分片即知总大小 → 回补列表显示（服务器权威，覆盖估算值）
            if (t && meta.size !== t) { meta.size = t; UI.refreshItem(meta); }
            await writable.write(await res.arrayBuffer());
            offset = e + 1;
            onProgress({ stage: 'downloading', pct: Math.min(99, Math.round(offset / total * 100)) });
          }
        }
        await writable.close();
        onProgress({ stage: 'done', pct: 100 });
        return fileName;
      } catch (err) {
        try { await writable.abort(); } catch { /* ignore */ }
        throw err;
      }
    },
  };

  /** 引擎分发：按设置选择，auto = 官方管线优先、失败回退分片 */
  async function downloadOne(meta, onProgress) {
    const pref = settings.engine;
    if (pref === 'k') {
      if (!engineK.available()) throw new Error('官方管线不可用（仅 WebK 支持且内部接口存在时可用）');
      return engineK.download(meta, onProgress);
    }
    if (pref === 'b') return engineB.download(meta, onProgress);
    // auto
    if (engineK.available()) {
      try { return await engineK.download(meta, onProgress); }
      catch (e) { UI.log(`官方管线失败（${e.message}），回退分片引擎`, 'warn'); }
    }
    return engineB.download(meta, onProgress);
  }

  /* ================================================================
   * [9] 下载队列 Queue（串行 + 间隔 —— 大文件可靠性的关键）
   * ================================================================ */

  const Queue = {
    running: false,
    abort: false,
    GAP_MS: 1000,

    stop() { this.abort = true; },

    async start(metas) {
      if (this.running) { UI.log('已有下载任务进行中'); return; }
      if (!metas.length) { UI.log('请先勾选要下载的视频'); return; }

      this.running = true;
      this.abort = false;
      UI.setBusy(true, 'download');
      // 按消息 ID 升序（时间从旧到新）
      metas.sort((a, b) => Number(a.mid) - Number(b.mid));
      metas.forEach((m) => { m.status = 'queued'; UI.refreshItem(m); });

      UI.log(`开始批量下载 ${metas.length} 个文件（串行，间隔 ${this.GAP_MS}ms）`);
      let ok = 0, aborted = false;

      for (let i = 0; i < metas.length; i++) {
        if (this.abort) { aborted = true; metas.slice(i).forEach((m) => { m.status = 'idle'; UI.refreshItem(m); }); UI.log('已停止下载（剩余项回到待下载状态）', 'warn'); break; }
        const meta = metas[i];
        UI.updateDownloadButton(`${i + 1}/${metas.length}`);
        meta.status = 'downloading'; UI.refreshItem(meta);
        try {
          const name = await downloadOne(meta, (p) => UI.setProgress(meta, p));
          meta.status = 'done'; ok++;
          UI.log(`✓ (${i + 1}/${metas.length}) ${name || buildFileName(meta)}`);
        } catch (e) {
          if (this.abort) { meta.status = 'idle'; UI.refreshItem(meta); aborted = true; UI.log('已停止下载', 'warn'); break; }
          meta.status = 'failed'; meta.error = e.message;
          UI.log(`✗ (${i + 1}/${metas.length}) ${buildFileName(meta)} — ${e.message}`, 'error');
        }
        UI.refreshItem(meta);
        if (i < metas.length - 1) await sleep(this.GAP_MS);
      }

      this.running = false;
      UI.setBusy(false);
      UI.updateDownloadButton();
      if (!aborted) UI.log(`批量下载结束：成功 ${ok}/${metas.length}` + (ok < metas.length ? '，失败项可重新勾选再试' : ' 🎉'));
    },
  };

  /* ================================================================
   * [10] 悬停预览卡 Preview（毛玻璃 · 跟随列表项 · 自动翻转防出界）
   * ================================================================ */

  const Preview = {
    visible: false,
    currentKey: null,
    _showT: null,
    _hideT: null,

    el() { return UI.shadow?.getElementById('preview'); },

    /** 悬停列表项 320ms 后展示 */
    showFor(meta, row) {
      clearTimeout(this._hideT);
      clearTimeout(this._showT);
      this._showT = setTimeout(() => {
        const card = this.el();
        if (!card) return;
        this.render(meta);
        this.place(row);
        card.classList.add('show');
        this.visible = true;
        this.currentKey = meta.key;
      }, 320);
    },

    /** 离开 80ms 后隐藏（防抖） */
    hideSoon() {
      clearTimeout(this._showT);
      this._hideT = setTimeout(() => this.hide(), 80);
    },

    hide() {
      const card = this.el();
      if (card) card.classList.remove('show');
      this.visible = false;
      this.currentKey = null;
    },

    render(meta) {
      const card = this.el();
      if (!card) return;
      const isGif = meta.durationText === 'GIF';
      const badge = isGif ? 'GIF' : (meta.duration ? formatDuration(meta.duration) : (meta.durationText || '视频'));
      const ext = (meta.fileName?.match(/\.([a-z0-9]+)$/i)?.[1] || (meta.mime?.split('/')[1]) || 'mp4').toUpperCase();
      const dur = meta.duration ? formatDuration(meta.duration) : (meta.durationText && !isGif ? meta.durationText : '');
      const cap = meta.caption && meta.caption !== displayName(meta)
        ? `<div class="pv-cap" title="${esc(meta.caption)}">💬 ${esc(meta.caption)}</div>` : '';
      card.innerHTML = `
        <div class="pv-thumb">
          ${meta.thumb ? `<img src="${esc(meta.thumb)}" alt="">` : '<span class="ph">🎬</span>'}
          <span class="play">▶</span>
          <span class="badge">${esc(badge)}</span>
        </div>
        <div class="pv-name">${esc(displayName(meta))}</div>
        ${cap}
        <div class="pv-grid">
          <span class="k">文件大小</span><span class="v ${meta.size ? 'hl' : ''}">${meta.size ? esc(formatSize(meta.size)) : '下载时自动获取'}</span>
          ${dur ? `<span class="k">时长</span><span class="v">${esc(dur)}</span>` : ''}
          <span class="k">格式</span><span class="v">${esc(ext)}</span>
          <span class="k">消息 ID</span><span class="v">#${esc(meta.mid)}</span>
        </div>
        <div class="pv-hint">点击列表项可定位到该消息</div>`;
    },

    /** 贴着列表项定位：优先左侧，空间不足翻到右侧；垂直居中并夹在视口内 */
    place(row) {
      const card = this.el();
      if (!card) return;
      const CW = 268, GAP = 14;
      const r = row.getBoundingClientRect();
      const vh = window.innerHeight;
      let left = r.left - CW - GAP;
      if (left < 8) left = Math.min(r.right + GAP, window.innerWidth - CW - 8);
      card.style.left = Math.max(8, left) + 'px';
      // 先量实际高度再垂直居中
      card.style.visibility = 'hidden';
      card.classList.add('show');
      const h = card.offsetHeight || 240;
      card.classList.remove('show');
      card.style.visibility = '';
      let top = r.top + r.height / 2 - h / 2;
      top = Math.max(8, Math.min(top, vh - h - 8));
      card.style.top = top + 'px';
    },
  };

  /* ================================================================
   * [11] UI 面板（Shadow DOM，防 Telegram 样式污染）
   * ================================================================ */

  const UI = {
    host: null, shadow: null,
    collapsed: false,
    _logLines: 0,

    init() {
      const host = document.createElement('div');
      host.id = 'tgsvd-host';
      host.style.cssText = 'position:fixed;top:72px;right:16px;z-index:2147483600;';
      document.body.appendChild(host);

      const shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", system-ui, Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }

          /* ---- 毛玻璃面板 ---- */
          .panel {
            width: 384px; max-height: 78vh; display: flex; flex-direction: column;
            position: relative; overflow: hidden;
            background: linear-gradient(160deg, rgba(30,33,46,.74), rgba(15,17,25,.62));
            -webkit-backdrop-filter: blur(26px) saturate(1.65);
            backdrop-filter: blur(26px) saturate(1.65);
            border: 1px solid rgba(255,255,255,.10);
            border-radius: 18px;
            box-shadow: 0 18px 50px rgba(0,0,0,.45), 0 2px 8px rgba(0,0,0,.3), inset 0 1px 0 rgba(255,255,255,.09);
            color: #eef0f6; font-size: 13px; line-height: 1.45;
          }
          .panel::before { /* 顶部渐变光带 */
            content: ''; position: absolute; top: 0; left: 14%; right: 14%; height: 1.5px;
            background: linear-gradient(90deg, transparent, #6d8bff, #b06bff, #6dd8ff, transparent);
            opacity: .85; pointer-events: none;
          }
          .bar { display: flex; gap: 7px; padding: 9px 12px; align-items: center; flex-wrap: wrap; }

          /* ---- 标题栏 ---- */
          .titlebar { cursor: move; user-select: none; padding-top: 12px; }
          .titlebar .logo {
            width: 22px; height: 22px; flex: none; border-radius: 8px; display: inline-flex;
            align-items: center; justify-content: center; font-size: 12px;
            background: linear-gradient(135deg, #6d8bff, #b06bff);
            box-shadow: 0 3px 10px rgba(125,110,255,.45);
          }
          .titlebar b { flex: 1; font-size: 13.5px; font-weight: 650; letter-spacing: .2px;
            display: flex; align-items: center; gap: 8px; min-width: 0; }
          .titlebar .eng {
            color: #9db8ff; font-size: 10.5px; font-weight: 500; padding: 2px 8px;
            background: rgba(109,139,255,.14); border: 1px solid rgba(109,139,255,.28);
            border-radius: 99px; white-space: nowrap;
          }

          /* ---- 按钮 ---- */
          button {
            border: 0; border-radius: 9px; padding: 6px 12px; cursor: pointer; font-size: 12px;
            color: #fff; background: linear-gradient(135deg, #6d8bff, #9a6bff);
            box-shadow: 0 3px 12px rgba(120,105,255,.32), inset 0 1px 0 rgba(255,255,255,.18);
            transition: filter .15s, transform .15s, box-shadow .15s;
          }
          button:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
          button:active:not(:disabled) { transform: translateY(0); filter: brightness(.96); }
          button:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }
          button.sec {
            background: rgba(255,255,255,.07); border: 1px solid rgba(255,255,255,.14);
            box-shadow: none; color: #d6dae4;
          }
          button.sec:hover:not(:disabled) { background: rgba(255,255,255,.13); }
          button.warn { background: linear-gradient(135deg, #e08a4c, #d05f5f); }
          .minibtn { font-size: 11px; padding: 3px 9px; }

          .stat { color: #9aa3b2; font-size: 11px; flex: 1; text-align: right; }
          .dirrow { font-size: 11px; color: #9aa3b2; }
          .dirrow .dname { color: #8fd8a8; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

          /* ---- 列表 ---- */
          .list { overflow-y: auto; flex: 1; min-height: 64px; padding: 4px 0;
            border-top: 1px solid rgba(255,255,255,.07); border-bottom: 1px solid rgba(255,255,255,.07); }
          .list::-webkit-scrollbar, .log::-webkit-scrollbar { width: 6px; }
          .list::-webkit-scrollbar-thumb, .log::-webkit-scrollbar-thumb {
            background: rgba(255,255,255,.14); border-radius: 3px; }
          .list::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,.25); }
          .empty { padding: 26px 12px; text-align: center; color: #7d8696; font-size: 12px; line-height: 1.8; }

          .item {
            position: relative; display: flex; gap: 9px; margin: 3px 8px; padding: 7px 9px;
            align-items: center; border-radius: 11px; overflow: hidden;
            transition: background .15s; cursor: pointer;
          }
          .item:hover { background: rgba(255,255,255,.065); }
          .item input[type=checkbox] {
            width: 15px; height: 15px; flex: none; cursor: pointer;
            accent-color: #7b9bff;
          }
          .thumb {
            width: 66px; height: 38px; flex: none; border-radius: 7px; overflow: hidden;
            background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center;
            border: 1px solid rgba(255,255,255,.08);
          }
          .thumb img { width: 100%; height: 100%; object-fit: cover; transition: transform .22s; }
          .item:hover .thumb img { transform: scale(1.07); }
          .thumb .ph { font-size: 15px; opacity: .55; }
          .meta { flex: 1; min-width: 0; }
          .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px;
            font-weight: 550; cursor: pointer; }
          .name:hover { color: #9db8ff; }
          .sub { color: #9aa3b2; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
          .sub .unknown { color: #6d7686; font-style: italic; }
          .sub .sz { color: #8fd8a8; }
          .state { font-size: 11px; color: #9db8ff; min-width: 58px; text-align: right; flex: none; }
          .state.done { color: #8fd8a8; }
          .state.failed { color: #ff9d94; }
          .state.downloading { animation: pulse 1.2s infinite; }
          @keyframes pulse { 50% { opacity: .5; } }
          .pgro { /* 项内进度条 */
            position: absolute; left: 0; bottom: 0; height: 2px; width: 0%;
            background: linear-gradient(90deg, #6d8bff, #b06bff);
            border-radius: 0 2px 2px 0; transition: width .25s; opacity: .9;
          }
          .item.done .pgro { width: 100%; opacity: .45; }

          /* ---- 悬停预览卡 ---- */
          .preview {
            position: fixed; width: 268px; z-index: 12; pointer-events: none;
            opacity: 0; transform: translateY(6px) scale(.97); transform-origin: right center;
            transition: opacity .16s ease, transform .16s ease;
            background: linear-gradient(165deg, rgba(34,38,54,.88), rgba(17,19,29,.82));
            -webkit-backdrop-filter: blur(22px) saturate(1.6);
            backdrop-filter: blur(22px) saturate(1.6);
            border: 1px solid rgba(255,255,255,.14);
            border-radius: 16px; padding: 10px; color: #eef0f6;
            box-shadow: 0 16px 44px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.1);
          }
          .preview.show { opacity: 1; transform: translateY(0) scale(1); }
          .pv-thumb {
            width: 100%; height: 134px; border-radius: 11px; overflow: hidden; position: relative;
            background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center;
            border: 1px solid rgba(255,255,255,.09); margin-bottom: 9px;
          }
          .pv-thumb img { width: 100%; height: 100%; object-fit: cover; }
          .pv-thumb .ph { font-size: 30px; opacity: .5; }
          .pv-thumb .play {
            position: absolute; width: 42px; height: 42px; border-radius: 50%;
            background: rgba(10,12,18,.55); border: 1px solid rgba(255,255,255,.35);
            -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
            display: flex; align-items: center; justify-content: center;
            font-size: 15px; color: #fff; padding-left: 3px;
            box-shadow: 0 4px 18px rgba(0,0,0,.5);
          }
          .pv-thumb .badge {
            position: absolute; right: 7px; bottom: 7px; font-size: 10px; padding: 2px 7px;
            border-radius: 99px; background: rgba(0,0,0,.6); border: 1px solid rgba(255,255,255,.18);
            color: #cfd6e4;
          }
          .pv-name { font-size: 12.5px; font-weight: 600; word-break: break-all; line-height: 1.4;
            max-height: 2.8em; overflow: hidden; }
          .pv-cap {
            margin: 5px 0 2px; padding: 6px 8px; font-size: 11.5px; line-height: 1.5;
            color: #c3cbdc; word-break: break-all; max-height: 4.6em; overflow: hidden;
            border-left: 2px solid rgba(123,155,255,.55);
            background: rgba(255,255,255,.05); border-radius: 6px;
          }
          .pv-grid { display: grid; grid-template-columns: auto 1fr; gap: 3px 10px; margin-top: 7px; font-size: 11px; }
          .pv-grid .k { color: #7d8696; }
          .pv-grid .v { color: #d6dae4; text-align: right; word-break: break-all; }
          .pv-grid .v.hl { color: #8fd8a8; font-weight: 600; }
          .pv-hint { margin-top: 8px; padding-top: 7px; border-top: 1px solid rgba(255,255,255,.08);
            font-size: 10.5px; color: #6d7686; }

          /* ---- 日志 / 设置 ---- */
          .log {
            max-height: 108px; overflow-y: auto; padding: 7px 12px; font-size: 11px;
            color: #a8d8b0; background: rgba(0,0,0,.26); white-space: pre-wrap; word-break: break-all;
          }
          .log .err { color: #ff9d94; }
          .log .warn { color: #fdd663; }
          .settings { background: rgba(0,0,0,.22); padding: 9px 12px; font-size: 12px; display: none;
            border-top: 1px solid rgba(255,255,255,.06); }
          .settings.open { display: block; }
          .settings label { display: flex; align-items: center; gap: 7px; margin: 6px 0; color: #c7ccd8; cursor: pointer; }
          .settings input[type=checkbox] { accent-color: #7b9bff; }
          .settings select {
            background: rgba(255,255,255,.08); color: #eef0f6; border: 1px solid rgba(255,255,255,.16);
            border-radius: 7px; padding: 3px 7px; font-size: 12px; flex: 1;
          }
          .hint { color: #7d8696; font-size: 11px; margin-top: 5px; line-height: 1.5; }
        </style>

        <div class="preview" id="preview"></div>

        <div class="panel" id="panel">
          <div class="bar titlebar" id="titlebar">
            <b><span class="logo">📹</span>收藏视频下载器 <span class="eng" id="engLabel"></span></b>
            <button class="sec minibtn" id="btnSettings" title="设置">⚙</button>
            <button class="sec minibtn" id="btnHide" title="折叠/展开">—</button>
          </div>

          <div class="bar">
            <button id="btnScan">扫描当前</button>
            <button id="btnScanAll">滚动扫描全部</button>
            <button class="sec" id="btnStop" disabled>停止</button>
            <span class="stat" id="stat">未扫描</span>
          </div>

          <div class="bar">
            <label style="display:flex;align-items:center;gap:4px;font-size:12px;cursor:pointer">
              <input type="checkbox" id="ckAll"> 全选
            </label>
            <button class="sec minibtn" id="btnInvert">反选</button>
            <button class="sec minibtn" id="btnClear">清空列表</button>
            <span class="stat" id="stat2"></span>
          </div>

          <div class="bar dirrow">
            保存到：<span class="dname" id="dirName">（下载时选择）</span>
            <button class="sec minibtn" id="btnResetDir" style="display:none">更换目录</button>
          </div>

          <div class="list" id="list">
            <div class="empty" id="empty">尚无视频。<br>打开「收藏 / Saved Messages」后点「滚动扫描全部」。</div>
          </div>

          <div class="bar">
            <button id="btnDl" style="flex:1" disabled>下载选中 (0)</button>
          </div>

          <div class="settings" id="settings">
            <label>下载引擎
              <select id="selEngine">
                <option value="b">分片流式（自定义命名 + 进度，推荐）</option>
                <option value="k">官方管线（Telegram 原生下载，大文件最稳）</option>
                <option value="auto">自动（官方优先，失败回退分片）</option>
              </select>
            </label>
            <label><input type="checkbox" id="ckGif"> 包含 GIF 动图</label>
            <label><input type="checkbox" id="ckRound"> 包含圆形视频消息</label>
            <label><input type="checkbox" id="ckCaption"> 文件命名优先用消息标题（无标题时用文件名）</label>
            <label><input type="checkbox" id="ckClearSwitch"> 切换聊天时自动清空列表</label>
            <div class="hint">官方管线的文件名由 Telegram 决定（原始文件名，不含消息ID）；分片流式按「消息标题/原始文件名_消息ID」命名并显示进度。点击列表项可定位到对应消息。需要 File System Access（Chrome/Edge）。</div>
          </div>

          <div class="log" id="log"></div>
        </div>`;

      this.host = host;
      this.shadow = shadow;
      this.wire();
      this.restorePosition();
      this.log(`面板已就绪（v${VERSION} · ${ENV.isK ? 'WebK' : 'WebA'} 模式）`);
      if (ENV.isK) {
        const apiOk = internalApiOk();
        const dlOk = typeof page.appDownloadManager?.downloadToDisc === 'function';
        this.log(`内部API：消息查询 ${apiOk ? '✓' : '✗（将用 DOM 兜底扫描，元数据可能不全）'} · 官方下载 ${dlOk ? '✓' : '✗（分片引擎不受影响）'}`, apiOk ? undefined : 'warn');
      } else {
        this.log('WebA 模式：锚点扫描（data-message-id / .media-inner / .File）+ 分片流式下载引擎');
      }
      this.applySettingsToUI();
    },

    wire() {
      const $ = (id) => this.shadow.getElementById(id);

      $('btnScan').onclick = async () => {
        const r = await Scanner.scan(true);
        if (r.funnel === null) { this.log('未检测到聊天消息区，请先打开「收藏 / Saved Messages」', 'error'); return; }
        this.log(r.added ? `本轮新增 ${r.added} 个视频` : '没有新增（当前视图已全部登记）');
      };
      $('btnScanAll').onclick = () => ScrollPump.run();
      $('btnStop').onclick = () => {
        if (Queue.running) Queue.stop();
        else ScrollPump.stop();
      };
      $('btnHide').onclick = () => this.toggleCollapse();
      $('btnSettings').onclick = () => $('settings').classList.toggle('open');
      $('btnInvert').onclick = () => {
        this.shadow.querySelectorAll('.item input[type=checkbox]').forEach((c) => { c.checked = !c.checked; });
        this.updateDownloadButton();
      };
      $('btnClear').onclick = () => {
        Preview.hide();
        REGISTRY.clear();
        this.shadow.getElementById('list').innerHTML = '<div class="empty" id="empty">列表已清空。点「扫描当前」或「滚动扫描全部」重新收集。</div>';
        this.updateDownloadButton(); this.updateStatus('未扫描');
      };
      $('ckAll').onchange = (e) => {
        this.shadow.querySelectorAll('.item input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; });
        this.updateDownloadButton();
      };
      $('btnResetDir').onclick = () => { engineB.resetDir(); this.log('已清除目录记忆，下次下载重新选择'); };
      $('btnDl').onclick = () => {
        const sel = [];
        this.shadow.querySelectorAll('.item').forEach((row) => {
          if (row.querySelector('input[type=checkbox]')?.checked) {
            const m = REGISTRY.get(row.dataset.key);
            if (m) sel.push(m);
          }
        });
        Queue.start(sel);
      };

      // 设置项
      $('selEngine').onchange = (e) => { settings.engine = e.target.value; saveSettings(settings); this.updateEngineLabel(); };
      $('ckGif').onchange = (e) => { settings.includeGif = e.target.checked; saveSettings(settings); };
      $('ckRound').onchange = (e) => { settings.includeRound = e.target.checked; saveSettings(settings); };
      $('ckCaption').onchange = (e) => { settings.preferCaption = e.target.checked; saveSettings(settings); };
      $('ckClearSwitch').onchange = (e) => { settings.clearOnChatSwitch = e.target.checked; saveSettings(settings); };

      // 拖拽
      this.initDrag($('titlebar'));
    },

    applySettingsToUI() {
      const $ = (id) => this.shadow.getElementById(id);
      $('selEngine').value = settings.engine;
      $('ckGif').checked = settings.includeGif;
      $('ckRound').checked = settings.includeRound;
      $('ckCaption').checked = settings.preferCaption !== false;
      $('ckClearSwitch').checked = settings.clearOnChatSwitch;
      this.updateEngineLabel();
    },

    updateEngineLabel() {
      const el = this.shadow.getElementById('engLabel');
      if (!el) return;
      el.textContent = settings.engine === 'k' ? '·官方管线'
        : settings.engine === 'b' ? '·分片流式' : '·自动';
    },

    /* ---- 列表 ---- */

    appendItem(meta) {
      const list = this.shadow.getElementById('list');
      const empty = this.shadow.getElementById('empty');
      if (empty) empty.remove();

      const row = document.createElement('div');
      row.className = 'item';
      row.dataset.key = meta.key;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.onchange = () => this.updateDownloadButton();

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (meta.thumb) {
        const img = document.createElement('img');
        img.src = meta.thumb;
        thumb.appendChild(img);
      } else {
        thumb.innerHTML = '<span class="ph">🎬</span>';
      }

      const metaDiv = document.createElement('div');
      metaDiv.className = 'meta';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = displayName(meta);
      name.title = `${displayName(meta)} · 点击定位消息`;
      name.onclick = () => this.locateMessage(meta);
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.innerHTML = subLineHtml(meta);
      metaDiv.append(name, sub);

      const state = document.createElement('div');
      state.className = 'state';
      state.textContent = '';

      const pgro = document.createElement('div');
      pgro.className = 'pgro';

      row.append(cb, thumb, metaDiv, state, pgro);
      // 整行点击均可定位（复选框除外）
      row.title = '点击定位到消息';
      row.onclick = (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
        this.locateMessage(meta);
      };

      // 悬停预览（延时触发 + 快速离开即隐藏）
      row.addEventListener('mouseenter', () => Preview.showFor(meta, row));
      row.addEventListener('mouseleave', () => Preview.hideSoon());

      list.appendChild(row);
    },

    refreshItem(meta) {
      const row = this.shadow.querySelector(`.item[data-key="${CSS.escape(meta.key)}"]`);
      if (!row) return;
      const name = row.querySelector('.name');
      const dn = displayName(meta);
      if (name.textContent !== dn) {
        name.textContent = dn;
        name.title = `${dn} · 点击定位消息`;
      }
      const sub = row.querySelector('.sub');
      const html = subLineHtml(meta);
      if (sub.innerHTML !== html) sub.innerHTML = html;
      row.classList.toggle('done', meta.status === 'done');
      this.setItemState(meta, row.querySelector('.state'));
      // 预览卡正挂在该项上时同步刷新内容
      if (Preview.currentKey === meta.key && Preview.visible) Preview.render(meta);
    },

    setItemState(meta, el) {
      el.className = 'state ' + (meta.status === 'done' ? 'done' : meta.status === 'failed' ? 'failed' : meta.status === 'downloading' ? 'downloading' : '');
      el.textContent =
        meta.status === 'queued' ? '排队' :
        meta.status === 'downloading' ? '进行中…' :
        meta.status === 'done' ? '✓ 完成' :
        meta.status === 'failed' ? '✗ 失败' : '';
      if (meta.status === 'failed') el.title = meta.error || '';
    },

    setProgress(meta, p) {
      const row = this.shadow.querySelector(`.item[data-key="${CSS.escape(meta.key)}"]`);
      if (!row) return;
      const el = row.querySelector('.state');
      const pgro = row.querySelector('.pgro');
      if (p.stage === 'downloading') {
        el.className = 'state downloading';
        el.textContent = p.pct >= 0 ? `${p.pct}%` : (p.bytes ? formatSize(p.bytes) : '下载中…');
        if (p.pct >= 0) pgro.style.width = p.pct + '%';
      } else if (p.stage === 'done') {
        el.className = 'state done';
        el.textContent = '✓ 完成';
        pgro.style.width = '100%';
      }
    },

    /** 定位消息：视口内直接滚动高亮；被虚拟滚动回收时按 mid 方向性滚动搜索 */
    async locateMessage(meta) {
      const sel = `[${ENV.S.midAttr}="${CSS.escape(meta.mid)}"]`;
      let el = document.querySelector(sel);
      if (el) return this.flashLocated(el, meta);

      const scroller = document.querySelector(ENV.S.scrollEl);
      if (!scroller) { this.log('⌖ 未找到消息列表滚动容器，无法定位', 'warn'); return; }
      const midOf = (n) => parseInt(n.getAttribute(ENV.S.midAttr), 10) || 0;
      const target = parseInt(meta.mid, 10);
      this.log(`⌖ #${meta.mid} 不在当前视图，滚动查找中 …`);
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const mids = [...document.querySelectorAll(ENV.S.bubble)].map(midOf).filter(Boolean);
        if (!mids.length) { this.log('⌖ 当前未打开聊天，请先打开对应聊天再定位', 'warn'); return; }
        const max = Math.max(...mids), min = Math.min(...mids);
        el = document.querySelector(sel);
        if (el) return this.flashLocated(el, meta);
        if (target > max) {
          scroller.scrollTop = scroller.scrollHeight;      // 目标更新 → 向底部（新消息）
        } else if (target < min) {
          scroller.scrollTop = 0;                          // 目标更旧 → 向顶部（加载历史）
        } else {
          scroller.scrollTop += (target - (min + max) / 2 > 0 ? 160 : -160); // 区间内 → 小步逼近
        }
        await new Promise((r) => setTimeout(r, 450));
      }
      this.log(`⌖ 20 秒内未找到 #${meta.mid}（消息可能未加载，请先滚动加载该时间段）`, 'warn');
    },

    flashLocated(el, meta) {
      injectLocateStyle();
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('tgsvd-located');
      setTimeout(() => el.classList.remove('tgsvd-located'), 2700);
      this.log(`⌖ 已定位到消息 #${meta.mid}`);
    },

    /* ---- 状态与按钮 ---- */

    updateStatus(text) {
      const el = this.shadow.getElementById('stat');
      if (el) el.textContent = text;
    },
    setStatusScanning(text) {
      this.updateStatus(text + ' …');
    },
    updateDownloadButton(override) {
      const btn = this.shadow.getElementById('btnDl');
      if (!btn) return;
      if (override) { btn.textContent = `下载中 ${override}`; btn.disabled = true; return; }
      let n = 0;
      this.shadow.querySelectorAll('.item input[type=checkbox]').forEach((c) => { if (c.checked) n++; });
      btn.textContent = `下载选中 (${n})`;
      btn.disabled = n === 0 || Queue.running;
      const stat2 = this.shadow.getElementById('stat2');
      if (stat2) stat2.textContent = n ? `已选 ${n} 个` : '';
    },
    updateDirLabel() {
      const el = this.shadow.getElementById('dirName');
      const btn = this.shadow.getElementById('btnResetDir');
      if (!el) return;
      if (engineB.dirHandle) {
        el.textContent = engineB.dirHandle.name + '/';
        btn.style.display = '';
      } else {
        el.textContent = '（下载时选择）';
        btn.style.display = 'none';
      }
    },
    setBusy(busy, kind) {
      // kind: 'scan' | 'download'
      const $ = (id) => this.shadow.getElementById(id);
      $('btnScanAll').disabled = busy;
      $('btnScan').disabled = busy;
      $('btnDl').disabled = busy || kind === 'scan';
      $('btnStop').disabled = !busy;
      $('btnStop').textContent = kind === 'download' ? '中止下载' : '停止';
    },

    /* ---- 日志 ---- */

    log(msg, level) {
      const box = this.shadow.getElementById('log');
      if (!box) { console.log('[TG下载器]', msg); return; }
      const line = document.createElement('div');
      if (level) line.className = level;
      const t = new Date();
      line.textContent = `${pad2(t.getHours())}:${pad2(t.getMinutes())}:${pad2(t.getSeconds())} ${msg}`;
      box.appendChild(line);
      while (box.childElementCount > 200) box.firstElementChild.remove();
      box.scrollTop = box.scrollHeight;
    },

    /* ---- 折叠 / 拖拽 ---- */

    toggleCollapse() {
      this.collapsed = !this.collapsed;
      const panel = this.shadow.getElementById('panel');
      const btn = this.shadow.getElementById('btnHide');
      Preview.hide();
      // 折叠时隐藏除标题栏外的所有区块
      [...panel.children].forEach((c) => {
        if (c.id !== 'titlebar') c.style.display = this.collapsed ? 'none' : '';
      });
      panel.style.maxHeight = this.collapsed ? 'none' : '78vh';
      panel.style.minHeight = this.collapsed ? '0' : '';
      btn.textContent = this.collapsed ? '＋' : '—';
    },

    initDrag(handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.tagName === 'BUTTON') return; // 不拦截按钮点击
        dragging = true;
        Preview.hide();
        const r = this.host.getBoundingClientRect();
        ox = r.left; oy = r.top; sx = e.clientX; sy = e.clientY;
        handle.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const nx = Math.max(0, Math.min(window.innerWidth - 100, ox + e.clientX - sx));
        const ny = Math.max(0, Math.min(window.innerHeight - 40, oy + e.clientY - sy));
        this.host.style.left = nx + 'px';
        this.host.style.top = ny + 'px';
        this.host.style.right = 'auto';
      });
      handle.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        try {
          localStorage.setItem('tgsvd_pos', JSON.stringify({
            l: this.host.style.left, t: this.host.style.top,
          }));
        } catch { /* ignore */ }
      });
    },

    restorePosition() {
      try {
        const pos = JSON.parse(localStorage.getItem('tgsvd_pos') || 'null');
        if (pos?.l && pos?.t) {
          this.host.style.left = pos.l; this.host.style.top = pos.t; this.host.style.right = 'auto';
        }
      } catch { /* ignore */ }
    },
  };

  /* ================================================================
   * [11] 聊天切换监听（切换时可选清空列表）
   * ================================================================ */

  const ChatWatch = {
    lastKey: null,
    start() {
      const tick = () => {
        const key = this.currentKey();
        if (this.lastKey === null) { this.lastKey = key; return; }
        if (key !== null && key !== this.lastKey) {
          this.lastKey = key;
          if (settings.clearOnChatSwitch && REGISTRY.size && !Queue.running && !ScrollPump.running) {
            REGISTRY.clear();
            const list = UI.shadow?.getElementById('list');
            if (list) list.innerHTML = '<div class="empty" id="empty">已切换聊天，列表已清空。</div>';
            UI.updateDownloadButton(); UI.updateStatus('未扫描');
            UI.log('检测到切换聊天，扫描列表已清空（可在 ⚙ 设置中关闭）', 'warn');
          }
        } else if (key !== null) this.lastKey = key;
      };
      setInterval(tick, 1200);
    },
    currentKey() {
      if (ENV.isK) {
        try { return String(page.appImManager?.chat?.peerId ?? '') || null; } catch { return null; }
      }
      // WebA：从 hash 提取聊天参数（#-im?p=... / #?p=...），无 p 参数视为未打开聊天
      const h = location.hash || '';
      const m = h.match(/p=([^&]+)/);
      return m ? m[1] : null;
    },
  };

  /* ================================================================
   * [12] 启动 BOOT
   * ================================================================ */

  function boot() {
    if (!document.body) { setTimeout(boot, 300); return; }
    // SPA 首屏挂载需要时间，等消息根出现后再启动扫描（面板先显示）
    UI.init();
    Scanner.start();
    ChatWatch.start();
  }

  boot();
})();
