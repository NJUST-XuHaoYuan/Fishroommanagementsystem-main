import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_TEST_TITLE = "本地测试环境·正式数据副本｜鱼房管理系统";

export function markLocalTestHtml(html) {
  if (!/<head\b[^>]*>/i.test(html)) throw new Error("Built frontend is missing its HTML head");
  const title = `<title>${LOCAL_TEST_TITLE}</title>`;
  return /<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)
    ? html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, title)
    : html.replace(/<head\b[^>]*>/i, match => `${match}\n${title}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error("Pass the local-test built index.html path");
  await writeFile(path, markLocalTestHtml(await readFile(path, "utf8")));
}
