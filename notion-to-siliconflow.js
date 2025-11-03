// notion-to-siliconflow.js
// 依赖：npm i @notionhq/client axios p-limit dotenv
import 'dotenv/config';
import { Client } from '@notionhq/client';
import axios from 'axios';
import pLimit from 'p-limit';

// 1) ENV（你指定的命名）
const notion = new Client({ auth: process.env.NOTION_TOKEN });
const DATABASE_ID = process.env.NOTION_DATABASE_ID;
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;

// 2) SiliconFlow 端点与模型（可用 ENV 覆盖端点）
// 若你在 Secrets 中提供 SILICONFLOW_IMAGE_API，这里会自动覆盖默认端点
const SILICONFLOW_IMAGE_API =
  process.env.SILICONFLOW_IMAGE_API ||
  'https://api.siliconflow.cn/v1/images/generations';

const MODEL = 'Qwen/Qwen-Image';

// 3) 字段名（与数据源 schema 完全对齐）
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
  STATUS: '拍摄进度',           // status（枚举）
  ORDER: '顺序',               // number
  READONLY_ROLLUP: '内容状态'   // rollup（只读）
};

// 4) 状态枚举（仅用于可选过滤，不写回）
const PROGRESS = new Set(['待拍','已拍摄','补拍镜头','拍摄中','剪辑中','已完成','淘汰']);

// 5) 通用取值（覆盖 title/rich_text/select/multi_select/number/date/status/rollup）
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
      // 常见 rollup 聚合类型处理
      if (r.type === 'array' && Array.isArray(r.array)) {
        const items = r.array.map(it => {
          // it 的结构为 { type: 'title'|'rich_text'|..., <sameKey>: [...] }
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

// 6) 组合“整条分镜”的结构化提示词：主描述 + 其余标签化信息
function buildPrompt(page) {
  const p = page.properties || {};
  const F = FIELD;

  // 主体与补充
  const name = getTextValue(p[F.TITLE]);            // 名称
  const desc = getTextValue(p[F.PROMPT]);           // 画面描述（主提示）
  const cam = getTextValue(p[F.CAM_POS]);           // 机位
  const lens = getTextValue(p[F.LENS]);             // 镜头
  const pov = getTextValue(p[F.POV]);               // 视角
  const subtitle = getTextValue(p[F.SUBTITLE]);     // 字幕/屏幕要点
  const propsMat = getTextValue(p[F.PROPS]);        // 道具/素材
  const seg = getTextValue(p[F.SEGMENT]);           // 段落
  const location = getTextValue(p[F.LOCATION]);     // 拍摄地点
  const duration = getTextValue(p[F.DURATION]);     // 时长（秒）
  const bgm = getTextValue(p[F.BGM]);               // BGM
  const vo = getTextValue(p[F.VO]);                 // 台词/旁白
  const cta = getTextValue(p[F.CTA]);               // CTA
  const transition = getTextValue(p[F.TRANSITION]); // 转场
  const persons = getTextValue(p[F.PERSONS]);       // 人员（rollup 名称/计数）

  // 关联内容仅提供数量提示，避免跨库深查
  let relatedCount = '';
  const relProp = p[F.RELATION_CONTENT];
  if (relProp?.type === 'relation' && Array.isArray(relProp.relation)) {
    relatedCount = `关联内容：${relProp.relation.length} 项`;
  }

  // 拼装正向提示（结构化）
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

  // 统一的风格与质量基线
  lines.push('风格：写实高清，主体明确，构图简洁，光线自然，社媒短视频友好');

  const positive = lines.join('；');
  const negative = '低清晰度, 畸变, 过曝, 过暗, 杂乱, 噪点, 文字水印, 画面扭曲';

  return { prompt: positive, negativePrompt: negative };
}

// 7) 查询页面：画面描述非空 + 可选（拍摄进度=待拍），并按“顺序”升序
async function queryPages({ onlyTodo = true, pageSize = 10 } = {}) {
  const filters = [
    { property: FIELD.PROMPT, rich_text: { is_not_empty: true } }
  ];
  if (onlyTodo) {
    filters.push({ property: FIELD.STATUS, status: { equals: '待拍' } });
  }

  const resp = await notion.databases.query({
    database_id: DATABASE_ID,
    filter: { and: filters },
    sorts: [{ property: FIELD.ORDER, direction: 'ascending' }],
    page_size: pageSize
  });

  return resp.results || [];
}

// 8) 带重试封装（处理 429/5xx/超时）
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

// 9) 生成图片：返回首个可用 URL（宽容解析多个常见字段）
async function generateImage(prompt, negativePrompt, {
  width = 768, height = 1024, steps = 25, guidance_scale = 7
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

// 10) 主流程：只读 Notion，生成图，输出 results.json（不写回）
async function main() {
  // ENV 校验
  if (!process.env.NOTION_TOKEN) throw new Error('缺少 NOTION_TOKEN');
  if (!DATABASE_ID) throw new Error('缺少 NOTION_DATABASE_ID');
  if (!SILICONFLOW_API_KEY) throw new Error('缺少 SILICONFLOW_API_KEY');

  // 默认只处理「待拍」+ 画面描述非空；如要全量，将 onlyTodo 改为 false
  const pages = await queryPages({ onlyTodo: true, pageSize: 10 });
  if (!pages.length) {
    console.log('没有可处理的分镜（「待拍」且「画面描述」非空）。');
    return;
  }

  const batch = pages.slice(0, 5); // 首跑 5 条验证稳定性
  const limit = pLimit(3);         // 并发 3

  const results = await Promise.all(batch.map(page => limit(async () => {
    const pageId = page.id;
    const name = getTextValue(page.properties?.[FIELD.TITLE]) || pageId;
    const order = getTextValue(page.properties?.[FIELD.ORDER]);

    const { prompt, negativePrompt } = buildPrompt(page);

    try {
      const url = await generateImage(prompt, negativePrompt, { width: 768, height: 1024 });
      if (url) {
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

  // 写出结果文件（Actions 会作为 artifact 保留）
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
