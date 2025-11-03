// notion-to-siliconflow.js
// 依赖：npm i @notionhq/client axios dotenv p-limit
import 'dotenv/config';
import { Client } from '@notionhq/client';
import axios from 'axios';
import pLimit from 'p-limit';

// ===== 运行参数（可用 GitHub Secrets 注入覆盖）=====
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN || 100); // 每次最多处理 N 条
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);   // 并发请求数
const IMG_WIDTH = Number(process.env.IMG_WIDTH || 768);
const IMG_HEIGHT = Number(process.env.IMG_HEIGHT || 1024);
const IMG_STEPS = Number(process.env.IMG_STEPS || 25);
const IMG_GUIDANCE = Number(process.env.IMG_GUIDANCE || 7);

// ===== Notion & SiliconFlow 基础配置 =====
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;

// 端点可通过环境覆盖；默认给出常见 API（如与你账号不符，可在 Secrets 配置 SILICONFLOW_IMAGE_API）
const SILICONFLOW_IMAGE_API =
  process.env.SILICONFLOW_IMAGE_API ||
  'https://api.siliconflow.cn/v1/images/generations';

const MODEL = process.env.SILICONFLOW_MODEL || 'Qwen/Qwen-Image';

// ===== 数据源字段（与“📹 镜头脚本分镜库”对齐）=====
const FIELD = {
  TITLE: '名称',               // title
  PROMPT: '画面描述',           // text（API 返回 rich_text）
  CAM_POS: '机位',             // text
  LENS: '镜头',                // select（远景/全景/中景/近景/特写）
  POV: '视角',                 // select（第一人称/第三人称/俯拍/仰拍）
  SUBTITLE: '字幕/屏幕要点',     // text
  PROPS: '道具/素材',           // text
  SEGMENT: '段落',             // select（起因/经过1/…）
  LOCATION: '拍摄地点',         // select（舞房）
  DURATION: '时长（秒）',       // number
  BGM: 'BGM',                  // text
  VO: '台词/旁白',              // text
  CTA: 'CTA',                  // text
  TRANSITION: '转场',           // text
  PERSONS: '人员',             // rollup（只读）
  RELATION_CONTENT: '关联内容',  // relation（跨库）
  STATUS: '拍摄进度',           // status（不写，仅可选过滤）
  ORDER: '顺序',               // number
  FILE_AI: 'Ai构图',           // file（写回目标）
  READONLY_ROLLUP: '内容状态'   // rollup（只读）
};

// ===== 通用取值（覆盖 title/rich_text/select/multi_select/number/date/status/rollup）=====
function getTextValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return Array.isArray(prop.title)
        ? prop.title.map(t => t.plain_text || '').join(' ').trim()
        : '';
    case 'rich_text':
      return Array.isArray(prop.rich_text)
        ? prop.rich_text.map(t => t.plain_text || '').join(' ').trim()
        : '';
    case 'select':
      return prop.select?.name || '';
    case 'multi_select':
      return Array.isArray(prop.multi_select)
        ? prop.multi_select.map(s => s.name).filter(Boolean).join('，').trim()
        : '';
    case 'number':
      return typeof prop.number === 'number' ? String(prop.number) : '';
    case 'date':
      return prop.date?.start || '';
    case 'status':
      return prop.status?.name || '';
    case 'rollup': {
      const r = prop.rollup;
      if (!r) return '';
      if (r.type === 'array' && Array.isArray(r.array)) {
        const items = r.array.map(it => {
          const t = it[it.type];
          if (!t) return '';
          if (Array.isArray(t)) return t.map(x => x.plain_text || '').join(' ').trim();
          if (typeof t === 'object' && t?.name) return t.name;
          return '';
        }).filter(Boolean);
        return items.length ? items.join('，') : `共${r.array.length}项`;
      }
      if (r.type === 'number' && typeof r.number === 'number') return String(r.number);
      if (r.type === 'date' && r.date?.start) return r.date.start;
      return '';
    }
    default:
      return '';
  }
}

// ===== 构建提示词（整合全部字段为正向提示；负向提示统一降噪）=====
function buildPrompt(page) {
  const p = page.properties || {};
  const F = FIELD;

  const name = getTextValue(p[F.TITLE]);
  const desc = getTextValue(p[F.PROMPT]);
  const cam = getTextValue(p[F.CAM_POS]);
  const lens = getTextValue(p[F.LENS]);
  const pov = getTextValue(p[F.POV]);
  const subtitle = getTextValue(p[F.SUBTITLE]);
  const propsMat = getTextValue(p[F.PROPS]);
  const seg = getTextValue(p[F.SEGMENT]);
  const location = getTextValue(p[F.LOCATION]);
  const duration = getTextValue(p[F.DURATION]);
  const bgm = getTextValue(p[F.BGM]);
  const vo = getTextValue(p[F.VO]);
  const cta = getTextValue(p[F.CTA]);
  const transition = getTextValue(p[F.TRANSITION]);
  const persons = getTextValue(p[F.PERSONS]);

  // 关联内容仅统计数量，避免跨库深查
  let relatedCount = '';
  const relProp = p[F.RELATION_CONTENT];
  if (relProp?.type === 'relation' && Array.isArray(relProp.relation)) {
    relatedCount = `关联内容：${relProp.relation.length} 项`;
  }

  const lines = [
    desc && `画面描述：${desc}`,
    name && `名称：${name}`,
    cam && `机位：${cam}`,
    lens && `镜头：${lens}`,
    pov && `视角：${pov}`,
    subtitle && `屏幕要点：${subtitle}`,
    propsMat && `道具：${propsMat}`,
    seg && `段落：${seg}`,
    location && `地点：${location}`,
    duration && `时长：${duration}秒`,
    bgm && `BGM：${bgm}`,
    vo && `台词/旁白：${vo}`,
    cta && `CTA：${cta}`,
    transition && `转场：${transition}`,
    persons && `人员：${persons}`,
    relatedCount
  ].filter(Boolean);

  lines.push('风格：写实高清，主体明确，构图简洁，光线自然，社媒短视频友好');

  const positive = lines.join('；');
  const negative = '低清晰度, 畸变, 过曝, 过暗, 杂乱, 噪点, 文字水印, 画面扭曲';

  return { prompt: positive, negativePrompt: negative };
}

