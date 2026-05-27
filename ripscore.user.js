// ==UserScript==
// @name         RipScore - 视频资源质量评分
// @namespace    https://github.com/ripscore
// @version      1.0.0
// @description  自动识别网页上的视频资源文件名，解析画质/音质信息并给出综合评分
// @author       RipScore
// @match        *://*.m-team.cc/*
// @match        *://*.m-team.io/*
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ============================================
  // 配置：评分权重和规则
  // ============================================
  const CONFIG = {
    // 各维度权重（总和100）
    weights: {
      resolution: 10,   // 4K是基本线，权重降低
      hdr: 25,          // DV体验提升明显
      videoCodec: 10,   // H.265够用
      audioFormat: 25,  // 好音响系统
      source: 30,       // 来源差距最大
    },

    // 分辨率评分
    resolution: {
      '2160p': 100,
      '4k': 100,
      'uhd': 100,
      '1080p': 50,
      '1080i': 50,
      '720p': 20,
      '576p': 0,
      '480p': 0,
    },

    // HDR 类型评分
    hdr: {
      'dv': 100,
      'dolby vision': 100,
      'hdr10+': 80,
      'hdr10plus': 80,
      'hdr10': 50,
      'hdr': 50,
      'hlg': 50,
      'sdr': 0,
    },

    // 视频编码评分
    videoCodec: {
      'av1': 100,
      'hevc': 80,
      'h.265': 80,
      'h265': 80,
      'x265': 80,
      'h.264': 40,
      'h264': 40,
      'x264': 40,
      'avc': 40,
      'vc-1': 0,
      'mpeg2': 0,
    },

    // 音频格式评分
    audioFormat: {
      'atmos': 100,
      'truehd atmos': 100,
      'truehd': 80,
      'dts-hd ma': 80,
      'dts-hd': 70,
      'dts:x': 70,
      'ddp 7.1': 55,
      'ddp7.1': 55,
      'dd+ 7.1': 55,
      'eac3 7.1': 55,
      'ddp 5.1': 50,
      'ddp5.1': 50,
      'dd+ 5.1': 50,
      'eac3 5.1': 50,
      'ddp': 45,
      'dd+': 45,
      'eac3': 45,
      'dts': 40,
      'dd 5.1': 25,
      'ac3 5.1': 25,
      'dd5.1': 25,
      'ac3': 20,
      'dd': 20,
      'aac 5.1': 15,
      'aac': 10,
      'mp3': 5,
    },

    // 来源评分
    source: {
      'remux': 100,
      'bdremux': 100,
      'bluray remux': 100,
      'blu-ray remux': 100,
      'uhd bluray': 75,
      'bluray': 70,
      'blu-ray': 70,
      'bdrip': 65,
      'web-dl': 50,
      'webdl': 50,
      'webrip': 25,
      'web': 20,
      'hdrip': 10,
      'hdtv': 0,
      'dvdrip': 0,
      'dvd': 0,
      'hdcam': 0,
      'cam': 0,
      'ts': 0,
    },

    // 知名发布组（加分项）
    releaseGroups: [
      'framestor', 'epsilon', 'ctrlhd', 'hifi', 'sparks',
      'terminal', 'flux', 'ntb', 'cmrg', 'tepes',
      'playHD', 'tigole', 'qxr', 'yify', 'rarbg',
      'adweb', 'nf', 'amzn', 'dsnp', 'hmax', 'atvp',
    ],
  };

  // ============================================
  // 解析器：从文件名提取信息
  // ============================================
  class RipParser {
    constructor(filename) {
      this.filename = filename;
      this.normalized = filename.toLowerCase().replace(/[._]/g, ' ');
    }

    // 解析分辨率
    parseResolution() {
      const patterns = [
        /\b(2160p|4k|uhd)\b/i,
        /\b(1080p|1080i)\b/i,
        /\b(720p)\b/i,
        /\b(576p|480p)\b/i,
      ];

      for (const pattern of patterns) {
        const match = this.filename.match(pattern);
        if (match) {
          return match[1].toLowerCase();
        }
      }
      return null;
    }

    // 解析 HDR 类型
    parseHDR() {
      const text = this.normalized;

      // 按优先级检测
      if (/\b(dv|dolby\s*vision)\b/.test(text)) return 'dv';
      if (/\bhdr10\+|hdr10plus\b/.test(text)) return 'hdr10+';
      if (/\bhdr10\b/.test(text)) return 'hdr10';
      if (/\bhdr\b/.test(text)) return 'hdr';
      if (/\bhlg\b/.test(text)) return 'hlg';
      if (/\bsdr\b/.test(text)) return 'sdr';

      return null; // 未标注，默认不参与评分
    }

    // 解析视频编码
    parseVideoCodec() {
      const text = this.normalized;

      if (/\bav1\b/.test(text)) return 'av1';
      if (/\b(hevc|h\.?265|x265)\b/.test(text)) return 'h.265';
      if (/\b(avc|h\.?264|x264)\b/.test(text)) return 'h.264';
      if (/\bvc-?1\b/.test(text)) return 'vc-1';
      if (/\bmpeg-?2\b/.test(text)) return 'mpeg2';

      return null;
    }

    // 解析音频格式（支持多种分隔符）
    parseAudioFormat() {
      const text = this.normalized;

      // Atmos（最高优先级）
      if (/\batmos\b/.test(text)) return 'atmos';

      // TrueHD
      if (/\btrue[\s\.\-]?hd\b/.test(text)) return 'truehd';

      // DTS 系列
      if (/\bdts[\s:\-]?x\b/.test(text)) return 'dts:x';
      if (/\bdts[\s:\-]?hd[\s\.\-]?ma\b/.test(text)) return 'dts-hd ma';
      if (/\bdts[\s:\-]?hd\b/.test(text)) return 'dts-hd';

      // DD+ / DDP / EAC3
      if (/\b(ddp|dd\+|e[\-\s]?ac[\-\s]?3)[\s\.]?7[\.\s]?1\b/.test(text)) return 'ddp 7.1';
      if (/\b(ddp|dd\+|e[\-\s]?ac[\-\s]?3)[\s\.]?5[\.\s]?1\b/.test(text)) return 'ddp 5.1';
      if (/\b(ddp|dd\+|e[\-\s]?ac[\-\s]?3)\b/.test(text)) return 'ddp';

      // DTS
      if (/\bdts\b/.test(text)) return 'dts';

      // DD / AC3
      if (/\b(dd|ac[\-\s]?3)[\s\.]?5[\.\s]?1\b/.test(text)) return 'dd 5.1';
      if (/\b(dd|ac[\-\s]?3)\b/.test(text)) return 'ac3';

      // AAC
      if (/\baac[\s\.]?5[\.\s]?1\b/.test(text)) return 'aac 5.1';
      if (/\baac\b/.test(text)) return 'aac';

      // MP3
      if (/\bmp3\b/.test(text)) return 'mp3';

      return null;
    }

    // 解析来源（明确列出常见变体）
    parseSource() {
      const text = this.normalized;

      // Remux（最高优先级）
      if (/\b(remux|bdremux|bd remux)\b/.test(text)) return 'remux';

      // BluRay
      if (/\b(uhd bluray|uhd blu-ray|uhd blu ray)\b/.test(text)) return 'uhd bluray';
      if (/\b(bluray|blu-ray|blu ray|bdrip|bd-rip|bd rip)\b/.test(text)) return 'bluray';

      // WEB 系列
      if (/\b(webdl|web dl|web-dl)\b/.test(text)) return 'web-dl';
      if (/\b(webrip|web rip|web-rip)\b/.test(text)) return 'webrip';
      if (/\bweb\b/.test(text)) return 'web';

      // 其他
      if (/\b(hdrip|hd rip)\b/.test(text)) return 'hdrip';
      if (/\bhdtv\b/.test(text)) return 'hdtv';
      if (/\b(dvdrip|dvd rip)\b/.test(text)) return 'dvdrip';
      if (/\bdvd\b/.test(text)) return 'dvd';
      if (/\b(hdcam|hd cam)\b/.test(text)) return 'hdcam';
      if (/\b(cam|ts)\b/.test(text)) return 'cam';

      return null;
    }

    // 检测发布组
    parseReleaseGroup() {
      const text = this.normalized;
      for (const group of CONFIG.releaseGroups) {
        if (text.includes(group.toLowerCase())) {
          return group;
        }
      }
      return null;
    }

    // 完整解析
    parse() {
      return {
        resolution: this.parseResolution(),
        hdr: this.parseHDR(),
        videoCodec: this.parseVideoCodec(),
        audioFormat: this.parseAudioFormat(),
        source: this.parseSource(),
        releaseGroup: this.parseReleaseGroup(),
      };
    }
  }

  // ============================================
  // 评分引擎
  // ============================================
  class ScoreEngine {
    constructor(parsed) {
      this.parsed = parsed;
    }

    // 计算单项得分
    getItemScore(category, value) {
      if (!value) return null;
      const scores = CONFIG[category];
      return scores[value] || null;
    }

    // 计算加权总分
    calculate() {
      const scores = {};
      let totalWeight = 0;
      let weightedSum = 0;

      // 计算各维度得分
      for (const [category, weight] of Object.entries(CONFIG.weights)) {
        const value = this.parsed[category];
        const score = this.getItemScore(category, value);

        if (score !== null) {
          scores[category] = { value, score };
          weightedSum += score * weight;
          totalWeight += weight;
        }
      }

      // 发布组加分（最多+5分）
      if (this.parsed.releaseGroup) {
        scores.releaseGroup = { value: this.parsed.releaseGroup, bonus: 5 };
      }

      // 计算最终得分
      const baseScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
      const bonus = this.parsed.releaseGroup ? 5 : 0;
      const finalScore = Math.min(100, baseScore + bonus);

      return {
        score: Math.round(finalScore),
        details: scores,
        parsed: this.parsed,
      };
    }
  }

  // ============================================
  // UI：评分徽章和详情面板
  // ============================================
  const STYLES = `
    .ripscore-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      margin-left: 8px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      vertical-align: middle;
      text-decoration: none !important;
    }

    .ripscore-badge:hover {
      transform: scale(1.05);
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }

    .ripscore-badge.score-excellent {
      background: linear-gradient(135deg, #10b981, #059669);
      color: white;
    }

    .ripscore-badge.score-good {
      background: linear-gradient(135deg, #3b82f6, #2563eb);
      color: white;
    }

    .ripscore-badge.score-fair {
      background: linear-gradient(135deg, #f59e0b, #d97706);
      color: white;
    }

    .ripscore-badge.score-poor {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      color: white;
    }

    .ripscore-tooltip {
      position: fixed;
      z-index: 999999;
      background: #1f2937;
      color: #f9fafb;
      padding: 12px 16px;
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      box-shadow: 0 10px 40px rgba(0,0,0,0.3);
      max-width: 320px;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.2s ease, transform 0.2s ease;
    }

    .ripscore-tooltip.visible {
      opacity: 1;
      transform: translateY(0);
    }

    .ripscore-tooltip-title {
      font-weight: 600;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid #374151;
    }

    .ripscore-tooltip-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
    }

    .ripscore-tooltip-label {
      color: #9ca3af;
    }

    .ripscore-tooltip-value {
      font-weight: 500;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12px;
    }

    /* S级 - 彩虹渐变 */
    .ripscore-tooltip-value.tier-s {
      background: linear-gradient(90deg, #f472b6, #fb923c, #fbbf24, #4ade80, #22d3ee, #a78bfa);
      color: white;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    }

    /* A级 - 金色 */
    .ripscore-tooltip-value.tier-a {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      color: #1c1917;
    }

    /* B级 - 绿色 */
    .ripscore-tooltip-value.tier-b {
      background: linear-gradient(135deg, #4ade80, #22c55e);
      color: #052e16;
    }

    /* C级 - 蓝色 */
    .ripscore-tooltip-value.tier-c {
      background: linear-gradient(135deg, #60a5fa, #3b82f6);
      color: white;
    }

    /* D级 - 灰色 */
    .ripscore-tooltip-value.tier-d {
      background: #6b7280;
      color: #e5e7eb;
    }

    /* 加分项 */
    .ripscore-tooltip-value.bonus {
      background: linear-gradient(135deg, #f472b6, #ec4899);
      color: white;
    }

    /* ========== 内联高亮标签 ========== */
    .ripscore-tag {
      display: inline;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 600;
      font-size: 0.95em;
      white-space: nowrap;
    }

    /* S级 - 彩虹渐变 */
    .ripscore-tag.tier-s {
      background: linear-gradient(90deg, #f472b6, #fb923c, #fbbf24, #4ade80, #22d3ee, #a78bfa);
      color: white;
      text-shadow: 0 1px 2px rgba(0,0,0,0.5);
    }

    /* A级 - 金色 */
    .ripscore-tag.tier-a {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      color: #1c1917;
    }

    /* B级 - 绿色 */
    .ripscore-tag.tier-b {
      background: linear-gradient(135deg, #4ade80, #22c55e);
      color: #052e16;
    }

    /* C级 - 蓝色 */
    .ripscore-tag.tier-c {
      background: linear-gradient(135deg, #60a5fa, #3b82f6);
      color: white;
    }

    /* D级 - 灰色 */
    .ripscore-tag.tier-d {
      background: #6b7280;
      color: #e5e7eb;
    }

    /* 流媒体来源 - 品牌色 */
    .ripscore-tag.src-nf {
      background: #E50914;
      color: white;
    }
    .ripscore-tag.src-amzn {
      background: #FF9900;
      color: #0F1111;
    }
    .ripscore-tag.src-dsnp {
      background: #113CCF;
      color: white;
    }
    .ripscore-tag.src-atvp {
      background: #000000;
      color: white;
    }
    .ripscore-tag.src-hmax {
      background: #B535F6;
      color: white;
    }
    .ripscore-tag.src-pmtp {
      background: #0064FF;
      color: white;
    }
    .ripscore-tag.src-pcok {
      background: #000000;
      color: #FFD700;
    }

    /* 发布组 - 只变字体颜色 */
    .ripscore-tag.group-top {
      color: #f59e0b;
      font-weight: 700;
    }
    .ripscore-tag.group-good {
      color: #22c55e;
      font-weight: 600;
    }
  `;

  // 注入样式
  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  // 获取评分等级
  function getScoreClass(score) {
    if (score >= 85) return 'score-excellent';
    if (score >= 70) return 'score-good';
    if (score >= 50) return 'score-fair';
    return 'score-poor';
  }

  // 根据具体值获取等级样式类
  // S=彩虹 A=金 B=绿 C=蓝 D=灰
  function getTierClass(category, value) {
    if (!value) return 'tier-d';

    const tierMap = {
      resolution: {
        '2160p': 'tier-a', '4k': 'tier-a', 'uhd': 'tier-a',
        '1080p': 'tier-b', '1080i': 'tier-b',
        '720p': 'tier-c',
        '576p': 'tier-d', '480p': 'tier-d',
      },
      hdr: {
        'dv': 'tier-s', 'dolby vision': 'tier-s',
        'hdr10+': 'tier-a', 'hdr10plus': 'tier-a',
        'hdr10': 'tier-b', 'hdr': 'tier-b', 'hlg': 'tier-b',
        'sdr': 'tier-d',
      },
      videoCodec: {
        'av1': 'tier-a',
        'hevc': 'tier-a', 'h.265': 'tier-a', 'h265': 'tier-a', 'x265': 'tier-a',
        'avc': 'tier-b', 'h.264': 'tier-b', 'h264': 'tier-b', 'x264': 'tier-b',
        'vc-1': 'tier-d', 'mpeg2': 'tier-d',
      },
      audioFormat: {
        'atmos': 'tier-s', 'truehd atmos': 'tier-s',
        'truehd': 'tier-a', 'dts-hd ma': 'tier-a',
        'dts-hd': 'tier-b', 'dts:x': 'tier-b', 'ddp 7.1': 'tier-b', 'ddp 5.1': 'tier-b', 'ddp': 'tier-b', 'dts': 'tier-b',
        'dd 5.1': 'tier-c', 'ac3': 'tier-c',
        'aac 5.1': 'tier-d', 'aac': 'tier-d', 'mp3': 'tier-d',
      },
      source: {
        'remux': 'tier-s',
        'uhd bluray': 'tier-a', 'bluray': 'tier-a',
        'web-dl': 'tier-b',
        'webrip': 'tier-c', 'web': 'tier-c',
        'hdrip': 'tier-d', 'hdtv': 'tier-d', 'dvdrip': 'tier-d', 'dvd': 'tier-d', 'hdcam': 'tier-d', 'cam': 'tier-d',
      },
    };

    const map = tierMap[category];
    if (!map) return 'tier-d';
    return map[value] || 'tier-d';
  }

  // 格式化详情文本
  function formatDetails(result) {
    const { parsed } = result;
    const lines = [];

    if (parsed.resolution) {
      lines.push({
        label: '分辨率',
        value: parsed.resolution.toUpperCase(),
        tierClass: getTierClass('resolution', parsed.resolution)
      });
    }
    if (parsed.hdr) {
      lines.push({
        label: 'HDR',
        value: parsed.hdr.toUpperCase(),
        tierClass: getTierClass('hdr', parsed.hdr)
      });
    }
    if (parsed.videoCodec) {
      lines.push({
        label: '视频编码',
        value: parsed.videoCodec.toUpperCase(),
        tierClass: getTierClass('videoCodec', parsed.videoCodec)
      });
    }
    if (parsed.audioFormat) {
      lines.push({
        label: '音频格式',
        value: parsed.audioFormat.toUpperCase(),
        tierClass: getTierClass('audioFormat', parsed.audioFormat)
      });
    }
    if (parsed.source) {
      lines.push({
        label: '来源',
        value: parsed.source.toUpperCase(),
        tierClass: getTierClass('source', parsed.source)
      });
    }
    if (parsed.releaseGroup) {
      lines.push({
        label: '发布组',
        value: parsed.releaseGroup,
        tierClass: 'bonus'
      });
    }

    return lines;
  }

  // 创建评分徽章
  function createBadge(result) {
    const badge = document.createElement('span');
    badge.className = `ripscore-badge ${getScoreClass(result.score)}`;
    badge.textContent = `⭐ ${result.score}`;
    badge.dataset.ripscoreResult = JSON.stringify(result);
    return badge;
  }

  // 创建/更新 tooltip
  let tooltip = null;

  function showTooltip(badge, result) {
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'ripscore-tooltip';
      document.body.appendChild(tooltip);
    }

    const details = formatDetails(result);
    tooltip.innerHTML = `
      <div class="ripscore-tooltip-title">RipScore 评分: ${result.score}/100</div>
      ${details.map(d => `
        <div class="ripscore-tooltip-row">
          <span class="ripscore-tooltip-label">${d.label}</span>
          <span class="ripscore-tooltip-value ${d.tierClass}">${d.value}</span>
        </div>
      `).join('')}
    `;

    const rect = badge.getBoundingClientRect();
    tooltip.style.left = `${rect.left}px`;
    tooltip.style.top = `${rect.bottom + 8}px`;
    tooltip.classList.add('visible');
  }

  function hideTooltip() {
    if (tooltip) {
      tooltip.classList.remove('visible');
    }
  }

  // ============================================
  // 文本高亮：将资源名中的关键部分替换为彩色标签
  // ============================================

  // 高亮规则配置（所有正则都带 i 标志，大小写不敏感）
  // S=彩虹(DV/Atmos/Remux) A=金 B=绿 C=蓝 D=灰
  const HIGHLIGHT_RULES = [
    // 分辨率：A=4K, B=1080p, C=720p, D=480p
    { pattern: /\b(2160p|4K|UHD)\b/gi, getClass: () => 'tier-a' },
    { pattern: /\b(1080p|1080i)\b/gi, getClass: () => 'tier-b' },
    { pattern: /\b(720p)\b/gi, getClass: () => 'tier-c' },
    { pattern: /\b(576p|480p)\b/gi, getClass: () => 'tier-d' },

    // HDR：S=DV, A=HDR10+, B=HDR/HLG, D=SDR
    { pattern: /\b(DV|DoVi|Dolby[\s\.\-]?Vision)\b/gi, getClass: () => 'tier-s' },
    { pattern: /\b(HDR10\+|HDR10Plus|HDR10[\s\.\-]?Plus)\b/gi, getClass: () => 'tier-a' },
    { pattern: /\b(HDR10|HDR|HLG)\b/gi, getClass: () => 'tier-b' },
    { pattern: /\b(SDR)\b/gi, getClass: () => 'tier-d' },

    // 编码：A=AV1/H.265/HEVC, B=H.264/AVC, D=老编码
    { pattern: /\b(AV1)\b/gi, getClass: () => 'tier-a' },
    { pattern: /\b(HEVC|H[\.\s]?265|x[\.\s]?265)\b/gi, getClass: () => 'tier-a' },
    { pattern: /\b(AVC|H[\.\s]?264|x[\.\s]?264)\b/gi, getClass: () => 'tier-b' },
    { pattern: /\b(VC[\-\s]?1|MPEG[\-\s]?2|XviD|DivX)\b/gi, getClass: () => 'tier-d' },

    // 音频：S=Atmos, A=TrueHD/DTS-HD MA, B=DDP/DTS, C=DD/AC3, D=AAC/MP3
    { pattern: /\b(Atmos)\b/gi, getClass: () => 'tier-s' },
    { pattern: /\b(True[\s\.\-]?HD|DTS[\s:\-]?HD[\s\.\-]?MA)\b/gi, getClass: () => 'tier-a' },
    { pattern: /\b(DTS[\s:\-]?HD|DTS[\s:\-]?X|DDP[\s\.]?[57][\.\s]?1|DD\+[\s\.]?[57][\.\s]?1|EAC[\-\s]?3[\s\.]?[57][\.\s]?1|DDP|DD\+|EAC[\-\s]?3|E[\-\s]?AC[\-\s]?3|DTS)\b/gi, getClass: () => 'tier-b' },
    { pattern: /\b(DD[\s\.]?[57][\.\s]?1|AC[\-\s]?3[\s\.]?[57][\.\s]?1|AC[\-\s]?3)\b/gi, getClass: () => 'tier-c' },
    { pattern: /\b(AAC[\s\.]?[57][\.\s]?1|AAC|MP3)\b/gi, getClass: () => 'tier-d' },

    // 来源：S=Remux, A=BluRay, B=WEB-DL, C=WEBRip, D=HDTV/DVD
    { pattern: /\b(REMUX|BD[\s\.\-]?Remux|BDRemux)\b/gi, getClass: () => 'tier-s' },
    { pattern: /\b(BluRay|Blu[\s.\-]?[Rr]ay|BDRip|BD[\s.\-]?Rip)\b/gi, getClass: () => 'tier-a' },
    { pattern: /\b(WEBDL|WEB[\-\.\s]DL)\b/gi, getClass: () => 'tier-b' },
    { pattern: /\b(WEBRip|WEB[\-\.\s]Rip)\b/gi, getClass: () => 'tier-c' },
    { pattern: /\b(HDTV|HDRip|HD[\-\.\s]Rip|DVDRip|DVD[\-\.\s]Rip|DVD)\b/gi, getClass: () => 'tier-d' },

    // 流媒体来源 - 品牌色
    { pattern: /\bNF\b/g, getClass: () => 'src-nf' },
    { pattern: /\bAMZN\b/g, getClass: () => 'src-amzn' },
    { pattern: /\bDSNP\b/g, getClass: () => 'src-dsnp' },
    { pattern: /\bATVP\b/g, getClass: () => 'src-atvp' },
    { pattern: /\bHMAX\b/g, getClass: () => 'src-hmax' },
    { pattern: /\bPMTP\b/g, getClass: () => 'src-pmtp' },
    { pattern: /\bPCOK\b/g, getClass: () => 'src-pcok' },

    // 顶级发布组 - 金色字体
    { pattern: /\b(FraMeSToR|D[\-\s]?Z0N3|EPSiLON|CtrlHD|HiFi|DON|EbP|decibeL|BHDStudio|playBD)\b/gi, getClass: () => 'group-top' },

    // 优质发布组 - 绿色字体
    { pattern: /\b(NTb|FLUX|CMRG|TEPES|playWEB|KiNGS|SMURF|Tigole|QxR|RARBG|ADWeb|CHD|CMCT|beAst)\b/gi, getClass: () => 'group-good' },
  ];

  // 将文本转换为带高亮的 HTML
  function highlightText(text) {
    let result = text;
    const replacements = [];

    // 收集所有匹配项及其位置
    for (const rule of HIGHLIGHT_RULES) {
      let match;
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      while ((match = regex.exec(text)) !== null) {
        replacements.push({
          start: match.index,
          end: match.index + match[0].length,
          original: match[0],
          className: rule.getClass(match[0]),
        });
      }
    }

    // 按位置排序并去重（避免重叠）
    // start 相同时，优先长匹配（更精确，如 HDR10+ 优先于 HDR）
    replacements.sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return (b.end - b.start) - (a.end - a.start); // 长的优先
    });
    const filtered = [];
    let lastEnd = -1;
    for (const r of replacements) {
      if (r.start >= lastEnd) {
        filtered.push(r);
        lastEnd = r.end;
      }
    }

    // 从后往前替换，避免位置偏移
    for (let i = filtered.length - 1; i >= 0; i--) {
      const r = filtered[i];
      const tag = `<span class="ripscore-tag ${r.className}">${r.original}</span>`;
      result = result.slice(0, r.start) + tag + result.slice(r.end);
    }

    return result;
  }

  // ============================================
  // 页面扫描器
  // ============================================
  // 放宽匹配：只要包含分辨率或来源关键词就尝试解析
  const FILENAME_PATTERN = /\b[A-Za-z0-9][\w\s\.\-]{5,}(?:2160p|1080p|720p|480p|4K|UHD|REMUX|BluRay|Blu-Ray|WEB-DL|WEBDL|WEBRip|HDTV)[\w\s\.\-@]{3,}/gi;

  // 检查节点是否应该被跳过
  function shouldSkipNode(node) {
    const skipTags = ['SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'TEXTAREA', 'INPUT'];
    if (skipTags.includes(node.tagName)) return true;
    if (node.closest('.ripscore-badge')) return true;
    if (node.closest('.ripscore-tooltip')) return true;
    if (node.closest('.ripscore-wrapper')) return true;
    if (node.closest('.ripscore-tag')) return true;
    return false;
  }

  // 扫描并注入徽章 + 高亮
  function scanAndInject() {
    const textNodes = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) => {
          if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
          if (shouldSkipNode(node.parentElement)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const textNode of textNodes) {
      const text = textNode.textContent;
      const matches = text.match(FILENAME_PATTERN);

      if (matches) {
        for (const match of matches) {
          // 避免重复处理
          const parent = textNode.parentElement;
          if (parent.querySelector('.ripscore-badge')) continue;
          if (parent.querySelector('.ripscore-tag')) continue;

          const parser = new RipParser(match);
          const parsed = parser.parse();

          // 至少要解析出分辨率或来源才处理
          if (!parsed.resolution && !parsed.source) continue;

          const engine = new ScoreEngine(parsed);
          const result = engine.calculate();

          // 创建高亮后的 HTML
          const highlightedHTML = highlightText(text);

          // 创建包装容器
          const wrapper = document.createElement('span');
          wrapper.className = 'ripscore-wrapper';
          wrapper.innerHTML = highlightedHTML;

          // 创建徽章
          const badge = createBadge(result);
          wrapper.appendChild(badge);

          // 替换原文本节点
          parent.replaceChild(wrapper, textNode);

          // 绑定事件
          badge.addEventListener('mouseenter', () => showTooltip(badge, result));
          badge.addEventListener('mouseleave', hideTooltip);

          break; // 每个文本节点只处理一次
        }
      }
    }
  }

  // ============================================
  // 右键菜单：手动分析选中文本
  // ============================================
  function analyzeSelection() {
    const selection = window.getSelection().toString().trim();
    if (!selection) {
      alert('请先选中要分析的资源文件名');
      return;
    }

    const parser = new RipParser(selection);
    const parsed = parser.parse();
    const engine = new ScoreEngine(parsed);
    const result = engine.calculate();

    const details = formatDetails(result);
    const message = [
      `📊 RipScore 分析结果`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `综合评分: ${result.score}/100`,
      ``,
      ...details.map(d => `${d.label}: ${d.value}`),
      ``,
      `━━━━━━━━━━━━━━━━━━━━`,
      `原文: ${selection.substring(0, 80)}${selection.length > 80 ? '...' : ''}`
    ].join('\n');

    alert(message);
  }

  // ============================================
  // 初始化
  // ============================================
  function init() {
    injectStyles();

    // 延迟扫描，等待页面完全加载
    setTimeout(scanAndInject, 1000);

    // 监听动态内容
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length) {
          setTimeout(scanAndInject, 500);
          break;
        }
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // 注册右键菜单
    if (typeof GM_registerMenuCommand !== 'undefined') {
      GM_registerMenuCommand('🎬 分析选中的资源名', analyzeSelection);
    }

    console.log('🎬 RipScore v1.0.0 已加载');
  }

  // 启动
  init();
})();
