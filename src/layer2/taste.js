/**
 * Claudiao · 品味画像管线（歌单导入 → 大脑分析 → 常驻语料）
 *
 * CLI（tools/taste-import.js / taste-analyze.js）与 HTTP API（/api/taste/*）共用本模块。
 *
 * 机制：导入的网易云歌单（gdstudio 公开抓取，无需登录）交给大脑分析，
 * 产出 knowledge/user/taste-profile.md —— context.js 把它作为 ② 片常驻语料注入
 * 每一次播报，实现「导入一次，长期按个性推送」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { GdstudioProvider } from '../providers/music/gdstudio.js';

/** 导入歌单（gdstudio 公开抓取，多页合并，去重） */
export async function importPlaylists({ env, outDir, ids, log } = {}) {
  const g = new GdstudioProvider({ env: env || {}, log: log || console });
  fs.mkdirSync(outDir, { recursive: true });
  const imported = [];
  for (const id of ids) {
    try {
      const pl = await g.playlist(String(id), { maxPages: 8 });
      if (!pl.tracks.length) {
        imported.push({ id: String(id), ok: false, error: '空歌单或 ID 无效' });
        continue;
      }
      const record = {
        id: pl.id,
        name: pl.name,
        importedAt: new Date().toISOString(),
        trackCount: pl.tracks.length,
        tracks: pl.tracks.map((t) => ({
          title: t.name,
          artist: t.artist.join('/'),
          album: t.album,
          durationMs: t.durationMs,
          pop: t.pop,
          fee: t.fee,
        })),
      };
      fs.writeFileSync(path.join(outDir, `${pl.id}.json`), JSON.stringify(record, null, 2));
      imported.push({ id: pl.id, ok: true, name: pl.name, trackCount: pl.tracks.length });
      log?.info?.('歌单已导入', { id: pl.id, name: pl.name, tracks: pl.tracks.length });
    } catch (e) {
      imported.push({ id: String(id), ok: false, error: e.message });
    }
  }
  return imported;
}

/** 聚合已导入的歌单 → 分析用数据摘要 */
export function aggregateImports(importDir) {
  if (!fs.existsSync(importDir)) return { playlists: [], totalTracks: 0, digest: '', topArtists: [] };
  const artistFreq = {};
  const playlists = [];
  let totalTracks = 0;
  for (const f of fs.readdirSync(importDir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(importDir, f), 'utf8'));
    playlists.push(j);
    totalTracks += j.trackCount;
    for (const t of j.tracks) {
      for (const a of t.artist.split('/')) if (a) artistFreq[a] = (artistFreq[a] || 0) + 1;
    }
  }
  const topArtists = Object.entries(artistFreq).sort((a, b) => b[1] - a[1]).slice(0, 40);
  let digest = '';
  for (const pl of playlists) {
    digest += `\n【歌单：${pl.name}（${pl.trackCount} 首）】\n`;
    for (const t of pl.tracks.slice(0, 120)) digest += `${t.artist} - ${t.title}\n`;
    if (pl.trackCount > 120) digest += `（…其余 ${pl.trackCount - 120} 首略）\n`;
  }
  digest += `\n【高频艺人（出现次数）】\n${topArtists.map(([a, n]) => `${a}×${n}`).join('、')}\n`;
  return { playlists, totalTracks, digest, topArtists };
}

/** 从画像文本解析「相似风格探索清单」（- 艺人 - 曲名 行） */
export function parseExpansionList(profileText) {
  const seg = profileText.split(/相似风格探索清单/)[1] || '';
  const out = [];
  for (const m of seg.matchAll(/^- (.+?) - (.+?)$/gm)) {
    const spec = `${m[1].trim()} - ${m[2].trim()}`;
    if (!out.includes(spec)) out.push(spec);
  }
  return out;
}

