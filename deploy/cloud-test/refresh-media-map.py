#!/usr/bin/env python3
"""Host-only: issue GET links for copied media, without giving the test app COS keys."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path('/home/ubuntu/fishroom-cloud-test/private/media')
SIGNER = r'''
const COS = require('cos-nodejs-sdk-v5');
const fs = require('fs');
const sources = JSON.parse(fs.readFileSync(0, 'utf8'));
const bucket = process.env.COS_BUCKET, region = process.env.COS_REGION;
const expectedHost = `${bucket}.cos.${region}.myqcloud.com`;
const prefix = String(process.env.COS_PREFIX || 'fishroom').replace(/^\/+|\/+$/g, '') + '/';
const client = new COS({SecretId:process.env.COS_SECRET_ID, SecretKey:process.env.COS_SECRET_KEY});
const generatedAt = new Date().toISOString(), expiresAt = Date.now() + 86400 * 1000;
(async () => {
 const entries = {};
 for (const source of sources) {
  let parsed; try { parsed = new URL(source); } catch { continue; }
  if (parsed.protocol !== 'https:' || parsed.host !== expectedHost || parsed.username || parsed.password || parsed.hash || /[\x00-\x20\\]/.test(source)) continue;
  let key; try { key = decodeURIComponent(parsed.pathname.slice(1)); } catch { continue; }
  if (!key.startsWith(prefix) || key.includes('..') || key.includes('\\') || /[\x00-\x1f]/.test(key)) continue;
  if (!/\.(?:jpe?g|png|webp|gif|heic|heif|avif|bmp|mp4|mov|m4v|webm|3gp)$/i.test(key)) continue;
  const url = await new Promise((resolve,reject) => client.getObjectUrl({Bucket:bucket,Region:region,Key:key,Sign:true,Method:'GET',Expires:86400,Protocol:'https:'},(err,data) => err ? reject(err) : resolve(typeof data === 'string' ? data : data.Url)));
  const signed = new URL(url);
  if (signed.protocol !== 'https:' || signed.host !== parsed.host || signed.pathname !== parsed.pathname) continue;
  entries[source] = {url,expiresAt};
 }
 process.stdout.write(JSON.stringify({generatedAt,entries}));
})().catch(() => { process.stderr.write('Media signing failed\n'); process.exit(1); });
'''


def collect_urls(value, result):
    if isinstance(value, str) and value.startswith('https://') and '.cos.' in value:
        result.add(value)
    elif isinstance(value, list):
        for item in value:
            collect_urls(item, result)
    elif isinstance(value, dict):
        for item in value.values():
            collect_urls(item, result)


def main():
    os.umask(0o077)
    raw = subprocess.check_output(['docker', 'exec', 'fishroom-cloud-test-database', 'psql',
                                  '-U', 'fishroom_test', '-d', 'fishroom_test', '-Atc',
                                  "SELECT data FROM app_state WHERE id='main'"])
    sources = set()
    collect_urls(json.loads(raw), sources)
    if len(sources) > 50000:
        raise RuntimeError('Unexpected media reference count')
    output = subprocess.check_output(['docker', 'exec', '-i', 'fishroom-backend', 'node', '-e', SIGNER],
                                     input=json.dumps(sorted(sources)).encode())
    mapping = json.loads(output)
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=ROOT, prefix='.media-', delete=False) as handle:
        temporary = Path(handle.name)
        handle.write(output)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, ROOT / 'media-map.json')
    print(json.dumps({'ok': True, 'signedMediaCount': len(mapping['entries']), 'validHours': 24}))


if __name__ == '__main__':
    main()
