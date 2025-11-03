// 通用取值，增加对 rollup 的安全读取
function getTextValue(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
      return Array.isArray(prop.title) ? prop.title.map(t => t.plain_text || '').join(' ').trim() : '';
    case 'rich_text':
      return Array.isArray(prop.rich_text) ? prop.rich_text.map(t => t.plain_text || '').join(' ').trim() : '';
    case 'select':
      return prop.select?.name || '';
    case 'multi_select':
      return Array.isArray(prop.multi_select) ? prop.multi_select.map(s => s.name).filter(Boolean).join('，').trim() : '';
    case 'number':
      return typeof prop.number === 'number' ? String(prop.number) : '';
    case 'date':
      // 仅示意：如需用到可以格式化 start/end
      return prop.date?.start || '';
    case 'status':
      return prop.status?.name || '';
    case 'rollup': {
      // 常见 rollup 读取：array、number、date、unsupported
      const r = prop.rollup;
      if (!r) return '';
      if (r.type === 'array' && Array.isArray(r.array)) {
        // 尝试把 array 里的 title/rich_text 人名或文本读出来
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
      // 兜底：给出计数或空
      return '';
    }
    default:
      return '';
  }
}

// 组合“整条分镜”的结构化提示词：仅用于正向提示；负向提示保持干净
function buildPrompt(page) {
  const p = page.properties || {};

  // 字段名常量与 schema 对齐
  const F = {
    TITLE: '名称',
    PROMPT: '画面描述',
    CAM_POS: '机位',
    LENS: '镜头',
    POV: '视角',
    SUBTITLE: '字幕/屏幕要点',
    PROPS: '道具/素材',
    SEGMENT: '段落',
    LOCATION: '拍摄地点',
    DURATION: '时长（秒）',
    BGM: 'BGM',
    VO: '台词/旁白',
    CTA: 'CTA',
    TRANSITION: '转场',
    PERSONS: '人员',         // rollup
    RELATION_CONTENT: '关联内容' // relation（跨库，不做深查，仅统计）
  };

  // 基础项
  const name = getTextValue(p[F.TITLE]);           // 名称
  const desc = getTextValue(p[F.PROMPT]);          // 画面描述（主提示）
  const cam = getTextValue(p[F.CAM_POS]);          // 机位
  const lens = getTextValue(p[F.LENS]);            // 镜头
  const pov = getTextValue(p[F.POV]);              // 视角
  const subtitle = getTextValue(p[F.SUBTITLE]);    // 字幕/屏幕要点
  const propsMat = getTextValue(p[F.PROPS]);       // 道具/素材
  const seg = getTextValue(p[F.SEGMENT]);          // 段落
  const location = getTextValue(p[F.LOCATION]);    // 拍摄地点
  const duration = getTextValue(p[F.DURATION]);    // 时长（秒）
  const bgm = getTextValue(p[F.BGM]);              // BGM
  const vo = getTextValue(p[F.VO]);                // 台词/旁白
  const cta = getTextValue(p[F.CTA]);              // CTA
  const transition = getTextValue(p[F.TRANSITION]);// 转场
  const persons = getTextValue(p[F.PERSONS]);      // 人员（rollup 名称或条数）
  
  // 关联内容只做数量提示，避免跨库深查
  let relatedCount = '';
  const relProp = p[F.RELATION_CONTENT];
  if (relProp?.type === 'relation' && Array.isArray(relProp.relation)) {
    relatedCount = `关联内容：${relProp.relation.length} 项`;
  }

  // 结构化正向提示：主描述 + 其余标签化信息
  // 注意：尽量用“中性可迁移”的词汇，避免强绑具体字体或水印
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

  // 最后附上风格与质量基准，利于统一画面调性
  lines.push('风格：写实高清，主体明确，构图简洁，光线自然，社媒短视频友好');

  const positive = lines.join('；');
  const negative = '低清晰度, 畸变, 过曝, 过暗, 杂乱, 噪点, 文字水印, 画面扭曲';

  return { prompt: positive, negativePrompt: negative };
}
