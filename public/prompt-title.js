const MAX_TITLE_GRAPHEMES = 64;

const ENGLISH_ACTION = '(?:add|analyze|build|change|configure|create|debug|delete|deploy|design|explain|fix|implement|improve|integrate|investigate|migrate|optimize|refactor|remove|rename|review|set up|simplify|summarize|support|test|update|write)';
const THAI_ACTION = '(?:เพิ่ม|วิเคราะห์|สร้าง|ทำ|เปลี่ยน|ตั้งค่า|อธิบาย|แก้ไข|แก้|ตรวจสอบ|ตรวจ|ทดสอบ|ออกแบบ|เขียน|ปรับปรุง|เชื่อม|ย้าย|ลบ|รีแฟกเตอร์|รีวิว|รองรับ|สรุป|หา)';
const ACTION_AT_START = new RegExp(`^(?:${ENGLISH_ACTION}\\b|${THAI_ACTION})`, 'iu');
const SECONDARY_TASK = new RegExp(
  `(?:,\\s*|\\s+)(?:and|then|also)\\s+(?=${ENGLISH_ACTION}\\b)|(?:\\s*[,;]\\s*)?(?:และ|แล้ว|พร้อมทั้ง|รวมทั้ง)(?=${THAI_ACTION})`,
  'iu',
);

const REQUEST_PREFIXES = [
  /^(?:(?:can|could|would|will)\s+you(?:\s+please)?|please|kindly|(?:i|we)(?:'d| would) like (?:you )?to|(?:i|we) (?:want|need) (?:you )?to|help (?:me|us)(?:\s+to)?|let(?:'s| us))\s+/iu,
  /^(?:(?:ช่วย|รบกวน|กรุณา|โปรด)(?:ผม|ฉัน|เรา)?(?:ช่วย)?|(?:ผม|ฉัน|เรา)?(?:อยาก|ต้องการ)(?:จะ)?ให้(?:ช่วย)?|(?:ผม|ฉัน|เรา)?ขอให้(?:ช่วย)?|ขอ(?:ให้)?(?:ช่วย)?)\s*/u,
];

function stripPromptDecoration(value) {
  return String(value ?? '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .trim();
}

function stripLineDecoration(value) {
  let result = value.trim();
  let previous;
  do {
    previous = result;
    result = result
      .replace(/^\s*[>$❯›»]+\s*/u, '')
      .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/u, '')
      .trim();
  } while (result !== previous);
  return result;
}

function stripRequestPrefix(value) {
  let result = value;
  let previous;
  do {
    previous = result;
    for (const pattern of REQUEST_PREFIXES) result = result.replace(pattern, '');
    result = result.trim();
  } while (result !== previous);
  return result;
}

function stripPoliteness(value) {
  return value
    .replace(/(?:,?\s+(?:please|thanks|thank you))$/iu, '')
    .replace(/(?:\s*(?:ให้)?หน่อย|\s*ด้วย)(?:นะ)?(?:ครับ|ค่ะ|คะ)?$/u, '')
    .replace(/\s*(?:นะ)?(?:ครับ|ค่ะ|คะ)$/u, '')
    .trim();
}

function taskCandidate(clause) {
  const undecorated = stripLineDecoration(clause);
  const stripped = stripRequestPrefix(undecorated);
  return {
    title: stripped,
    looksLikeTask: stripped !== undecorated || ACTION_AT_START.test(stripped),
  };
}

function splitClauses(value) {
  return value
    .split(/\n+|[.!?。！？]+(?:\s+|$)/u)
    .map((clause) => clause.replace(/\s+/gu, ' ').trim())
    .filter(Boolean);
}

function distillPrimaryTask(value) {
  const clauses = splitClauses(value);
  if (!clauses.length) return '';

  const candidates = clauses.map(taskCandidate);
  let title = (candidates.find((candidate) => candidate.looksLikeTask) || candidates[0]).title;

  const contextBoundary = title.search(/\s+(?:when|whenever|because|so that|while|after|before)\s+|(?:เมื่อ|เพราะ|เพื่อให้|หลังจาก|ก่อนที่|ระหว่างที่)/iu);
  if (contextBoundary > 0) title = title.slice(0, contextBoundary);

  const secondaryTaskBoundary = title.search(SECONDARY_TASK);
  if (secondaryTaskBoundary > 0) title = title.slice(0, secondaryTaskBoundary);

  return stripPoliteness(title)
    .replace(/[\s,;:–—-]+$/u, '')
    .replace(/^([a-z])/u, (letter) => letter.toUpperCase())
    .trim();
}

function graphemes(value) {
  if (globalThis.Intl?.Segmenter) {
    return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)]
      .map((segment) => segment.segment);
  }
  return Array.from(value);
}

function truncateTitle(value) {
  const segments = graphemes(value);
  if (segments.length <= MAX_TITLE_GRAPHEMES) return value;

  const prefix = segments.slice(0, MAX_TITLE_GRAPHEMES - 1).join('');
  const lastSpace = prefix.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(prefix.length * 0.6) ? prefix.slice(0, lastSpace) : prefix;
  return `${cut.trimEnd()}…`;
}

export function derivePromptTitle(value) {
  return truncateTitle(distillPrimaryTask(stripPromptDecoration(value)));
}
