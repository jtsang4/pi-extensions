#!/usr/bin/env node
// lark-monitor 存储脚本：config.yaml 与 threads-map.json 的唯一读写入口。
// 仅用 Node 标准库，无第三方依赖。
//
// 用法：
//   node store.mjs config get
//   node store.mjs config set <chat_id>
//   node store.mjs map get-session <session_id>
//   node store.mjs map find-thread <thread_id>
//   node store.mjs map set <session_id> <thread_id> --agent <pi|claude|codex|...> [--chat-id <oc_xxx>]
//   node store.mjs map gc
//
// 输出约定：查询命中时把结果写到 stdout（config get 输出纯 chat_id，map 查询输出单行 JSON）；
// 未命中时 stdout 为空。所有命令成功 exit 0，用法错误 exit 2。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 测试可用 LARK_MONITOR_HOME 指到临时目录，避免污染真实数据。
const DIR = process.env.LARK_MONITOR_HOME || path.join(os.homedir(), '.lark-monitor');
const CONFIG_PATH = path.join(DIR, 'config.yaml');
const MAP_PATH = path.join(DIR, 'threads-map.json');

const MAX_MAP_BYTES = 2 * 1024 * 1024; // threads-map.json 超过 2MB 时触发 GC
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // GC 清理两周未更新的条目

function readConfigChatId() {
  let text;
  try {
    text = fs.readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    return null;
  }
  const m = text.match(/^chat_id:\s*(\S+)\s*$/m);
  return m ? m[1] : null;
}

function writeConfigChatId(chatId) {
  writeFileAtomic(CONFIG_PATH, `chat_id: ${chatId}\n`);
}

function readMap() {
  try {
    const data = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeMap(map) {
  writeFileAtomic(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

// 文件超过阈值时，删除两周未更新的条目。返回清理后的 map。
function gcIfNeeded(map) {
  let size = 0;
  try {
    size = fs.statSync(MAP_PATH).size;
  } catch {
    return map;
  }
  if (size <= MAX_MAP_BYTES) return map;
  const cutoff = Date.now() - MAX_AGE_MS;
  const kept = {};
  let removed = 0;
  for (const [sid, entry] of Object.entries(map)) {
    const ts = Date.parse(entry?.updated_at || entry?.created_at || '');
    if (Number.isFinite(ts) && ts < cutoff) {
      removed += 1;
    } else {
      kept[sid] = entry;
    }
  }
  if (removed > 0) {
    process.stderr.write(`[store] threads-map.json 超过 ${MAX_MAP_BYTES} 字节，已清理 ${removed} 条两周前的映射\n`);
  }
  return kept;
}

function usage() {
  process.stderr.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(2, 14).join('\n') + '\n');
  process.exit(2);
}

const [, , area, cmd, ...args] = process.argv;
const now = () => new Date().toISOString();

if (area === 'config') {
  if (cmd === 'get') {
    const chatId = readConfigChatId();
    if (chatId) process.stdout.write(chatId + '\n');
  } else if (cmd === 'set' && args[0]) {
    writeConfigChatId(args[0]);
  } else {
    usage();
  }
} else if (area === 'map') {
  if (cmd === 'get-session' && args[0]) {
    const entry = readMap()[args[0]];
    if (entry) process.stdout.write(JSON.stringify(entry) + '\n');
  } else if (cmd === 'find-thread' && args[0]) {
    for (const [sessionId, entry] of Object.entries(readMap())) {
      if (entry?.thread_id === args[0]) {
        process.stdout.write(JSON.stringify({ session_id: sessionId, ...entry }) + '\n');
        break;
      }
    }
  } else if (cmd === 'set' && args[0] && args[1]) {
    const [sessionId, threadId] = args;
    let agent = '';
    let chatId = '';
    for (let i = 2; i < args.length; i += 1) {
      if (args[i] === '--agent') agent = args[++i] || '';
      else if (args[i] === '--chat-id') chatId = args[++i] || '';
    }
    const map = gcIfNeeded(readMap());
    const prev = map[sessionId] || {};
    map[sessionId] = {
      thread_id: threadId,
      chat_id: chatId || prev.chat_id || '',
      agent: agent || prev.agent || '',
      created_at: prev.created_at || now(),
      updated_at: now(),
    };
    writeMap(map);
  } else if (cmd === 'gc') {
    const before = Object.keys(readMap()).length;
    const map = gcIfNeeded(readMap());
    writeMap(map);
    process.stderr.write(`[store] gc 完成：${before} -> ${Object.keys(map).length} 条\n`);
  } else {
    usage();
  }
} else {
  usage();
}
