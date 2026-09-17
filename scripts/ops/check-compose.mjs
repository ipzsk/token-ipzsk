// 部署前核对**服务器上的** compose.yaml：部署脚本不同步 compose（服务器那份多了 lanehub 服务与 R2 配置，盲目覆盖会把它们抹掉），
// 所以只检查网关这次需要的键在不在，缺了就中止并说明缺什么。无 YAML 依赖：按缩进切出 gateway 服务块再逐项匹配。
//   node scripts/ops/check-compose.mjs <compose.yaml>
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const MIN_MEM_MB = 768;
// [说明, 检查函数(块文本) → 是否满足]
const has = (key) => (block) => new RegExp(`(^|[\\s"'-])${key}\\s*[:=]`, 'm').test(block);
export const REQUIRED = [
  [`mem_limit ≥ ${MIN_MEM_MB}m（ffmpeg 缩略图与 node 同一 cgroup，8192² 最坏 ~390MB）`, (b) => {
    const m = /^\s*mem_limit:\s*["']?(\d+(?:\.\d+)?)\s*([kmg]?)b?["']?\s*$/im.exec(b);
    if (!m) return false;
    const mb = Number(m[1]) * { '': 1 / 1048576, k: 1 / 1024, m: 1, g: 1024 }[m[2].toLowerCase()]; // 裸数字按字节
    return mb >= MIN_MEM_MB;
  }],
  ['R2_CONFIG_FILE（R2 素材/归档/缩略图；缺了整条媒体链路关闭）', has('R2_CONFIG_FILE')],
  ['LANEHUB_BASE_URL', has('LANEHUB_BASE_URL')],
  ['LANEHUB_ADMIN_TOKEN_FILE 或 LANEHUB_ADMIN_TOKEN', (b) => has('LANEHUB_ADMIN_TOKEN_FILE')(b) || has('LANEHUB_ADMIN_TOKEN')(b)],
  ['LANEHUB_ACCOUNT_ID', has('LANEHUB_ACCOUNT_ID')],
  ['LANEHUB_USD_CNY（插件分成对账）', has('LANEHUB_USD_CNY')],
  ['build: .（用本仓库 Dockerfile 构建，镜像里才有 ffmpeg/ffprobe）', (b) => /^\s*build:\s*\S/m.test(b)],
];

/** 切出 services.gateway 块（去掉注释行与行尾注释），找不到返回 null。 */
export function gatewayBlock(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s{2,}gateway:\s*(#.*)?$/.test(l));
  if (start < 0) return null;
  const indent = lines[start].search(/\S/), out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.search(/\S/) <= indent) break;
    if (/^\s*#/.test(line)) continue;
    out.push(line.replace(/\s+#.*$/, ''));
  }
  return out.join('\n');
}

export function checkCompose(text) {
  const block = gatewayBlock(text);
  if (block === null) return ['services.gateway 服务块'];
  return REQUIRED.filter(([, ok]) => !ok(block)).map(([label]) => label);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) { console.error('用法：node scripts/ops/check-compose.mjs <compose.yaml>'); process.exit(2); }
  const missing = checkCompose(readFileSync(file, 'utf8'));
  if (missing.length) {
    console.error(`✖ 服务器 compose.yaml 的 gateway 服务缺少本次部署需要的配置：\n${missing.map((m) => '  - ' + m).join('\n')}\n` +
      '先在服务器上手工补齐（见 DEPLOYMENT.md「部署前 compose 核对」），不要用本仓库的 compose.yaml 覆盖。');
    process.exit(1);
  }
  console.log('✔ 服务器 compose.yaml 核对通过');
}