// ===== 全库扫描：仅处理 “Ai构图为空 & 画面描述非空” 的条目 =====
async function queryPagesAllEmptyAi({ pageSize = 50 } = {}) {
  const pages = [];
  let cursor;

  while (true) {
    const resp = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      filter: {
        and: [
          { property: FIELD.FILE_AI, files: { is_empty: true } },
          { property: FIELD.PROMPT, rich_text: { is_not_empty: true } }
          // 如需限制只处理“待拍”，可追加：
          // { property: FIELD.STATUS, status: { equals: '待拍' } }
        ]
      },
      sorts: [{ property: FIELD.ORDER, direction: 'ascending' }],
      page_size: pageSize
    });

    pages.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  return pages;
}

// ===== 带重试封装（处理 429/5xx/超时）=====
async function callWithRetry(fn, { retries = 2, baseDelay = 800 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      attempt++;
      const status = e?.response?.status;
      const retriable = status === 429 || (status >= 500 && status < 600) || e.code === 'ECONNABORTED';
      if (!retriable || attempt > retries) throw e;
      const delay = baseDelay * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ===== 生成图片：返回首个可用 URL（兼容多种返回结构）=====
async function generateImage(prompt, negativePrompt, {
  width = IMG_WIDTH, height = IMG_HEIGHT, steps = IMG_STEPS, guidance_scale = IMG_GUIDANCE
} = {}) {
  if (!prompt) throw new Error('空提示词：画面描述为空。');

  const payload = {
    model: MODEL,
    prompt,
    negative_prompt: negativePrompt,
    width,
    height,
    steps,
    guidance_scale
    // 如需多图：num_images: 2
  };

  const resp = await callWithRetry(() => axios.post(SILICONFLOW_IMAGE_API, payload, {
    headers: {
      Authorization: `Bearer ${SILICONFLOW_API_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 120000,
    validateStatus: s => s >= 200 && s < 500
  }));

  if (resp.status >= 400) {
    throw new Error(`SiliconFlow API 错误：${resp.status} ${JSON.stringify(resp.data)}`);
  }

  const data = resp.data;
  const candidates = [
    data?.data?.[0]?.url,
    data?.images?.[0]?.url,
    data?.url
  ].filter(Boolean);
  return candidates[0] || null;
}

// ===== 写回到 Notion「Ai构图」（覆盖为最新一张 external）=====
async function writeBackImageToNotion(pageId, imageUrl, { propertyName = FIELD.FILE_AI, fileName = '参考图.jpg' } = {}) {
  if (!imageUrl) return;
  await notion.pages.update({
    page_id: pageId,
    properties: {
      [propertyName]: {
        files: [
          {
            name: fileName,
            external: { url: imageUrl }
          }
        ]
      }
    }
  });
}

// ===== 主流程：扫描全库空图 → 生成 → 写回 → 导出结果 =====
async function main() {
  if (!process.env.NOTION_TOKEN) throw new Error('缺少 NOTION_TOKEN');
  if (!DATABASE_ID) throw new Error('缺少 NOTION_DATABASE_ID');
  if (!SILICONFLOW_API_KEY) throw new Error('缺少 SILICONFLOW_API_KEY');

  const all = await queryPagesAllEmptyAi({ pageSize: 50 });
  if (!all.length) {
    console.log('没有需要返图的条目（Ai构图非空或无画面描述）。');
    return;
  }

  const targets = all.slice(0, MAX_PER_RUN);
  console.log(`本次待处理：${targets.length} / 全部待处理：${all.length}`);

  const limit = pLimit(CONCURRENCY);
  const results = await Promise.all(targets.map(page => limit(async () => {
    const pageId = page.id;
    const name = getTextValue(page.properties?.[FIELD.TITLE]) || pageId;
    const order = getTextValue(page.properties?.[FIELD.ORDER]);
    const { prompt, negativePrompt } = buildPrompt(page);

    try {
      const url = await generateImage(prompt, negativePrompt);
      if (url) {
        await writeBackImageToNotion(pageId, url, { fileName: `${name || pageId}.jpg` });
        console.log(JSON.stringify({ pageId, name, order, prompt, url }, null, 2));
        return { pageId, name, ok: true, url };
      } else {
        console.log(JSON.stringify({ pageId, name, order, prompt, error: 'no_url_returned' }, null, 2));
        return { pageId, name, ok: false, error: 'no_url_returned' };
      }
    } catch (e) {
      const err = e?.response?.data || e.message;
      console.error(JSON.stringify({ pageId, name, order, prompt, error: err }, null, 2));
      return { pageId, name, ok: false, error: err };
    }
  })));

  try {
    const fs = await import('node:fs');
    fs.writeFileSync('results.json', JSON.stringify(results, null, 2));
    console.log('已写入 results.json');
  } catch {}
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
