import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUD_TEST_TITLE = "云端测试环境·独立数据副本｜鱼房管理系统";
const marker = `<!-- fishroom-cloud-test-marker -->
<meta name="robots" content="noindex,nofollow,noarchive">
<style id="fishroom-cloud-test-style">
body::after{content:"云端测试环境 · 操作不影响正式系统";position:fixed;inset:auto 0 0;z-index:2147483647;display:block;height:18px;line-height:18px;text-align:center;font:11px/18px system-ui,sans-serif;background:#fff0c2;color:#533d00;border-top:1px solid #d9bc64;pointer-events:none;white-space:nowrap}
body{padding-bottom:18px!important}
.mobile-maintenance-dialog .mm-dialog-footer{padding-bottom:calc(1rem + env(safe-area-inset-bottom) + 18px)!important}
.mobile-maintenance-dialog .mm-dialog-body{scroll-padding-bottom:24px}
@media print{body::after{position:fixed;color:#000;background:#fff;border-top:1px solid #000}}
</style>
<!-- /fishroom-cloud-test-marker -->`;

export function markCloudTestHtml(html) {
  if (!/<head\b[^>]*>/i.test(html)) throw new Error("Built frontend is missing its HTML head");
  let result = html.replace(/<!-- fishroom-cloud-test-marker -->[\s\S]*?<!-- \/fishroom-cloud-test-marker -->\s*/g, "");
  const title = `<title>${CLOUD_TEST_TITLE}</title>`;
  result = /<title\b[^>]*>[\s\S]*?<\/title>/i.test(result)
    ? result.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, title)
    : result.replace(/<head\b[^>]*>/i, match => `${match}\n${title}`);
  return result.replace(/<\/head>/i, `${marker}\n</head>`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error("Pass the cloud-test built index.html path");
  await writeFile(path, markCloudTestHtml(await readFile(path, "utf8")));
}