/** 组装品味分析 prompt */
export function buildAnalysisPrompt(agg, existingTaste) {
  const artistLine = agg.topArtists.map(([a, n]) => `${a}×${n}`).join('、');
  return `# 任务：音乐品味画像分析

你是音乐品味分析师。下面是一个人的网易云歌单导入数据（曲目全量）和现有品味语料。
请输出一份**品味画像**（Markdown，中文），之后电台会用这份画像为 ta 推歌。

## 输出格式（严格遵循，缺一不可）

# 品味画像

> 生成于 <日期> · 数据源：<N> 个歌单 / <M> 首曲目

## 一、核心口味画像
（一段话，150 字内，说清这个人是谁——听什么、为什么、性格侧写）

## 二、流派与风格权重
| 风格 | 权重% | 依据 |
|---|---|---|
（5~8 行，权重加总 100%，依据要引用具体曲目/艺人）

## 三、年代分布
（主力年代 + 一句观察）

## 四、核心艺人榜
（分"重度痴迷 / 常听 / 涉猎"三档列出艺人名）

## 五、相似风格探索清单（歌单外）
（12~15 行，每行格式严格为「- 艺人 - 曲名」：与上面画像高度相似的**具体歌曲**，
但**不在**用户歌单里——同流派/同气质/同年代的均可，可跨地区跨年代。
这是电台"相似推荐"的弹药库，请认真选，宁缺毋滥）

## 六、能量与场景偏好
（安静/专注/通勤/深夜等场景分别适合推什么，2~4 行）

## 七、给电台的推送策略
（4~6 条具体可执行的推歌规则，例如"雨天优先推 X 类"、"- 避开 Y"）

## 要求
- 只依据数据说话，不编造没出现的艺人
- 与现有品味语料冲突时，以歌单数据为准，但指出冲突
- 语言自然，像乐评人写的，不要空话套话

# 数据

## 现有品味语料（taste.md）
${existingTaste}

## 歌单导入数据
${agg.digest}
${agg.topArtists.length ? `\n【高频艺人（出现次数）】\n${artistLine}\n` : ''}`;
}

/** 大脑分析 → 写 taste-profile.md。adapter 为 ZcodeAgentAdapter（拿原始长文输出）。 */
export async function generateTasteProfile({ env, root, adapter, importDir, existingTaste, log } = {}) {
  const agg = aggregateImports(importDir);
  if (!agg.playlists.length) throw Object.assign(new Error('没有已导入的歌单'), { code: 'E_NO_IMPORTS' });
  const taste = existingTaste
    ?? (() => { const f = path.join(root, 'knowledge', 'user', 'taste.md'); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '（无）'; })();
  const prompt = buildAnalysisPrompt(agg, taste);
  log?.info?.('品味分析开始', { playlists: agg.playlists.length, tracks: agg.totalTracks });
  const r = await adapter.compute(prompt, { timeoutMs: 180000 });
  const text = r.text.trim().replace(/^```(?:markdown)?\n?|\n?```$/g, '');
  const file = path.join(root, 'knowledge', 'user', 'taste-profile.md');
  fs.writeFileSync(file, `<!-- 由品味管线生成于 ${new Date().toISOString()} · 数据源: ${agg.playlists.map((p) => p.name).join('、')} -->\n\n${text}\n`);

  // 第二段：探索清单（短输出专项——长清单节容易整节被模型跳过，单独问一次）
  try {
    const r2 = await adapter.compute(
      `基于以下品味画像，给出 12~15 首「相似风格探索歌曲」：与画像高度相似、但不在下面的歌单曲目清单里（同流派/同气质，可跨地区跨年代）。\n只输出清单本身，每行格式严格为「- 艺人 - 曲名」，不要其他文字。\n\n【品味画像】\n${text.slice(0, 3000)}\n\n【用户歌单曲目（这些不要重复）】\n${agg.digest.slice(0, 4000)}`,
      { timeoutMs: 120000 });
    const list = r2.text.trim().replace(/^```(?:markdown)?\n?|\n?```$/g, '');
    if (list.includes(' - ')) {
      fs.appendFileSync(file, `\n## 相似风格探索清单（歌单外）\n\n${list}\n`);
      log?.info?.('探索清单已追加', { lines: list.split('\n').length });
    }
  } catch (e) {
    log?.warn?.('探索清单生成失败（不影响画像）', { error: e.message });
  }

  log?.info?.('品味画像已生成', { chars: text.length });
  const finalText = fs.readFileSync(file, 'utf8');
  return { text: finalText, file, chars: finalText.length };
}
